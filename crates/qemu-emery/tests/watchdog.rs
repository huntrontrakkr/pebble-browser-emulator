use emulator_qemu::{
    board_step, board_step_before, boot_profile, checkpoint, profile::BoardProfile,
    watchdog::Watchdog,
};
use rp2350_emu::core::CoreBus;

const BASE: u32 = 0x40013000;
const REASON: u32 = 0x40007014;

fn machine() -> (rp2350_emu::CortexM33, emulator_qemu::PebbleBus) {
    let mut code = vec![0; 4 * 1024 * 1024];
    code[..4].copy_from_slice(&0x20080000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    code[0x100..0x104].copy_from_slice(&[0x30, 0xbf, 0xfd, 0xe7]); // WFI; branch to WFI
    boot_profile(code, BoardProfile::EMERY)
}

#[test]
fn reference_countdown_reload_feed_and_disable() {
    // Independent expectations from QEMU's cmsdk-apb-watchdog qtest, scaled
    // to Pebble's REFCLK (one microsecond = 64 board ticks).
    let mut w = Watchdog::default();
    assert_eq!(w.read(0), u32::MAX);
    w.advance(10000);
    assert_eq!(w.read(4), u32::MAX);
    w.write(8, 1, 10000);
    w.write(0, 1000, 10000);
    w.advance(10000 + 500 * 64 + 1);
    assert_eq!(w.read(4), 500);
    assert!(!w.raw);
    w.advance(10000 + 1000 * 64 + 1);
    assert_eq!(w.read(4), 0);
    assert_eq!(w.read(0x14), 1);
    w.advance(10000 + 1001 * 64 + 1);
    assert_eq!(w.read(4), 1000);
    w.advance(10000 + 1501 * 64 + 1);
    assert_eq!(w.read(4), 500);
    w.write(0xc, 0, 10000 + 1501 * 64 + 1); // any value feeds
    assert_eq!(w.read(4), 1000);
    assert!(!w.raw);
    w.advance(10000 + 1751 * 64 + 2);
    w.write(8, 0, 10000 + 1751 * 64 + 2);
    assert_eq!(w.read(4), 750);
    w.advance(1_000_000);
    assert_eq!(w.read(4), 750);
    w.write(8, 1, 1_000_000);
    assert_eq!(w.read(4), 1000);
}

#[test]
fn reference_readback_at_exact_clock_edges() {
    let mut w = Watchdog::default();
    w.write(0, 1000, 0);
    w.write(8, 1, 0);
    w.advance(500 * 64);
    assert_eq!(w.read(4), 501); // QEMU NO_COUNTER_ROUND_DOWN
    w.advance(500 * 64 + 1);
    assert_eq!(w.read(4), 500);
    w.advance(1000 * 64);
    assert_eq!(w.read(4), 0);
    w.advance(1001 * 64);
    assert_eq!(w.read(4), 0); // zero lasts through the reload boundary
    w.advance(1001 * 64 + 1);
    assert_eq!(w.read(4), 1000);
}

#[test]
fn lock_readonly_ids_and_zero_load_do_not_fake_a_timer() {
    let mut w = Watchdog::default();
    w.write(0xc00, 0, 0);
    w.write(0, 2, 0);
    w.write(8, 3, 0);
    assert_eq!(w.read(0), u32::MAX);
    assert_eq!(w.read(8), 0);
    w.write(0xc00, 0x1acce551, 0);
    assert_eq!(w.read(0xc00), 0);
    w.write(4, 7, 0); // read-only counter
    assert_eq!(w.read(4), u32::MAX);
    assert_eq!(w.read(0xfe0), 0x24);
    assert_eq!(w.read(0xffc), 0xb1);
    w.write(0, 0, 0);
    w.write(8, 3, 0);
    w.advance(1_000_000);
    assert!(!w.raw && !w.reset_requested());
    assert!(!w.running);
}

#[test]
fn second_expiry_stops_counter_and_reset_latch_survives_feed() {
    let mut w = Watchdog::default();
    w.write(0, 2, 0);
    w.write(8, 1, 0);
    w.advance(128);
    assert!(w.interrupt());
    assert!(!w.reset_requested());
    w.advance(319);
    assert!(!w.reset);
    w.advance(320); // 2 decrements, one reload clock, 2 decrements
    assert!(w.reset && !w.running);
    assert!(!w.reset_requested()); // RESEN still off
    w.write(0xc, 0, 320);
    assert!(!w.raw && w.reset);
    w.write(8, 3, 320);
    assert!(w.reset_requested());
}

#[test]
fn integration_mode_overrides_outputs_without_changing_raw_status() {
    let mut w = Watchdog::default();
    w.write(0xf04, 3, 0);
    assert!(!w.interrupt() && !w.reset_requested());
    w.write(0xf00, 1, 0);
    assert!(w.interrupt() && w.reset_requested());
    assert_eq!(w.read(0x10), 0);
    assert_eq!(w.read(0x14), 0);
    w.write(0xf00, 0, 0);
    assert!(!w.interrupt() && !w.reset_requested());
}

#[test]
fn watchdog_resets_sleeping_board_and_latches_cause_without_nvic_irq() {
    let (mut cpu, mut bus) = machine();
    assert_eq!(bus.read32(REASON, 0), 1);
    bus.write32(REASON, 1, 0);
    bus.ram[42] = 73;
    bus.flash[10] = 91;
    bus.devices.backup[4] = 123;
    bus.write32(BASE, 10, 0);
    bus.write32(BASE + 8, 3, 0);
    board_step_before(&mut cpu, &mut bus, 639);
    assert_eq!(bus.devices.ticks, 639);
    board_step_before(&mut cpu, &mut bus, 640);
    assert_eq!(bus.read32(BASE + 0x10, 0), 1);
    assert_eq!(bus.devices.irq_mask(), 0);
    assert!(cpu.is_halted());
    board_step_before(&mut cpu, &mut bus, 1344);
    board_step_before(&mut cpu, &mut bus, 1344);
    assert_eq!(bus.devices.ticks, 1344);
    assert_eq!(cpu.regs.pc(), 0x100);
    assert_eq!(bus.read32(REASON, 0), 4);
    assert_eq!(bus.read32(BASE + 8, 0), 0);
    assert_eq!(bus.ram[42], 73);
    assert_eq!(bus.flash[10], 91);
    assert_eq!(bus.devices.backup[4], 123);
    assert_eq!(bus.devices.watchdog, Watchdog::default());
    bus.write32(REASON, 2, 0);
    assert_eq!(bus.read32(REASON, 0), 4);
    bus.write32(REASON, 4, 0);
    assert_eq!(bus.read32(REASON, 0), 0);
}

#[test]
fn keyed_software_reset_accumulates_reason_and_honors_watchdog_line() {
    let (mut cpu, mut bus) = machine();
    cpu.ppb.aircr = 4; // invalid key must not reset
    board_step_before(&mut cpu, &mut bus, 1);
    assert_ne!(cpu.regs.pc(), 0x100);
    cpu.ppb.aircr = 0x05fa0004;
    board_step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.pc(), 0x100);
    assert_eq!(bus.read32(REASON, 0), 3); // uncleared POR | SOFT
    bus.write32(BASE + 0xf04, 2, 0);
    bus.write32(BASE + 0xf00, 1, 0);
    cpu.ppb.aircr = 0x05fa0004;
    board_step(&mut cpu, &mut bus);
    assert_eq!(bus.read32(REASON, 0), 7); // asserted timeout line -> WDOG
}

#[test]
fn guest_aircr_store_requests_reset_through_the_cpu_bus() {
    let (mut cpu, mut bus) = machine();
    for (i, opcode) in [0x4802u16, 0x4903, 0x6001, 0xe7fe].iter().enumerate() {
        bus.code[0x100 + i * 2..0x102 + i * 2].copy_from_slice(&opcode.to_le_bytes());
    }
    bus.code[0x10c..0x110].copy_from_slice(&0xe000ed0cu32.to_le_bytes());
    bus.code[0x110..0x114].copy_from_slice(&0x05fa0004u32.to_le_bytes());
    for _ in 0..3 {
        board_step(&mut cpu, &mut bus);
    }
    assert_eq!(cpu.regs.pc(), 0x100);
    assert_eq!(bus.devices.reset_reason, 3);
    assert_eq!(cpu.ppb.aircr, 0);
}

#[test]
fn watchdog_supports_qemu_byte_lanes_without_read_modify_write() {
    let (_, mut bus) = machine();
    bus.write16(BASE, 1000, 0);
    assert_eq!(bus.read16(BASE, 0), 1000);
    assert_eq!(bus.read8(BASE + 1, 0), 3);
    bus.write8(BASE + 1, 2, 0);
    assert_eq!(bus.read32(BASE, 0), 512); // zero-pad, don't preserve low byte
    assert!(bus.failed.is_none());
}

#[test]
fn checkpoint_restores_watchdog_phase_then_same_reset() {
    let (mut cpu, mut bus) = machine();
    bus.write32(BASE, 1000, 0);
    bus.write32(BASE + 8, 3, 0);
    board_step_before(&mut cpu, &mut bus, 64017);
    assert!(bus.devices.watchdog.raw);
    let bytes = checkpoint::encode(&cpu, &bus);
    let (mut restored_cpu, mut restored_bus) =
        checkpoint::decode(&bytes, BoardProfile::EMERY).unwrap();
    assert_eq!(checkpoint::encode(&restored_cpu, &restored_bus), bytes);
    for _ in 0..5 {
        board_step(&mut cpu, &mut bus);
        board_step(&mut restored_cpu, &mut restored_bus);
        assert_eq!(
            checkpoint::encode(&cpu, &bus),
            checkpoint::encode(&restored_cpu, &restored_bus)
        );
    }
    assert_eq!(bus.devices.reset_reason, 5);
}

#[test]
fn malformed_or_old_watchdog_checkpoints_are_rejected() {
    let (cpu, mut bus) = machine();
    let mut bytes = checkpoint::encode(&cpu, &bus);
    bytes[b"PEBBLE-QEMU-STATE".len()] = 2;
    assert!(checkpoint::decode(&bytes, BoardProfile::EMERY).is_err());
    bus.devices.watchdog.running = true;
    assert!(checkpoint::decode(&checkpoint::encode(&cpu, &bus), BoardProfile::EMERY).is_err());
    bus.devices.watchdog = Watchdog::default();
    bus.devices.reset_reason = 8;
    assert!(checkpoint::decode(&checkpoint::encode(&cpu, &bus), BoardProfile::EMERY).is_err());
}
