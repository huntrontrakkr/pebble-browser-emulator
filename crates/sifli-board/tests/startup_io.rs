use pebble_sifli_board::{FaultKind, startup_io::StartupIo};

#[test]
fn backup_por_and_writes_are_bounded_to_documented_registers() {
    let mut io = StartupIo::default();
    for n in 0..10 {
        let address = 0x500cb030 + n * 4;
        assert_eq!(io.read(address, 4), Ok(0));
        io.write(address, 4, 0x1234abcd + n).unwrap();
        assert_eq!(io.read(address, 4), Ok(0x1234abcd + n));
    }
    assert!(!StartupIo::owns(0x500cb058));
    assert_eq!(io.read(0x500cb031, 4), Err(FaultKind::InvalidWidth));
    assert_eq!(io.write(0x500cb030, 1, 0), Err(FaultKind::InvalidWidth));
    assert_eq!(io.read(0x500cb030, 4), Ok(0x1234abcd));
}

#[test]
fn enable_set_clear_controls_pinmux_access_without_inventing_clock_readiness() {
    let mut io = StartupIo::default();
    assert_eq!(io.read(0x50000008, 4), Ok(0x18c7fc17));
    assert_eq!(io.read(0x50003088, 4), Ok(0x2d0));
    io.write(0x50003088, 4, 0x2c0).unwrap();
    io.write(0x50000018, 4, 4).unwrap();
    assert_eq!(io.read(0x50003088, 4), Err(FaultKind::UnmodeledMmio));
    io.write(0x50000010, 4, 4).unwrap();
    assert_eq!(io.read(0x50003088, 4), Ok(0x2c0));
    assert_eq!(io.read(0x50000020, 4), Ok(0x1000));
    assert_eq!(
        io.write(0x50000020, 4, 0x1001),
        Err(FaultKind::UnmodeledMmio)
    );
    assert!(StartupIo::owns(0x500c0010));
    io.clock.advance(48_000);
    io.write(0x50000020, 4, 0x1001).unwrap();
    assert_eq!(io.read(0x50000020, 4), Ok(0x1001));
}
