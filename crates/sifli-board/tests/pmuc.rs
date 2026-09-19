use pebble_sifli_board::{FaultKind, pmuc::PmucClock, startup_io::StartupIo};

#[test]
fn rc32_readiness_depends_on_elapsed_reference_time() {
    let mut clock = PmucClock::default();
    assert_eq!(clock.read(0x500c_a01c), Ok(6 << 6));
    clock.write(0x500c_a01c, (6 << 6) | 1).unwrap();
    assert!(!clock.lrc32_ready());
    clock.advance(47_999);
    assert!(!clock.lrc32_ready());
    assert_eq!(
        clock.write(0x500c_a000, 1),
        Err(FaultKind::PeripheralNotReady)
    );
    clock.advance(1);
    assert!(clock.lrc32_ready());
    assert_eq!(clock.read(0x500c_a01c), Ok((1 << 31) | (6 << 6) | 1));
    clock.write(0x500c_a000, 1).unwrap();
    assert_eq!(clock.low_power_hz(), 32_000);
}

#[test]
fn disabling_rc32_clears_readiness_and_unknown_pmuc_controls_fail() {
    let mut clock = PmucClock::default();
    clock.write(0x500c_a01c, 1).unwrap();
    clock.advance(48_000);
    assert!(clock.lrc32_ready());
    clock.write(0x500c_a01c, 0).unwrap();
    assert!(!clock.lrc32_ready());
    assert_eq!(clock.write(0x500c_a000, 2), Err(FaultKind::UnmodeledMmio));
    clock.write(0x500c_a004, 2).unwrap();
    assert_eq!(clock.read(0x500c_a004), Ok(2));
    assert_eq!(
        clock.write(0x500c_a004, 1 << 6),
        Err(FaultKind::UnmodeledMmio)
    );
    let hxt = clock.read(0x500c_a068).unwrap();
    clock.write(0x500c_a068, hxt | (1 << 5)).unwrap();
    assert_eq!(clock.read(0x500c_a068), Ok(hxt | (1 << 5)));
    assert_eq!(
        clock.write(0x500c_a068, hxt ^ 1),
        Err(FaultKind::UnmodeledMmio)
    );
}

#[test]
fn global_timer_tracks_the_selected_nominal_low_power_clock() {
    let mut io = StartupIo::default();
    io.write(0x4004_0004, 4, 1 << 31).unwrap();
    io.write(0x500c_0004, 4, 1 << 31).unwrap();
    io.write(0x500c_0034, 4, 1).unwrap();
    io.advance(48_000);
    assert_eq!(io.read(0x500c_0034, 4), Ok(10));
    io.write(0x500c_a01c, 4, (6 << 6) | 1).unwrap();
    io.advance(48_000);
    io.write(0x500c_a000, 4, 1).unwrap();
    io.advance(48_000);
    assert_eq!(io.read(0x500c_0034, 4), Ok(52));
}
