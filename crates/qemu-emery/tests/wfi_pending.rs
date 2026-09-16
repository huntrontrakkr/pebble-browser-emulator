use emulator_qemu::{board_step, boot};
use std::sync::atomic::Ordering::Relaxed;
fn image(wide: bool) -> Vec<u8> {
    let mut out = vec![0; 512];
    out[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    out[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    for n in [2, 14, 15, 16, 17] {
        out[n * 4..n * 4 + 4].copy_from_slice(&0x181u32.to_le_bytes());
    }
    let ops = if wide {
        vec![0xf3af, 0x8003, 0x3401, 0xe7fe]
    } else {
        vec![0xbf30, 0x3401, 0xe7fe]
    };
    for (i, op) in ops.iter().enumerate() {
        out[0x100 + i * 2..0x102 + i * 2].copy_from_slice(&u16::to_le_bytes(*op));
    }
    out[0x180..0x184].copy_from_slice(&[0x01, 0x35, 0x70, 0x47]);
    out
}
#[test]
fn already_latched_nvic_irq_wakes_wfi_with_primask() {
    for wide in [false, true] {
        let (mut c, mut b) = boot(image(wide));
        c.regs.primask = 1;
        c.ppb.nvic_iser[0].store(1, Relaxed);
        c.ppb.nvic_ispr[0].store(1, Relaxed);
        board_step(&mut c, &mut b);
        assert!(
            !c.is_halted(),
            "WFI must act as NOP for eligible pending IRQ despite PRIMASK"
        );
        assert!(
            b.devices.ticks < 100,
            "already-pending wake must not fast-forward time"
        );
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.r[4], 1);
        assert_eq!(c.regs.ipsr(), 0);
        assert_eq!(c.regs.r[5], 0);
    }
}
#[test]
fn raw_irq_merged_by_step_remains_a_wfi_wakeup() {
    let (mut c, mut b) = boot(image(false));
    c.regs.primask = 1;
    c.ppb.nvic_iser[0].store(1, Relaxed);
    b.atomics.assert_irq(0, 0);
    board_step(&mut c, &mut b);
    assert!(!c.is_halted());
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], 1);
    assert_eq!(c.ppb.nvic_ispr[0].load(Relaxed) & 1, 1);
}
#[test]
fn sleeping_wfi_wakes_from_latched_irq_without_delivery_when_primask_set() {
    let (mut c, mut b) = boot(image(false));
    c.regs.primask = 1;
    c.ppb.nvic_iser[0].store(1, Relaxed);
    board_step(&mut c, &mut b);
    assert!(c.is_halted());
    c.ppb.nvic_ispr[0].store(1, Relaxed);
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], 1);
    assert!(!c.is_halted());
    assert_eq!(c.regs.ipsr(), 0);
}
#[test]
fn basepri_still_blocks_wfi_wake() {
    let (mut c, mut b) = boot(image(false));
    c.regs.primask = 1;
    c.regs.basepri = 0xbf;
    c.ppb.nvic_ipr[0] = 0xe0;
    c.ppb.nvic_iser[0].store(1, Relaxed);
    c.ppb.nvic_ispr[0].store(1, Relaxed);
    for _ in 0..3 {
        board_step(&mut c, &mut b);
    }
    assert!(c.is_halted());
    assert_eq!(c.regs.r[4], 0);
    c.regs.basepri = 0;
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], 1);
    assert_eq!(c.regs.r[5], 0);
}
#[test]
fn masked_system_exception_does_not_spuriously_wake() {
    for bit in [26, 28] {
        let (mut c, mut b) = boot(image(false));
        c.regs.basepri = 0xbf;
        c.ppb.shpr[10] = 0xe0;
        c.ppb.shpr[11] = 0xe0;
        c.ppb.icsr |= 1 << bit;
        for _ in 0..3 {
            board_step(&mut c, &mut b);
        }
        assert!(c.is_halted());
        assert_eq!(c.regs.r[4], 0);
        c.regs.basepri = 0;
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.ipsr(), if bit == 26 { 15 } else { 14 });
    }
}
#[test]
fn systick_wakes_wfi_despite_primask_without_delivering() {
    let (mut c, mut b) = boot(image(false));
    c.regs.primask = 1;
    board_step(&mut c, &mut b);
    assert!(c.is_halted());
    c.ppb.pend_systick();
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.r[4], 1);
    assert_eq!(c.regs.ipsr(), 0);
    assert_eq!(c.regs.r[5], 0);
}
#[test]
fn faultmask_blocks_irq_but_not_nmi_wakeup() {
    let (mut c, mut b) = boot(image(false));
    c.regs.faultmask = 1;
    c.ppb.nvic_iser[0].store(1, Relaxed);
    b.atomics.assert_irq(0, 0);
    for _ in 0..3 {
        board_step(&mut c, &mut b);
    }
    assert!(c.is_halted());
    assert_eq!(c.regs.r[4], 0);
    c.ppb.icsr |= 1 << 31;
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.ipsr(), 2);
    assert!(!c.is_halted());
}
#[test]
fn disabled_irq_does_not_wake_wfi() {
    let (mut c, mut b) = boot(image(false));
    b.atomics.assert_irq(0, 0);
    for _ in 0..3 {
        board_step(&mut c, &mut b);
    }
    assert!(c.is_halted());
    assert_eq!(c.regs.r[4], 0);
}
#[test]
fn current_handler_priority_blocks_lower_priority_wakeup() {
    let (mut c, mut b) = boot(image(false));
    c.regs.xpsr |= 15;
    c.ppb.shpr[11] = 0x80;
    c.ppb.nvic_ipr[0] = 0x40a0;
    c.ppb.nvic_iser[0].store(3, Relaxed);
    c.ppb.nvic_ispr[0].store(1, Relaxed);
    for _ in 0..3 {
        board_step(&mut c, &mut b);
    }
    assert!(c.is_halted());
    assert_eq!(c.regs.r[4], 0);
    c.ppb.nvic_ispr[0].store(3, Relaxed);
    board_step(&mut c, &mut b);
    assert_eq!(c.regs.ipsr(), 17);
    assert!(!c.is_halted());
}
#[test]
fn sev_does_not_wake_wfi() {
    let (mut c, mut b) = boot(image(false));
    board_step(&mut c, &mut b);
    b.atomics.sev_both();
    for _ in 0..3 {
        board_step(&mut c, &mut b);
    }
    assert!(c.is_halted());
    assert_eq!(c.regs.r[4], 0);
    assert!(b.atomics.event_flag_load(0));
}
