use emulator_qemu::{board_step, boot};
fn image(ops: &[u16]) -> Vec<u8> {
    let mut out = vec![0; 512];
    out[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    out[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    out[60..64].copy_from_slice(&0x181u32.to_le_bytes());
    for (i, op) in ops.iter().enumerate() {
        out[0x100 + i * 2..0x102 + i * 2].copy_from_slice(&op.to_le_bytes());
    }
    out[0x180..0x184].copy_from_slice(&[0x01, 0x35, 0x70, 0x47]);
    out
}
#[test]
fn cps_i_selects_primask() {
    for (op, initial, expected) in [(0xb672, (0, 0), (1, 0)), (0xb662, (1, 1), (0, 1))] {
        let (mut c, mut b) = boot(image(&[op]));
        c.regs.primask = initial.0;
        c.regs.faultmask = initial.1;
        board_step(&mut c, &mut b);
        assert_eq!((c.regs.primask, c.regs.faultmask), expected);
    }
}
#[test]
fn cps_f_selects_faultmask() {
    for (op, initial, expected) in [(0xb671, (0, 0), (0, 1)), (0xb661, (1, 1), (1, 0))] {
        let (mut c, mut b) = boot(image(&[op]));
        c.regs.primask = initial.0;
        c.regs.faultmask = initial.1;
        board_step(&mut c, &mut b);
        assert_eq!((c.regs.primask, c.regs.faultmask), expected);
    }
}
#[test]
fn cps_if_changes_both_masks() {
    for (op, initial, expected) in [(0xb673, (0, 0), (1, 1)), (0xb663, (1, 1), (0, 0))] {
        let (mut c, mut b) = boot(image(&[op]));
        c.regs.primask = initial.0;
        c.regs.faultmask = initial.1;
        board_step(&mut c, &mut b);
        assert_eq!((c.regs.primask, c.regs.faultmask), expected);
    }
}
#[test]
fn firmware_cpsid_i_wfi_cpsie_i_sequence_wakes_then_delivers() {
    let (mut c, mut b) = boot(image(&[0xb672, 0xbf30, 0xb662, 0x3401, 0xe7fe]));
    board_step(&mut c, &mut b);
    c.ppb.pend_systick();
    board_step(&mut c, &mut b);
    assert!(!c.is_halted());
    assert_eq!(c.regs.ipsr(), 0);
    assert_eq!((c.regs.primask, c.regs.faultmask), (1, 0));
    for _ in 0..6 {
        board_step(&mut c, &mut b);
    }
    assert_eq!(c.regs.r[4], 1);
    assert_eq!(c.regs.r[5], 1);
    assert_eq!((c.regs.primask, c.regs.faultmask), (0, 0));
}
