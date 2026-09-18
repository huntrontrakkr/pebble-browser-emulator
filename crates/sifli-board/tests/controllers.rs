use pebble_sifli_board::{FaultKind, efuse::Efuse, lcpu_reset::LcpuReset, startup_io::StartupIo};
#[test]
fn lcpu_reset_requires_hold_and_does_not_start_an_absent_core() {
    let mut c = LcpuReset::default();
    assert!(c.write(0x40000000, u32::MAX).is_err());
    assert_eq!(c.read(0x40040000), Ok(0));
    c.write(0x40040000, 4).unwrap();
    c.write(0x40000000, u32::MAX).unwrap();
    assert_eq!(c.read(0x40000000), Ok(LcpuReset::MASK));
    c.write(0x40000000, u32::MAX).unwrap();
    assert_eq!(c.reset_assertions, 1);
    assert_eq!(c.read(0x40040040), Ok(0));
    c.write(0x40000000, 0).unwrap();
    assert!(c.halted());
    assert_eq!(c.reset_releases, 1);
    assert_eq!(c.write(0x40040000, 0), Err(FaultKind::MissingLcpuState));
    assert!(c.write(0x40040040, 1).is_err());
    assert!(c.halted());
}
#[test]
fn efuse_requires_bank_data_then_latches_only_after_timed_transfer() {
    let mut c = Efuse::default();
    assert_eq!(c.read(0x5000c050), Ok(0)); // documented reset latch, not OTP
    assert_eq!(
        c.write(0x5000c000, 5),
        Err(FaultKind::MissingFactoryCalibration)
    );
    assert_eq!(c.read(0x5000c000), Ok(0)); // failure is transactional
    assert!(c.supply(1, [0x69; 32]));
    c.write(0x5000c000, 5).unwrap();
    for _ in 0..1000 {
        assert_eq!(c.read(0x5000c008), Ok(0));
    }
    c.advance(1035, 2);
    assert_eq!(c.read(0x5000c008), Ok(0));
    assert_eq!(c.read(0x5000c050), Ok(0));
    assert!(c.write(0x5000c000, 5).is_err()); // busy
    c.advance(1, 2);
    assert_eq!(c.read(0x5000c008), Ok(1));
    assert_eq!(c.read(0x5000c000), Ok(4)); // self-cleared EN
    assert_eq!(c.read(0x5000c050), Ok(0x69696969));
    assert_eq!(c.read(0x5000c030), Ok(0)); // other bank not latched
    c.write(0x5000c008, 0).unwrap();
    assert_eq!(c.read(0x5000c008), Ok(1));
    c.write(0x5000c008, 1).unwrap();
    assert_eq!(c.read(0x5000c008), Ok(0));
    assert!(c.write(0x5000c000, 7).is_err()); // programming unsupported
    assert!(c.write(0x5000c000, 0x15).is_err()); // IRQ unsupported
    assert!(c.write(0x5000c00c, 0).is_err()); // reserved
    c.reset();
    assert_eq!(c.read(0x5000c050), Ok(0));
    assert_eq!(c.loaded_mask(), 2); // OTP survives peripheral reset
    c.write(0x5000c000, 5).unwrap();
    c.advance(1036, 2);
    assert_eq!(c.read(0x5000c050), Ok(0x69696969));
}
#[test]
fn efuse_clock_gating_and_reset_cancel_transfer_without_erasing_data() {
    let mut io = StartupIo::default();
    assert!(io.efuse.supply(1, [0x42; 32]));
    io.write(0x5000c000, 4, 5).unwrap();
    io.write(0x50000018, 4, 1 << 11).unwrap();
    io.advance(10_000);
    assert!(io.read(0x5000c008, 4).is_err());
    io.write(0x50000010, 4, 1 << 11).unwrap();
    assert_eq!(io.read(0x5000c008, 4), Ok(0));
    io.advance(1036);
    assert_eq!(io.read(0x5000c050, 4), Ok(0x42424242));
    io.write(0x5000c000, 4, 5).unwrap();
    io.write(0x50000000, 4, 1 << 11).unwrap();
    assert!(io.read(0x5000c008, 4).is_err());
    io.advance(10_000);
    io.write(0x50000000, 4, 0).unwrap();
    assert_eq!(io.read(0x5000c008, 4), Ok(0));
    assert_eq!(io.read(0x5000c050, 4), Ok(0));
    assert_eq!(io.efuse.loaded_mask(), 2);
    assert!(io.write(0x50000000, 4, 1).is_err());
    assert!(io.read(0x5000c004, 1).is_err());
}

#[test]
fn calibration_latches_preserve_control_fields_and_require_identity() {
    use pebble_sifli_board::calibration::Calibration;
    let mut c = Calibration::default();
    assert_eq!(c.read(0x5000b004), Err(FaultKind::MissingChipIdentity));
    let initial = c.buck;
    c.write(0x500ca02c, (initial & !0x4e000000) | 0x4a000000)
        .unwrap();
    assert_eq!(c.buck & 0x4e000000, 0x4a000000);
    assert_eq!(c.buck & !0x4e000000, initial & !0x4e000000);
    assert!(c.write(0x500ca02c, c.buck ^ 1).is_err()); // no false power control
    let old = c.vret;
    c.write(0x500ca014, (old & !0x3c00) | 0x2800).unwrap();
    assert_eq!(c.vret & 0x3c00, 0x2800);
    assert!(c.write(0x500ca014, c.vret ^ 1).is_err());
    assert!(c.write(0x500ca05c, c.peri_ldo | 1).is_err());
    assert!(c.write(0x5000b004, 1).is_err());
}
