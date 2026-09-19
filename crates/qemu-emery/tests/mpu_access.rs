use emulator_qemu::{boot_profile, profile::BoardProfile};

const RAM: u32 = 0x2000_0000;
const TARGET: u32 = RAM + 0x1000;

fn image(stack: u32) -> Vec<u8> {
    let mut bytes = vec![0; 0x124];
    bytes[0..4].copy_from_slice(&stack.to_le_bytes());
    bytes[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    bytes[16..20].copy_from_slice(&0x121u32.to_le_bytes());
    bytes[0x100..0x102].copy_from_slice(&0x6008u16.to_le_bytes()); // str r0, [r1]
    bytes[0x120..0x122].copy_from_slice(&0xe7feu16.to_le_bytes()); // MemManage handler
    bytes
}

fn assert_guard_fault(profile: BoardProfile, configure: impl FnOnce(&mut rp2350_emu::CortexM33)) {
    let (mut cpu, mut bus) = boot_profile(image(RAM + profile.ram_bytes as u32), profile);
    cpu.ppb.shcsr |= 1 << 16; // MEMFAULTENA
    cpu.ppb.mpu_ctrl = 1 << 2 | 1; // privileged default map + MPU enable
    configure(&mut cpu);
    cpu.regs.r[0] = 0x55aa_33cc;
    cpu.regs.r[1] = TARGET;

    cpu.step(&mut bus);

    assert_eq!(cpu.regs.ipsr(), 4, "the MPU violation enters MemManage");
    assert_eq!(cpu.ppb.cfsr & 0x82, 0x82, "DACCVIOL and MMARVALID latch");
    assert_eq!(cpu.ppb.mmfar, TARGET);
    assert_eq!(
        bus.ram[(TARGET - RAM) as usize],
        0,
        "the denied store is transactional"
    );
}

#[test]
fn armv8_m_readonly_guard_rejects_a_store_before_the_backing_bus() {
    assert_guard_fault(BoardProfile::EMERY, |cpu| {
        // PMSAv8 region 3, 32 bytes, privileged read-only, enabled.
        cpu.ppb.mpu_regions[3] = (TARGET | (2 << 1), TARGET | 1);
    });
}

#[test]
fn armv7_m_no_access_guard_rejects_a_store_before_the_backing_bus() {
    assert_guard_fault(BoardProfile::FLINT, |cpu| {
        // PMSAv7 region 6, 32 bytes, AP=000 (no access), enabled.
        cpu.ppb.mpu_regions[6] = (TARGET | 0x10 | 6, (4 << 1) | 1);
    });
}

#[test]
fn armv8_m_execute_never_region_faults_before_instruction_dispatch() {
    let profile = BoardProfile::EMERY;
    let (mut cpu, mut bus) = boot_profile(image(RAM + profile.ram_bytes as u32), profile);
    cpu.ppb.shcsr |= 1 << 16;
    cpu.ppb.mpu_ctrl = 1 << 2 | 1;
    // PMSAv8 region 2 covers code at 0x100, is privileged read-only and XN.
    cpu.ppb.mpu_regions[2] = (0x100 | (2 << 1) | 1, 0x100 | 1);

    cpu.step(&mut bus);

    assert_eq!(cpu.regs.ipsr(), 4);
    assert_eq!(cpu.ppb.cfsr & 0x83, 1, "only IACCVIOL latches");
    assert_eq!(cpu.ppb.mmfar, 0, "instruction faults do not set MMFARVALID");
}
