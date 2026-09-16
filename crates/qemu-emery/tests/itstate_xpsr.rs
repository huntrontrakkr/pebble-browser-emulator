use emulator_qemu::boot;
use rp2350_emu::core::CoreBus;
fn fixture() -> (rp2350_emu::CortexM33, emulator_qemu::PebbleBus) {
    let mut code = vec![0; 0x204];
    code[0..4].copy_from_slice(&0x20080000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    code[14 * 4..15 * 4].copy_from_slice(&0x201u32.to_le_bytes());
    // CMP r0,#0; ITT NE; MOVNE r4,#11; MOVNE r5,#22; NOP.
    for (i, word) in [0x2800u16, 0xbf1c, 0x240b, 0x2516, 0xbf00]
        .iter()
        .enumerate()
    {
        code[0x100 + i * 2..0x102 + i * 2].copy_from_slice(&word.to_le_bytes());
    }
    code[0x200..0x202].copy_from_slice(&0x4770u16.to_le_bytes()); // BX LR
    let (mut cpu, bus) = boot(code);
    cpu.regs.r[0] = 1;
    (cpu, bus)
}
#[test]
fn interrupt_stacks_architectural_split_itstate() {
    let (mut c, mut b) = fixture();
    c.step(&mut b);
    c.step(&mut b);
    c.ppb.icsr |= 1 << 28;
    c.step(&mut b);
    assert_eq!(c.regs.ipsr(), 14);
    let xpsr = b.read32(c.regs.r[13] + 28, 0);
    assert_eq!(
        xpsr & 0x0600_fc00,
        0x0000_1c00,
        "IT[1:0] belongs at xPSR[26:25], IT[7:2] at [15:10]"
    );
}
#[test]
fn exception_return_decodes_independent_architectural_itstate() {
    let (mut c, mut b) = fixture();
    c.step(&mut b);
    c.step(&mut b);
    c.ppb.icsr |= 1 << 28;
    c.step(&mut b);
    let addr = c.regs.r[13] + 28;
    let saved = b.read32(addr, 0);
    b.write32(addr, (saved & !0x0600_fc00) | 0x1c00, 0);
    c.step(&mut b);
    assert_eq!(c.regs.ipsr(), 0);
    c.step(&mut b);
    c.step(&mut b);
    assert_eq!(
        (c.regs.r[4], c.regs.r[5]),
        (11, 22),
        "both remaining NE instructions must execute"
    );
}
