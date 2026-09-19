use pebble_sifli_board::{FaultKind, watchdog::Watchdog};

#[test]
fn watchdog_start_stop_and_status_follow_command_bytes() {
    let mut watchdog = Watchdog::default();
    assert_eq!(watchdog.read(0x5009_4014), Ok(0));
    watchdog.write(0x5009_400c, 0x76).unwrap();
    assert!(watchdog.active());
    assert_eq!(watchdog.read(0x5009_4014), Ok(2));
    assert_eq!(watchdog.read(0x5009_401c), Ok(8));
    watchdog.write(0x5009_400c, 0x34).unwrap();
    assert!(!watchdog.active());
    assert_eq!((watchdog.starts, watchdog.stops), (1, 1));
    watchdog.write(0x5009_401c, 4).unwrap();
    assert_eq!(watchdog.read(0x5009_401c), Ok(0));
}

#[test]
fn watchdog_configuration_and_write_protection_are_bounded() {
    let mut watchdog = Watchdog::default();
    assert_eq!(watchdog.read(0x5009_4000), Ok(0x00ff_ffff));
    assert_eq!(watchdog.read(0x5009_4008), Ok(0x10));
    watchdog.write(0x5009_4000, 320_000).unwrap();
    watchdog.write(0x5009_4008, 0).unwrap();
    watchdog.write(0x5009_4018, 0x58ab_99fc).unwrap();
    assert_eq!(watchdog.read(0x5009_4018), Ok(1 << 31));
    assert_eq!(
        watchdog.write(0x5009_400c, 0x76),
        Err(FaultKind::PeripheralNotReady)
    );
    watchdog.write(0x5009_4018, 0x51ff_8621).unwrap();
    assert_eq!(
        watchdog.write(0x5009_400c, 0),
        Err(FaultKind::UnmodeledMmio)
    );
    assert_eq!(
        watchdog.write(0x5009_4000, 1 << 24),
        Err(FaultKind::UnmodeledMmio)
    );
}
