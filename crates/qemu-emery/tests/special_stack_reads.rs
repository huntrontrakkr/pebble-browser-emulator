use emulator_qemu::{board_step, boot};
fn image(sysm: u16) -> Vec<u8> {
    let mut out = vec![0; 256];
    out[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    out[4..8].copy_from_slice(&0x41u32.to_le_bytes());
    for (i, op) in [0xb084u16, 0xf3ef, 0x8400 | sysm, 0xe7fe]
        .iter()
        .enumerate()
    {
        out[0x40 + i * 2..0x42 + i * 2].copy_from_slice(&op.to_le_bytes());
    }
    out
}
#[test]
fn mrs_msp_reads_current_active_stack() {
    let (mut c, mut b) = boot(image(8));
    board_step(&mut c, &mut b);
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], c.regs.r[13]);
    assert_eq!(c.regs.r[4], 0x20000ff0);
}
#[test]
fn mrs_psp_reads_current_active_stack() {
    let (mut c, mut b) = boot(image(9));
    c.regs.control = 2;
    c.regs.psp = 0x20002000;
    c.regs.r[13] = 0x20002000;
    board_step(&mut c, &mut b);
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], c.regs.r[13]);
    assert_eq!(c.regs.r[4], 0x20001ff0);
}
#[test]
fn mrs_msp_in_psp_thread_reads_inactive_bank() {
    let (mut c, mut b) = boot(image(8));
    c.regs.control = 2;
    c.regs.psp = 0x20002000;
    c.regs.r[13] = 0x20002000;
    board_step(&mut c, &mut b);
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], 0x20001000);
}
