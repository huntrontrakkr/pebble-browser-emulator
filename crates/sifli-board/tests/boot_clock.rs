use pebble_sifli_board::{
    FaultKind, clock::BootClock, debug_counter::DebugCounter, startup_io::StartupIo,
};

#[test]
fn oscillator_readiness_requires_elapsed_time_and_can_fail() {
    let mut c = BootClock::default();
    for _ in 0..1000 {
        assert_eq!(c.read(0x500c0010), Ok(0x40000007));
    }
    assert!(c.write(0x50000020, 0x1001).is_err());
    c.advance(47_999);
    assert!(!c.hxt_ready());
    c.advance(1);
    assert!(c.hxt_ready());
    c.write(0x50000020, 0x1001).unwrap();
    // The selected CPU source and its power cannot be disabled.
    assert!(c.write(0x500c0010, 5).is_err());
    assert!(c.write(0x500c0010, 3).is_err());
    assert!(c.write(0x50000020, 0x1003).is_err()); // unmodeled DLL
    assert_eq!(c.read(0x50000020), Ok(0x1001));
    let mut failed = BootClock::default();
    failed.hxt_startup_ticks.take();
    failed.advance(48_000_000);
    assert!(!failed.hxt_ready());
}

#[test]
fn restart_and_dividers_use_reference_time_not_poll_count() {
    let mut c = BootClock::default();
    c.advance(48_000);
    c.write(0x500c0010, 5).unwrap();
    assert!(!c.hxt_ready());
    c.advance(48_000);
    c.write(0x500c0010, 7).unwrap();
    c.write(0x50000024, 0x24102).unwrap();
    c.advance(23_999);
    assert!(!c.hxt_ready());
    c.advance(1);
    assert!(c.hxt_ready());
    assert_eq!(c.reference_ticks, 144_000);
    assert_eq!(c.estimated_cycles, 120_000);
}

#[test]
fn dwt_gating_wrap_and_cpi_use_estimates_without_faking_other_debug_registers() {
    let mut d = DebugCounter::default();
    d.write(0xe0001000, 4, 0x20001).unwrap();
    d.advance(20);
    assert_eq!(d.read(0xe0001004, 4), Ok(0)); // TRCENA disabled
    d.write(0xe000edfc, 4, 1 << 24).unwrap();
    d.write(0xe0001004, 4, u32::MAX - 3).unwrap();
    d.advance(7);
    assert_eq!(d.read(0xe0001004, 4), Ok(3));
    assert_eq!(d.read(0xe0001008, 4), Ok(6));
    d.write(0xe0001000, 4, 0x800001).unwrap();
    d.advance(100);
    assert_eq!(d.read(0xe0001004, 4), Ok(3)); // secure count disabled
    assert!(d.write(0xe0001000, 4, 1 << 16).is_err()); // unsupported trace
    assert_eq!(
        d.read(0xe0001010, 4),
        Err(FaultKind::UnsupportedSystemRegister)
    );
    assert_eq!(d.read(0xe0001004, 1), Err(FaultKind::InvalidWidth));
    assert_eq!(d.read(0xe000e010, 4), Ok(0));
    assert!(d.write(0xe000e010, 4, 1).is_err()); // no fake running SysTick
}

#[test]
fn lp_active_is_documented_power_status_not_a_controller_response() {
    let mut io = StartupIo::default();
    assert_eq!(io.read(0x500c002c, 4), Ok(0x30));
    io.write(0x500c002c, 4, 0x11).unwrap();
    assert_eq!(io.read(0x500c002c, 4), Ok(0x31)); // RO LP_ACTIVE preserved
    assert_eq!(io.read(0x40040000, 4), Err(FaultKind::UnmodeledMmio));
    assert!(io.write(0x500c002c, 4, 0).is_err()); // HP low power not modeled
}
