use emulator_qemu::{board_step, boot_profile, checkpoint, profile::BoardProfile, trace};
use rp2350_emu::core::CoreBus;

#[test]
fn observation_preserves_complete_state_and_continuation() {
    let mut code = vec![0; 4 * 1024 * 1024];
    code[..4].copy_from_slice(&0x20080000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    code[0x100..0x104].copy_from_slice(&[0x01, 0x30, 0xfd, 0xe7]);
    let (mut cpu, mut bus) = boot_profile(code, BoardProfile::EMERY);
    let initial = checkpoint::encode(&cpu, &bus);
    let (mut other_cpu, mut other_bus) = checkpoint::decode(&initial, BoardProfile::EMERY).unwrap();
    assert!(
        bus.trace
            .configure(trace::STEPS | trace::MMIO | trace::TRANSITIONS, 16)
    );
    for _ in 0..200 {
        board_step(&mut cpu, &mut bus);
        board_step(&mut other_cpu, &mut other_bus);
    }
    assert_eq!(bus.trace.dropped, 184);
    assert_eq!(bus.trace.export(), 16 * 40);
    assert_eq!(
        checkpoint::encode(&cpu, &bus),
        checkpoint::encode(&other_cpu, &other_bus)
    );
    let saved = checkpoint::encode(&cpu, &bus);
    let (_, restored_bus) = checkpoint::decode(&saved, BoardProfile::EMERY).unwrap();
    assert!(!restored_bus.trace.enabled(trace::STEPS));
    assert_eq!(restored_bus.trace.dropped, 0);
}

#[test]
fn mmio_reads_are_observed_once_without_repeating_side_effects() {
    let mut code = vec![0; 256];
    code[..4].copy_from_slice(&0x20080000u32.to_le_bytes());
    code[4..8].copy_from_slice(&9u32.to_le_bytes());
    let (_, mut bus) = boot_profile(code, BoardProfile::EMERY);
    assert!(bus.trace.configure(trace::MMIO, 4));
    bus.devices.receive_uart(1, &[7, 9]);
    bus.set_active_pc(0x100, 0);
    assert_eq!(bus.read32(0x40001000, 0), 7);
    assert_eq!(bus.devices.uart[1].rx.len(), 1);
    bus.write32(0x40001008, 3, 0);
    assert_eq!(bus.trace.export(), 80);
    // Reading the trace never calls a guest register read.
    assert_eq!(bus.trace.export(), 80);
    assert_eq!(bus.devices.uart[1].rx.len(), 1);
}
