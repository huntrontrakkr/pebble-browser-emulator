use pebble_sifli_board::{FaultKind, aon_timer::AonGlobalTimer, startup_io::StartupIo};

#[test]
fn global_timer_requires_both_domains_and_synchronizes_them() {
    let mut timer = AonGlobalTimer::default();
    assert_eq!(timer.enabled(), (false, false));
    timer.write(0x4004_0004, 1 << 31).unwrap();
    timer.advance(9_600, 10_000);
    assert_eq!(timer.counters(), (0, 2));
    assert_eq!(timer.write(0x500c_0034, 1), Err(FaultKind::UnmodeledMmio));
    timer.write(0x500c_0004, 1 << 31).unwrap();
    timer.advance(4_800, 10_000);
    assert_eq!(timer.counters(), (1, 3));
    timer.write(0x500c_0034, 1).unwrap();
    assert_eq!(timer.counters(), (3, 3));
    assert_eq!(timer.sync_writes, 1);
    timer.advance(4_800 * 7, 10_000);
    assert_eq!(timer.read(0x500c_0034), Ok(10));
    assert_eq!(timer.read(0x4004_0048), Ok(10));
}

#[test]
fn global_timer_rejects_unimplemented_pin_modes_and_counter_commands() {
    let mut timer = AonGlobalTimer::default();
    assert_eq!(timer.write(0x4004_0004, 1), Err(FaultKind::UnmodeledMmio));
    assert_eq!(
        timer.write(0x500c_0004, (1 << 31) | 1),
        Err(FaultKind::UnmodeledMmio)
    );
    assert_eq!(timer.write(0x4004_0048, 0), Err(FaultKind::UnmodeledMmio));
    assert_eq!(timer.write(0x500c_0034, 2), Err(FaultKind::UnmodeledMmio));
}

#[test]
fn startup_io_advances_enabled_timer_from_reference_ticks() {
    let mut io = StartupIo::default();
    io.write(0x4004_0004, 4, 1 << 31).unwrap();
    io.write(0x500c_0004, 4, 1 << 31).unwrap();
    io.write(0x500c_0034, 4, 1).unwrap();
    io.advance(4_800);
    assert_eq!(io.read(0x500c_0034, 4), Ok(1));
    assert_eq!(io.read(0x4004_0048, 4), Ok(1));
    assert_eq!(io.read(0x500c_0034, 2), Err(FaultKind::InvalidWidth));
}
