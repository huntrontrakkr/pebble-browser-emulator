//! The generic Flint profile identifies as a Cortex-M4 (CPUID 0x410fc240), an
//! Armv7E-M part with no Security Extension and FPv4-SP. The shared engine
//! implements Armv8-M and FPv5, so those encodings must raise
//! UsageFault.UNDEFINSTR on Flint while continuing to execute on the Armv8-M
//! Emery and Gabbro profiles.
//!
//! Expected behavior follows the Armv7-M and Armv8-M architecture manuals, not
//! a native-QEMU capture. Unchanged qemu_flint 4.37.0 executes none of these
//! encodings; its only Armv8-M dependency is MSR MSPLIM/PSPLIM, covered below.
use emulator_qemu::{PebbleBus, boot_profile, profile::BoardProfile};
use rp2350_emu::CortexM33;

const CODE: u32 = 0x100;
const HARDFAULT: u32 = 0x180;
const USAGEFAULT: u32 = 0x1c0;
const MSP_TOP: u32 = 0x2000_8000;

/// CFSR.UFSR.UNDEFINSTR (bit 16).
const UNDEFINSTR: u32 = 1 << 16;
/// SHCSR.USGFAULTENA, so UsageFault is taken rather than escalated.
const USGFAULTENA: u32 = 1 << 18;

struct Machine {
    cpu: CortexM33,
    bus: PebbleBus,
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
        put32(&mut image, 6 * 4, USAGEFAULT | 1);
        put16(&mut image, HARDFAULT, 0xe7fe); // b .
        put16(&mut image, USAGEFAULT, 0xe7fe); // b .
        for (i, halfword) in code.iter().enumerate() {
            put16(&mut image, CODE + 2 * i as u32, *halfword);
        }
        let (mut cpu, bus) = boot_profile(image, profile);
        cpu.ppb.shcsr |= USGFAULTENA;
        // Grant the FPU so an FP rejection is the profile's doing, not CPACR.
        cpu.ppb.cpacr |= 0b1111 << 20;
        Self { cpu, bus }
    }

    fn step(&mut self) {
        self.cpu.step(&mut self.bus);
    }

    /// True when the instruction raised UsageFault.UNDEFINSTR.
    fn took_undefinstr(&self) -> bool {
        self.cpu.regs.ipsr() == 6 && self.cpu.ppb.cfsr & UNDEFINSTR != 0
    }
}

fn armv8_profiles() -> [BoardProfile; 2] {
    [BoardProfile::EMERY, BoardProfile::GABBRO]
}

/// Every vector: rejected on Flint, and not rejected on Emery or Gabbro. The
/// Armv8-M side asserts only that the encoding is not UNDEFINED, since each
/// instruction's own behavior is covered elsewhere.
fn assert_armv8_m_only(name: &str, code: &[u16], prepare: impl Fn(&mut Machine)) {
    let mut flint = Machine::new(BoardProfile::FLINT, code);
    prepare(&mut flint);
    flint.step();
    assert!(
        flint.took_undefinstr(),
        "{name}: Flint must reject this Armv8-M encoding (ipsr {}, cfsr {:#x})",
        flint.cpu.regs.ipsr(),
        flint.cpu.ppb.cfsr,
    );

    for profile in armv8_profiles() {
        let mut m = Machine::new(profile, code);
        prepare(&mut m);
        m.step();
        assert!(
            !m.took_undefinstr(),
            "{name}: {} must still execute this encoding",
            profile.name,
        );
    }
}

#[test]
fn secure_gateway_is_armv8_m_only() {
    // SG — Armv8-M Security Extension.
    assert_armv8_m_only("SG", &[0xe97f, 0xe97f], |_| {});
}

#[test]
fn test_target_is_armv8_m_only() {
    // TT r1, r0 — Armv8-M Security Extension.
    assert_armv8_m_only("TT", &[0xe840, 0xf100], |m| {
        m.cpu.regs.r[0] = 0x2000_0000;
    });
}

#[test]
fn bxns_is_armv8_m_only() {
    // BXNS r1 — Armv8-M Security Extension. Encoded as the engine decodes it,
    // with the Non-Secure marker at bit 2 of the Thumb-16 BX encoding.
    assert_armv8_m_only("BXNS", &[0x470c, 0xe7fe], |m| {
        m.cpu.regs.r[1] = (CODE + 4) | 1;
    });
}

#[test]
fn acquire_release_loads_and_stores_are_armv8_m_only() {
    // LDA r1, [r0]; LDAB; LDAH; LDAEX; STL; STLEX — Armv8-M Main Extension.
    for (name, code) in [
        ("LDA", [0xe8d0u16, 0x1faf]),
        ("LDAB", [0xe8d0, 0x1f8f]),
        ("LDAH", [0xe8d0, 0x1f9f]),
        ("LDAEX", [0xe8d0, 0x1fef]),
        ("STL", [0xe8c0, 0x1faf]),
        ("STLEX", [0xe8c0, 0x1fe2]),
    ] {
        assert_armv8_m_only(name, &code, |m| {
            m.cpu.regs.r[0] = 0x2000_0100;
        });
    }
}

#[test]
fn vsel_and_vmaxnm_are_fpv5_only() {
    // The 0xFE data-processing family (VSEL, VMAXNM, VMINNM and the directed
    // rounding converts) is FPv5; Cortex-M4 carries FPv4-SP.
    for (name, code) in [
        ("VSEL", [0xfe00u16, 0x0a20]),
        ("VMAXNM", [0xfe80, 0x0a20]),
        ("VMINNM", [0xfe80, 0x0a60]),
    ] {
        assert_armv8_m_only(name, &code, |_| {});
    }
}

#[test]
fn vrint_is_fpv5_only() {
    // VRINTR, VRINTZ and VRINTX. FPv4-SP has no VRINT at all.
    for (name, code) in [
        ("VRINTR", [0xeeb6u16, 0x0a40]),
        ("VRINTZ", [0xeeb6, 0x0ac0]),
        ("VRINTX", [0xeeb7, 0x0a40]),
    ] {
        assert_armv8_m_only(name, &code, |_| {});
    }
}

/// MSR is a defined Armv7-M encoding, so a reserved SYSm is UNPREDICTABLE
/// rather than UNDEFINED. Flint discards the write instead of faulting, which
/// unchanged qemu_flint 4.37.0 startup depends on: it writes both limits.
#[test]
fn stack_limit_writes_are_discarded_on_flint_not_rejected() {
    // MSR MSPLIM, r0 ; MSR PSPLIM, r0
    let code = [0xf380u16, 0x880a, 0xf380, 0x880b];

    let mut flint = Machine::new(BoardProfile::FLINT, &code);
    flint.cpu.regs.r[0] = 0x2000_4000;
    flint.step();
    flint.step();
    assert!(
        !flint.took_undefinstr(),
        "Flint must not reject MSR with a reserved SYSm",
    );
    assert_eq!(flint.cpu.regs.ipsr(), 0, "Flint: no exception taken");
    assert_eq!(flint.cpu.regs.msplim, 0, "Flint: MSPLIM write discarded");
    assert_eq!(flint.cpu.regs.psplim, 0, "Flint: PSPLIM write discarded");

    for profile in armv8_profiles() {
        let mut m = Machine::new(profile, &code);
        m.cpu.regs.r[0] = 0x2000_4000;
        m.step();
        m.step();
        let name = profile.name;
        assert_eq!(m.cpu.regs.msplim, 0x2000_4000, "{name}: MSPLIM written");
        assert_eq!(m.cpu.regs.psplim, 0x2000_4000, "{name}: PSPLIM written");
    }
}

/// MRS from a reserved SYSm reads zero on Flint rather than this engine's
/// Armv8-M register, and does not fault.
#[test]
fn stack_limit_reads_are_zero_on_flint() {
    // MRS r1, MSPLIM
    let code = [0xf3efu16, 0x810a];

    let mut flint = Machine::new(BoardProfile::FLINT, &code);
    flint.cpu.regs.msplim = 0x2000_4000; // as an Armv8-M build would leave it
    flint.cpu.regs.r[1] = 0xdead_beef;
    flint.step();
    assert!(!flint.took_undefinstr(), "Flint must not reject the MRS");
    assert_eq!(flint.cpu.regs.r[1], 0, "Flint: reserved SYSm reads zero");

    for profile in armv8_profiles() {
        let mut m = Machine::new(profile, &code);
        m.cpu.regs.msplim = 0x2000_4000;
        m.step();
        assert_eq!(m.cpu.regs.r[1], 0x2000_4000, "{}", profile.name);
    }
}
