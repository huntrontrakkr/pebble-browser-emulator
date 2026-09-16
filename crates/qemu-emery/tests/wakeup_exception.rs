//! Original instruction-level regressions: no firmware/SDK files required.
use emulator_qemu::{PebbleBus, board_step, boot};
use rp2350_emu::CortexM33;
use std::sync::atomic::Ordering::Relaxed;

fn image(main: &[u16], handler: &[u16]) -> Vec<u8> {
    let mut code = vec![0; 512];
    code[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    for n in [2, 14, 15, 16] {
        code[n * 4..n * 4 + 4].copy_from_slice(&0x181u32.to_le_bytes());
    }
    for (offset, ops) in [(0x100, main), (0x180, handler)] {
        for (i, op) in ops.iter().enumerate() {
            code[offset + i * 2..offset + i * 2 + 2].copy_from_slice(&op.to_le_bytes());
        }
    }
    code
}
fn steps(cpu: &mut CortexM33, bus: &mut PebbleBus, n: usize) {
    for _ in 0..n {
        board_step(cpu, bus);
    }
}
fn assert_return(handler: &[u16], use_psp: bool) {
    let (mut cpu, mut bus) = boot(image(&[0xbf30, 0x3401, 0xe7fe], handler));
    if use_psp {
        cpu.regs.control = 2;
        cpu.regs.psp = 0x20002000;
        cpu.regs.r[13] = 0x20002000;
    }
    board_step(&mut cpu, &mut bus);
    assert!(cpu.is_halted());
    cpu.ppb.pend_systick();
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(bus.failed, None);
    assert_eq!(cpu.regs.r[4], 1, "main must resume exactly once");
    assert_eq!(cpu.regs.pc(), 0x104);
    assert_eq!(cpu.regs.ipsr(), 0);
    assert_eq!(cpu.regs.msp, 0x20001000, "handler SP must be restored");
    assert_eq!(
        cpu.regs.r[13],
        if use_psp { 0x20002000 } else { 0x20001000 }
    );
}
#[test]
fn pop16_exception_return() {
    assert_return(&[0xb510, 0xbf00, 0xbd10], false);
}
#[test]
fn pop32_exception_return_msp() {
    assert_return(&[0xe92d, 0x4010, 0xbf00, 0xe8bd, 0x8010], false);
}
#[test]
fn pop32_exception_return_psp() {
    assert_return(&[0xe92d, 0x4010, 0xbf00, 0xe8bd, 0x8010], true);
}
#[test]
fn ldr_pc_postindexed_exception_return_msp() {
    assert_return(&[0xf84d, 0xed04, 0xbf00, 0xf85d, 0xfb04], false);
}
#[test]
fn ldr_pc_postindexed_exception_return_psp() {
    assert_return(&[0xf84d, 0xed04, 0xbf00, 0xf85d, 0xfb04], true);
}

fn sleeping() -> (CortexM33, PebbleBus) {
    let (mut cpu, mut bus) = boot(image(
        &[0xbf20, 0x3401, 0xbf20, 0x3401, 0xe7fe],
        &[0x3501, 0x4770],
    ));
    board_step(&mut cpu, &mut bus);
    assert!(cpu.is_wfe_waiting());
    (cpu, bus)
}
#[test]
fn wfe_external_event_is_consumed_once() {
    let (mut cpu, mut bus) = sleeping();
    bus.atomics.sev_both();
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 1);
    assert!(cpu.is_wfe_waiting());
    assert!(!bus.atomics.event_flag_load(0));
    bus.atomics.sev_both();
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 2);
    assert_eq!(cpu.regs.pc(), 0x108);
}
#[test]
fn wfe_consumes_event_already_pending_at_instruction() {
    let (mut cpu, mut bus) = boot(image(&[0xbf20, 0x3401, 0xe7fe], &[0x4770]));
    bus.atomics.sev_both();
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 1);
    assert!(!cpu.is_wfe_waiting());
    assert!(!bus.atomics.event_flag_load(0));
}
#[test]
fn wfe_resumes_for_systick() {
    let (mut cpu, mut bus) = sleeping();
    cpu.ppb.pend_systick();
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 1);
    assert!(cpu.is_wfe_waiting());
}
#[test]
fn wfe_resumes_for_enabled_external_irq() {
    let (mut cpu, mut bus) = sleeping();
    cpu.ppb.nvic_iser[0].store(1, Relaxed);
    bus.atomics.assert_irq(0, 0);
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 1);
    assert!(cpu.is_wfe_waiting());
}
#[test]
fn wfe_stays_asleep_for_masked_interrupt_without_sevonpend() {
    let (mut cpu, mut bus) = sleeping();
    cpu.regs.primask = 1;
    cpu.ppb.pend_systick();
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 0);
    assert!(cpu.is_wfe_waiting());
    cpu.regs.primask = 0;
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 1);
}
#[test]
fn wfe_stays_asleep_for_disabled_external_irq_without_sevonpend() {
    let (mut cpu, mut bus) = sleeping();
    bus.atomics.assert_irq(0, 0);
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 0);
    assert!(cpu.is_wfe_waiting());
}
#[test]
fn sevonpend_wakes_once_for_masked_systick_transition() {
    let (mut cpu, mut bus) = sleeping();
    cpu.regs.primask = 1;
    cpu.ppb.scr |= 1 << 4;
    cpu.ppb.pend_systick();
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 0);
    assert!(cpu.is_wfe_waiting());
    assert!(!bus.atomics.event_flag_load(0));
}
#[test]
fn sevonpend_wakes_for_disabled_irq_and_a_new_transition() {
    let (mut cpu, mut bus) = sleeping();
    cpu.ppb.scr |= 1 << 4;
    bus.atomics.assert_irq(0, 0);
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 0);
    assert!(cpu.is_wfe_waiting());
    cpu.ppb.nvic_ispr[0].store(0, Relaxed);
    bus.atomics.clear_irq(0, 0);
    board_step(&mut cpu, &mut bus);
    bus.atomics.assert_irq(0, 0);
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 2);
}
#[test]
fn wfe_resumes_for_unmasked_higher_priority_only() {
    let (mut cpu, mut bus) = sleeping();
    cpu.regs.basepri = 0xa0;
    cpu.ppb.shpr[11] = 0xc0;
    cpu.ppb.pend_systick();
    steps(&mut cpu, &mut bus, 8);
    assert_eq!(cpu.regs.r[4], 0);
    assert!(cpu.is_wfe_waiting());
    cpu.ppb.shpr[11] = 0x80;
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 1);
}
#[test]
fn wfe_resumes_for_nmi_despite_masks() {
    let (mut cpu, mut bus) = sleeping();
    cpu.regs.faultmask = 1;
    cpu.regs.primask = 1;
    cpu.ppb.icsr |= 1 << 31;
    steps(&mut cpu, &mut bus, 12);
    assert_eq!(cpu.regs.r[4], 1);
    assert_eq!(cpu.regs.r[5], 1);
}
#[test]
fn wfe_clock_advance_delivers_systick() {
    let (mut cpu, mut bus) = sleeping();
    cpu.ppb.syst_rvr = 100;
    cpu.ppb.syst_csr = 7;
    steps(&mut cpu, &mut bus, 40);
    assert_eq!(cpu.regs.r[4], 2);
    assert!(cpu.regs.r[5] >= 2);
    assert!(bus.devices.ticks >= 200);
}
