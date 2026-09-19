use pebble_sifli_board::{FaultKind, lpsys_clock::LpsysClock};

#[test]
fn startup_can_select_hxt48_for_low_power_peripherals() {
    let mut clock = LpsysClock::default();
    assert_eq!(clock.read(0x4000_0010), Ok(0));
    assert!(!clock.peripheral_uses_hxt48());

    clock.write(0x4000_0010, 1 << 4).unwrap();
    assert!(clock.peripheral_uses_hxt48());
    assert_eq!(clock.peripheral_source_changes, 1);
}

#[test]
fn unsupported_clock_source_changes_remain_visible() {
    let mut clock = LpsysClock::default();
    assert_eq!(clock.write(0x4000_0010, 1), Err(FaultKind::UnmodeledMmio));
    assert_eq!(
        clock.write(0x4000_0010, 1 << 12),
        Err(FaultKind::UnmodeledMmio)
    );
}
