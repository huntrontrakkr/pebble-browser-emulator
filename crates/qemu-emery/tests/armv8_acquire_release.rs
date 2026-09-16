//! Encodings independently checked with LLVM's Cortex-M33 assembler.
//! See atomic-vectors.s / atomic-encodings.txt in the research evidence.
use emulator_qemu::{PebbleBus, boot};
use rp2350_emu::{CortexM33, core::CoreBus};
const ADDRESS: u32 = 0x20000100;
fn fixture(instructions: &[u16]) -> (CortexM33, PebbleBus) {
    let mut code = vec![0; 0x100];
    code[..4].copy_from_slice(&0x20080000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    for word in instructions {
        code.extend_from_slice(&word.to_le_bytes());
    }
    let (mut cpu, mut bus) = boot(code);
    cpu.regs.r[3] = ADDRESS;
    cpu.regs.r[1] = 42;
    bus.write32(ADDRESS, 0x12345678, 0);
    (cpu, bus)
}
#[test]
fn acquire_loads_and_release_stores_obey_width() {
    for (encoding, mask) in [(0x2f8f, 0xff), (0x2f9f, 0xffff), (0x2faf, u32::MAX)] {
        let (mut c, mut b) = fixture(&[0xe8d3, encoding, 0xe8c3, encoding]);
        c.step(&mut b);
        assert_eq!(c.regs.r[2], 0x12345678 & mask);
        c.regs.r[2] = 0xa1b2c3d4;
        c.step(&mut b);
        assert_eq!(
            b.read32(ADDRESS, 0),
            (0x12345678 & !mask) | (0xa1b2c3d4 & mask)
        );
        assert_eq!(c.regs.r[1], 42, "nonexclusive release has no status output");
        assert!(b.failed.is_none());
    }
}
#[test]
fn acquire_exclusive_release_exclusive_success_then_failure() {
    for (load, store, mask) in [
        (0x2fcf, 0x2fc1, 0xff),
        (0x2fdf, 0x2fd1, 0xffff),
        (0x2fef, 0x2fe1, u32::MAX),
    ] {
        let (mut c, mut b) = fixture(&[0xe8d3, load, 0xe8c3, store, 0xe8c3, store]);
        c.step(&mut b);
        assert_eq!(c.regs.r[2], 0x12345678 & mask);
        c.regs.r[2] = 0xa1b2c3d4;
        c.step(&mut b);
        assert_eq!(c.regs.r[1], 0);
        assert_eq!(
            b.read32(ADDRESS, 0),
            (0x12345678 & !mask) | (0xa1b2c3d4 & mask)
        );
        c.regs.r[2] = 0;
        c.step(&mut b);
        assert_eq!(c.regs.r[1], 1, "successful STLEX clears monitor");
        assert_eq!(
            b.read32(ADDRESS, 0),
            (0x12345678 & !mask) | (0xa1b2c3d4 & mask)
        );
        assert!(b.failed.is_none());
    }
}
#[test]
fn clrex_cancels_acquire_exclusive() {
    for (load, store) in [(0x2fcf, 0x2fc1), (0x2fdf, 0x2fd1), (0x2fef, 0x2fe1)] {
        let (mut c, mut b) = fixture(&[0xe8d3, load, 0xf3bf, 0x8f2f, 0xe8c3, store]);
        c.step(&mut b);
        c.step(&mut b);
        c.regs.r[2] = 0;
        c.step(&mut b);
        assert_eq!(c.regs.r[1], 1);
        assert_eq!(b.read32(ADDRESS, 0), 0x12345678);
        assert!(b.failed.is_none());
    }
}
#[test]
fn changed_address_fails_release_exclusive() {
    let (mut c, mut b) = fixture(&[0xe8d3, 0x2fef, 0xe8c3, 0x2fe1]);
    c.step(&mut b);
    c.regs.r[3] += 4;
    c.step(&mut b);
    assert_eq!(c.regs.r[1], 1);
    assert_eq!(b.read32(ADDRESS + 4, 0), 0);
}
#[test]
fn firmware_mixed_ldrexh_stlexh_loop_can_terminate() {
    // Actual firmware __sys_event_service_cleanup sequence.
    let (mut c, mut b) = fixture(&[0xe8d3, 0x2f5f, 0xe8c3, 0x2fd1]);
    c.step(&mut b);
    c.regs.r[2] = 9;
    c.step(&mut b);
    assert_eq!(
        c.regs.r[1], 0,
        "unpatched0.2.6 silently leaves status42 and loops"
    );
    assert_eq!(b.read16(ADDRESS, 0), 9);
    assert_eq!(
        b.read16(ADDRESS + 2, 0),
        0x1234,
        "must not execute STRD fallback"
    );
}
