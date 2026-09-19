//! Precise MPU faults on the generic Flint (PMSAv7) and Emery/Gabbro (PMSAv8)
//! profiles. The expected values follow the Armv7-M/Armv8-M exception pseudocode
//! (ValidateAddress, PushStack, ExceptionReturn, PreserveFPState) and QEMU's
//! v7m stacking helpers. They are synthetic vectors, not native-QEMU captures.
use emulator_qemu::{PebbleBus, boot_profile, profile::BoardProfile};
use rp2350_emu::CortexM33;

const RAM: u32 = 0x2000_0000;

// Layout shared by every vector. Regions are 32-byte aligned and, for PMSAv7,
// naturally aligned to their power-of-two size.
const APP_STACK: u32 = RAM + 0x1000; // 4 KiB, any RW, execute-never
const GUARD: u32 = RAM + 0x0fe0; // 32 B, stores denied at every privilege level
const KERNEL: u32 = RAM + 0x4000; // 4 KiB, privileged RW only
const RO_TARGET: u32 = RAM + 0x6000; // 32 B, privileged read-only
const MAIN_STACK: u32 = RAM + 0x7000; // 4 KiB, any RW (MSP)
const MSP_TOP: u32 = MAIN_STACK + 0x1000;

const CODE: u32 = 0x100;
const HARDFAULT: u32 = 0x180;
const MEMMANAGE: u32 = 0x1a0;
const SYSTICK: u32 = 0x1c0;

// CFSR.MMFSR bits.
const IACCVIOL: u32 = 1 << 0;
const DACCVIOL: u32 = 1 << 1;
const MUNSTKERR: u32 = 1 << 3;
const MSTKERR: u32 = 1 << 4;
const MLSPERR: u32 = 1 << 5;
const MMARVALID: u32 = 1 << 7;

const MEMFAULTENA: u32 = 1 << 16;
const MEMFAULTPENDED: u32 = 1 << 13;
const PENDSTSET: u32 = 1 << 26;
const FPCCR_LSPACT: u32 = 1 << 0;

#[derive(Clone, Copy)]
enum Access {
    AnyRo,
    AnyRw,
    PrivRw,
    PrivRo,
    /// PMSAv7 has a no-access encoding; PMSAv8 always grants privileged
    /// reads, so a v8 guard is privileged read-only instead. Stores are
    /// denied at every privilege level in both cases.
    StoreGuard,
}

struct Machine {
    cpu: CortexM33,
    bus: PebbleBus,
    armv7: bool,
}

fn put16(image: &mut [u8], at: u32, value: u16) {
    image[at as usize..at as usize + 2].copy_from_slice(&value.to_le_bytes());
}

fn put32(image: &mut [u8], at: u32, value: u32) {
    image[at as usize..at as usize + 4].copy_from_slice(&value.to_le_bytes());
}

impl Machine {
    fn new(profile: BoardProfile, code: &[u16]) -> Self {
        let mut image = vec![0; 0x400];
        put32(&mut image, 0, MSP_TOP);
        put32(&mut image, 4, CODE | 1);
        put32(&mut image, 3 * 4, HARDFAULT | 1);
        put32(&mut image, 4 * 4, MEMMANAGE | 1);
        put32(&mut image, 15 * 4, SYSTICK | 1);
        put16(&mut image, HARDFAULT, 0xe7fe); // b .
        put16(&mut image, MEMMANAGE, 0xe7fe); // b .
        put16(&mut image, SYSTICK, 0x4770); // bx lr
        for (i, halfword) in code.iter().enumerate() {
            put16(&mut image, CODE + 2 * i as u32, *halfword);
        }
        let (mut cpu, bus) = boot_profile(image, profile);
        let armv7 = profile == BoardProfile::FLINT;
        cpu.ppb.shcsr |= MEMFAULTENA;
        cpu.ppb.mpu_ctrl = 0b101; // ENABLE + PRIVDEFENA, HFNMIENA clear
        let mut machine = Self { cpu, bus, armv7 };
        machine.region(0, 0, 0x400, Access::AnyRo, false);
        machine.region(1, APP_STACK, 0x1000, Access::AnyRw, true);
        machine.region(2, GUARD, 0x20, Access::StoreGuard, true);
        machine.region(3, KERNEL, 0x1000, Access::PrivRw, true);
        machine.region(4, RO_TARGET, 0x20, Access::PrivRo, true);
        machine.region(5, MAIN_STACK, 0x1000, Access::AnyRw, true);
        machine
    }

    fn region(&mut self, index: usize, base: u32, size: u32, access: Access, xn: bool) {
        assert!(size.is_power_of_two() && size >= 32 && base.is_multiple_of(size));
        self.cpu.ppb.mpu_regions[index] = if self.armv7 {
            let ap = match access {
                Access::AnyRo => 0b110,
                Access::AnyRw => 0b011,
                Access::PrivRw => 0b001,
                Access::PrivRo => 0b101,
                Access::StoreGuard => 0b000,
            };
            let size_field = size.trailing_zeros() - 1;
            (base, (xn as u32) << 28 | ap << 24 | size_field << 1 | 1)
        } else {
            let ap = match access {
                Access::AnyRo => 0b11,
                Access::AnyRw => 0b01,
                Access::PrivRw => 0b00,
                Access::PrivRo | Access::StoreGuard => 0b10,
            };
            (base | ap << 1 | xn as u32, (base + size - 1) & !0x1f | 1)
        };
    }

    /// Unprivileged Thread mode on the process stack.
    fn user_thread(&mut self, psp: u32) {
        self.cpu.regs.control = 0b11;
        self.cpu.regs.psp = psp;
        self.cpu.regs.r[13] = psp;
    }

    fn read32(&self, address: u32) -> u32 {
        let at = (address - RAM) as usize;
        u32::from_le_bytes(self.bus.ram[at..at + 4].try_into().unwrap())
    }

    fn write32(&mut self, address: u32, value: u32) {
        let at = (address - RAM) as usize;
        self.bus.ram[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn step(&mut self) {
        self.cpu.step(&mut self.bus);
    }

    fn mmfsr(&self) -> u32 {
        self.cpu.ppb.cfsr & 0xff
    }
}

fn profiles() -> [BoardProfile; 3] {
    [
        BoardProfile::FLINT,
        BoardProfile::EMERY,
        BoardProfile::GABBRO,
    ]
}

/// A PUSH that reaches a stack guard is abandoned at its first denied store:
/// SP and the stack above the guard are unchanged. The exception frame then
/// also meets the guard, which is a stacking error (MSTKERR, no address) on
/// the same MemManage exception rather than a second, nested MemManage.
#[test]
fn push_into_stack_guard_is_abandoned_and_stacking_error_is_not_redelivered() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xb4f0, 0xe7fe]); // push {r4-r7}; b .
        let sp = APP_STACK + 8; // two of the four stores land in the guard
        m.user_thread(sp);
        for (register, value) in [(4, 0x4444_4444), (5, 0x5555_5555), (6, 0x6666_6666)] {
            m.cpu.regs.r[register] = value;
        }
        m.cpu.regs.r[7] = 0x7777_7777;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}: MemManage entered");
        assert_eq!(m.cpu.regs.pc(), MEMMANAGE, "{name}");
        assert_eq!(m.mmfsr(), DACCVIOL | MMARVALID | MSTKERR, "{name}");
        assert_eq!(m.cpu.ppb.mmfar, APP_STACK - 8, "{name}: first denied store");
        assert_eq!(
            m.read32(APP_STACK),
            0,
            "{name}: later PUSH stores abandoned"
        );
        assert_eq!(
            m.read32(APP_STACK + 4),
            0,
            "{name}: later PUSH stores abandoned"
        );
        // PushStack lowers SP before storing, so the frame pointer is recorded
        // from the unchanged pre-PUSH SP even though no frame word was written.
        assert_eq!(m.cpu.regs.psp, sp - 0x20, "{name}");
        assert_eq!(m.cpu.regs.lr(), 0xffff_fffd, "{name}: Thread/PSP return");

        m.step(); // the handler's `b .`

        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        assert_eq!(m.cpu.regs.pc(), MEMMANAGE, "{name}");
        assert_eq!(
            m.cpu.regs.lr(),
            0xffff_fffd,
            "{name}: no nested MemManage from Handler mode"
        );
    }
}

/// A denied post-indexed load neither writes its destination nor its base.
#[test]
fn denied_load_leaves_destination_and_writeback_base_unchanged() {
    for profile in profiles() {
        // ldr.w r0, [r1], #4 ; b .
        let mut m = Machine::new(profile, &[0xf851, 0x0b04, 0xe7fe]);
        m.cpu.regs.control = 0b01; // unprivileged Thread on MSP
        m.cpu.regs.r[0] = 0x1111_1111;
        m.cpu.regs.r[1] = KERNEL + 0x40;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        assert_eq!(m.mmfsr(), DACCVIOL | MMARVALID, "{name}");
        assert_eq!(m.cpu.ppb.mmfar, KERNEL + 0x40, "{name}");
        assert_eq!(m.cpu.regs.r[0], 0x1111_1111, "{name}: destination kept");
        assert_eq!(m.cpu.regs.r[1], KERNEL + 0x40, "{name}: no base writeback");
        let frame = m.cpu.regs.msp;
        assert_eq!(m.read32(frame), 0x1111_1111, "{name}: stacked r0");
        assert_eq!(m.read32(frame + 4), KERNEL + 0x40, "{name}: stacked r1");
        assert_eq!(
            m.read32(frame + 24),
            CODE,
            "{name}: stacked PC retries the load"
        );
    }
}

/// MMFAR reports the first denied access of a multi-register load, and the
/// base register is not written back.
#[test]
fn load_multiple_reports_first_denied_address_without_writeback() {
    for profile in profiles() {
        // ldmia r1!, {r0, r2, r3} ; b .
        let mut m = Machine::new(profile, &[0xc90d, 0xe7fe]);
        m.cpu.regs.control = 0b01;
        // The last APP_STACK word is readable; the two words after it are in
        // no region, which an unprivileged access cannot use.
        let base = APP_STACK + 0x1000 - 4;
        m.write32(base, 0xaaaa_aaaa);
        m.cpu.regs.r[1] = base;
        m.cpu.regs.r[2] = 0x2222_2222;
        m.cpu.regs.r[3] = 0x3333_3333;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        assert_eq!(m.cpu.ppb.mmfar, base + 4, "{name}: first denied word");
        assert_eq!(m.cpu.regs.r[1], base, "{name}: no base writeback");
        assert_eq!(m.cpu.regs.r[2], 0x2222_2222, "{name}");
        assert_eq!(m.cpu.regs.r[3], 0x3333_3333, "{name}");
    }
}

/// A load abandoned inside an IT block keeps its own ITSTATE in the stacked
/// xPSR, so the retried instruction is still conditional on return.
#[test]
fn abandoned_load_in_it_block_stacks_its_own_it_state() {
    for profile in profiles() {
        // it eq ; ldreq r0, [r1] ; b .
        let mut m = Machine::new(profile, &[0xbf08, 0x6808, 0xe7fe]);
        m.cpu.regs.control = 0b01;
        m.cpu.regs.xpsr |= 1 << 30; // Z
        m.cpu.regs.r[1] = KERNEL;

        m.step(); // IT
        assert_eq!(m.cpu.it_state(), 0x08);
        m.step(); // LDREQ faults

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        let stacked_xpsr = m.read32(m.cpu.regs.msp + 28);
        assert_eq!(
            m.read32(m.cpu.regs.msp + 24),
            CODE + 2,
            "{name}: stacked PC"
        );
        assert_eq!(
            stacked_xpsr & 0x0600_fc00,
            0x08 << 8,
            "{name}: ITSTATE 0x08 is stacked for the faulting instruction"
        );
    }
}

/// A stacking error on interrupt entry is a derived MemManage. When it has
/// higher priority it is taken instead (late arrival) and the interrupt stays
/// pending; the stacking error does not record an address.
#[test]
fn stacking_error_on_interrupt_entry_takes_higher_priority_memmanage() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        let sp = APP_STACK + 8;
        m.user_thread(sp);
        m.cpu.ppb.shpr[11] = 0xe0; // SysTick lowest
        m.cpu.ppb.icsr |= PENDSTSET;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}: derived MemManage wins");
        assert_eq!(m.cpu.regs.pc(), MEMMANAGE, "{name}");
        assert_eq!(m.mmfsr(), MSTKERR, "{name}: no MMARVALID for stacking");
        assert_ne!(
            m.cpu.ppb.icsr & PENDSTSET,
            0,
            "{name}: SysTick still pending"
        );
        assert_eq!(m.cpu.regs.psp, sp - 0x20, "{name}");
    }
}

/// When the interrupted exception has higher priority than the derived
/// MemManage, the original handler runs first and MemManage remains pending
/// until it can be taken, here by tail-chaining from the handler's return.
#[test]
fn lower_priority_stacking_error_pends_memmanage_until_tail_chain() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        m.user_thread(APP_STACK + 8);
        m.cpu.ppb.shpr[0] = 0x20; // MemManage below
        m.cpu.ppb.shpr[11] = 0x00; // SysTick
        m.cpu.ppb.icsr |= PENDSTSET;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 15, "{name}: SysTick taken");
        assert_eq!(m.mmfsr(), MSTKERR, "{name}");
        assert_ne!(
            m.cpu.ppb.shcsr & MEMFAULTPENDED,
            0,
            "{name}: derived fault pends"
        );

        m.step(); // SysTick `bx lr` tail-chains into the pending MemManage

        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        assert_eq!(m.cpu.regs.pc(), MEMMANAGE, "{name}");
        assert_eq!(m.cpu.regs.lr(), 0xffff_fffd, "{name}: same frame");
        assert_eq!(
            m.cpu.ppb.shcsr & MEMFAULTPENDED,
            0,
            "{name}: pending cleared"
        );
    }
}

/// Unstacking uses the privilege of the mode being returned to. A frame an
/// unprivileged Thread cannot read produces MUNSTKERR and tail-chains to
/// MemManage with the frame, SP and Thread privilege left in place.
#[test]
fn unstacking_uses_return_privilege_and_tail_chains_on_error() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        let frame = KERNEL + 0x100;
        for (offset, value) in [(0, 1), (4, 2), (8, 3), (12, 4), (16, 12), (20, 0x55)] {
            m.write32(frame + offset, value);
        }
        m.write32(frame + 24, CODE);
        m.write32(frame + 28, 1 << 24);
        m.cpu.regs.xpsr = (m.cpu.regs.xpsr & !0x1ff) | 15; // in SysTick
        m.cpu.regs.control = 0b01; // Thread privilege to restore: unprivileged
        m.cpu.regs.psp = frame;
        m.cpu.regs.r[13] = MSP_TOP;
        m.cpu.regs.msp = MSP_TOP;
        m.cpu.regs.r[14] = 0xffff_fffd;
        m.cpu.regs.r[15] = SYSTICK; // bx lr
        m.cpu.regs.r[0] = 0x0bad_0bad;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}: tail-chained MemManage");
        assert_eq!(m.cpu.regs.pc(), MEMMANAGE, "{name}");
        assert_eq!(m.mmfsr(), MUNSTKERR, "{name}");
        assert_eq!(m.cpu.regs.lr(), 0xffff_fffd, "{name}: EXC_RETURN retained");
        assert_eq!(m.cpu.regs.psp, frame, "{name}: frame not popped");
        assert_eq!(
            m.cpu.regs.r[0], 0x0bad_0bad,
            "{name}: no partial unstacking"
        );
        assert_eq!(m.cpu.regs.control & 1, 1, "{name}: nPRIV unchanged");
    }
}

/// Vector table reads always use the default memory map.
#[test]
fn vector_read_ignores_mpu_regions() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        let table = KERNEL + 0x200; // unprivileged code cannot read it
        m.write32(table + 15 * 4, SYSTICK | 1);
        m.cpu.ppb.vtor = table;
        m.cpu.regs.control = 0b01; // unprivileged Thread on MSP
        m.cpu.ppb.icsr |= PENDSTSET;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 15, "{name}");
        assert_eq!(m.cpu.regs.pc(), SYSTICK, "{name}");
        assert_eq!(m.cpu.ppb.cfsr, 0, "{name}");
    }
}

/// With HFNMIENA clear, FAULTMASK (execution priority -1) uses the default map.
#[test]
fn faultmask_accesses_bypass_mpu_when_hfnmiena_is_clear() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0x6008, 0xe7fe]); // str r0, [r1]
        m.cpu.regs.faultmask = 1;
        m.cpu.regs.r[0] = 0x600d_f00d;
        m.cpu.regs.r[1] = RO_TARGET;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 0, "{name}");
        assert_eq!(m.cpu.ppb.cfsr, 0, "{name}");
        assert_eq!(m.read32(RO_TARGET), 0x600d_f00d, "{name}");
    }
}

/// A synchronous MemManage that cannot preempt the current priority escalates.
#[test]
fn memmanage_that_cannot_preempt_escalates_to_hardfault() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        // A privileged SysTick handler at the same priority as MemManage.
        m.cpu.regs.xpsr = (m.cpu.regs.xpsr & !0x1ff) | 15;
        m.cpu.ppb.shpr[11] = 0x00;
        m.cpu.regs.r[15] = CODE + 0x40;
        m.cpu.regs.r[0] = 1;
        m.cpu.regs.r[1] = RO_TARGET;
        let mut image_code = m.bus.code.clone();
        put16(&mut image_code, CODE + 0x40, 0x6008); // str r0, [r1]
        m.bus.code = image_code;

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 3, "{name}: escalated");
        assert_eq!(m.cpu.regs.pc(), HARDFAULT, "{name}");
        assert_ne!(m.cpu.ppb.hfsr & (1 << 30), 0, "{name}: FORCED");
        assert_eq!(m.mmfsr(), DACCVIOL | MMARVALID, "{name}");
    }
}

/// Privileged PPB accesses always use the default memory map.
#[test]
fn privileged_ppb_access_ignores_mpu_regions() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0x6808, 0xe7fe]); // ldr r0, [r1]
        m.cpu.ppb.mpu_ctrl = 1; // no privileged background map
        m.cpu.regs.r[1] = 0xe000_ed00; // CPUID

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.ppb.cfsr, 0, "{name}");
        assert_eq!(m.cpu.regs.r[0], profile.cpuid, "{name}");
    }
}

/// Instruction fetch faults are unchanged: IACCVIOL without an address.
#[test]
fn execute_never_fetch_still_reports_iaccviol_only() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        m.cpu.regs.control = 0b01;
        m.cpu.regs.r[15] = KERNEL; // privileged-only and execute-never

        m.step();

        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        assert_eq!(m.mmfsr(), IACCVIOL, "{name}");
        assert_eq!(m.read32(m.cpu.regs.msp + 24), KERNEL, "{name}: stacked PC");
    }
}

/// Lazy FP state preservation that meets a store-denied region reports
/// MLSPERR without an address. MemManage can preempt the handler, so the FP
/// instruction is abandoned and the lazy state remains active.
#[test]
fn lazy_fp_preservation_error_abandons_fp_instruction() {
    for profile in profiles() {
        let mut m = Machine::new(profile, &[0xe7fe]);
        // Thread SP such that the basic frame is writable and the FP extension
        // (the 72 bytes above it) falls in the store guard region.
        let sp = RAM + 0x2048;
        m.region(1, RAM + 0x1000, 0x1000, Access::AnyRw, true);
        m.region(2, RAM + 0x2000, 0x80, Access::StoreGuard, true);
        m.user_thread(sp);
        m.cpu.regs.control |= 1 << 2; // FPCA: Thread has live FP state
        m.cpu.ppb.shpr[11] = 0xe0;
        m.cpu.ppb.icsr |= PENDSTSET;
        let mut code = m.bus.code.clone();
        put16(&mut code, SYSTICK, 0xee00); // vmov s0, r0
        put16(&mut code, SYSTICK + 2, 0x0a10);
        m.bus.code = code;
        m.cpu.regs.s[0] = 2.5;
        m.cpu.regs.r[0] = 1.0f32.to_bits();

        m.step(); // SysTick entry with lazily reserved FP context
        let name = profile.name;
        assert_eq!(m.cpu.regs.ipsr(), 15, "{name}");
        assert_ne!(m.cpu.ppb.fpccr & FPCCR_LSPACT, 0, "{name}");
        assert_eq!(m.cpu.ppb.fpcar, sp - 0x68 + 0x20, "{name}");

        m.step(); // VMOV triggers lazy preservation

        assert_eq!(m.cpu.regs.ipsr(), 4, "{name}");
        assert_eq!(m.mmfsr(), MLSPERR, "{name}");
        assert_ne!(m.cpu.ppb.fpccr & FPCCR_LSPACT, 0, "{name}: still pending");
        assert_eq!(m.cpu.regs.s[0], 2.5, "{name}: FP instruction abandoned");
        assert_eq!(m.read32(m.cpu.regs.msp + 24), SYSTICK, "{name}: retry VMOV");
    }
}
