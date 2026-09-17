use emulator_qemu::{board_step, boot};
use std::sync::atomic::Ordering::Relaxed;

#[test]
fn simultaneous_peripheral_lines_and_still_high_repending() {
    let mut code = vec![0; 512];
    code[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    code[0x100..0x102].copy_from_slice(&0xe7feu16.to_le_bytes());
    let (mut cpu, mut bus) = boot(code);
    cpu.ppb.syst_csr = 0;
    // IRQs stay disabled so the test observes peripheral latching independently
    // of handler priorities and exception-entry stack writes.
    cpu.ppb.nvic_iser[0].store(0, Relaxed);
    for selected in 0u32..512 {
        let expected = (selected & 255) | ((selected & 256) << 1);
        for i in 0..3 {
            bus.devices.uart[i].ctrl = 1;
            bus.devices.uart[i].pending = (expected >> i) & 1;
        }
        for i in 0..2 {
            bus.devices.timer[i].ctrl = 2;
            bus.devices.timer[i].pending = (expected >> (i + 3)) & 1;
        }
        bus.devices.rtc_ctrl = if expected & 32 != 0 { 3 } else { 0 };
        bus.devices.gpio_ctrl = 1;
        bus.devices.edges = (expected >> 6) & 1;
        bus.devices.display[8] = 1;
        bus.devices.display[7] = (expected >> 7) & 1;
        bus.devices.touch[4] = 1;
        bus.devices.touch[3] = (expected >> 9) & 1;
        bus.devices.irq_levels = 0;
        cpu.ppb.nvic_iabr[0].store(0, Relaxed);
        for _ in 0..2 {
            cpu.ppb.nvic_ispr[0].store(0, Relaxed);
            board_step(&mut cpu, &mut bus);
            assert_eq!(cpu.ppb.nvic_ispr[0].load(Relaxed), expected);
            assert_eq!(bus.failed, None);
        }
        // Still-high active lines should not be spuriously re-pended.
        cpu.ppb.nvic_ispr[0].store(0, Relaxed);
        cpu.ppb.nvic_iabr[0].store(expected, Relaxed);
        board_step(&mut cpu, &mut bus);
        assert_eq!(cpu.ppb.nvic_ispr[0].load(Relaxed), 0);
    }
}
