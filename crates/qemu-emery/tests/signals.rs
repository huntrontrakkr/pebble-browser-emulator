use emulator_qemu::{board_step_before, boot, peripherals::Devices, profile::BoardProfile};

#[test]
fn external_deadline_limits_sleep_without_fabricating_an_interrupt() {
    let mut image = vec![0; 0x104];
    image[..4].copy_from_slice(&0x2008_0000u32.to_le_bytes());
    image[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    image[0x100..0x102].copy_from_slice(&0xbf30u16.to_le_bytes()); // WFI
    let (mut cpu, mut bus) = boot(image);
    board_step_before(&mut cpu, &mut bus, 100);
    assert_eq!(bus.devices.ticks, 100);
    assert!(cpu.is_halted());
    assert_eq!(bus.devices.irq_mask(), 0);
    board_step_before(&mut cpu, &mut bus, 100);
    assert_eq!(bus.devices.ticks, 100);
    board_step_before(&mut cpu, &mut bus, 150);
    assert_eq!(bus.devices.ticks, 150);
}

#[test]
fn touch_coordinates_contact_edges_masking_and_w1c() {
    let mut d = Devices::default();
    assert!(d.set_touch(false, 30, 40));
    assert_eq!(d.touch[4], 0);
    assert!(d.set_touch(true, 30, 40));
    assert_eq!(d.touch, [1, 30, 40, 0, 1]);
    assert_eq!(d.irq_mask(), 0);
    d.write(0x4001100c, 1, &mut []);
    assert_eq!(d.irq_mask(), 1 << 9);
    d.write(0x40011010, 1, &mut []);
    assert_eq!(d.irq_mask(), 0);
    assert!(d.set_touch(true, 31, 40));
    assert_ne!(d.irq_mask(), 0);
    d.write(0x40011010, 1, &mut []);
    assert!(d.set_touch(false, 31, 40));
    assert_ne!(d.irq_mask(), 0);
    let before = d.touch;
    assert!(!d.set_touch(true, 200, 10));
    assert_eq!(d.touch, before);
    let mut flint = Devices::with_profile(BoardProfile::FLINT);
    assert!(!flint.set_touch(true, 10, 10));
}
