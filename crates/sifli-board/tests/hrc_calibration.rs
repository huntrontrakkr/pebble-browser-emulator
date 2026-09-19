use pebble_sifli_board::{FaultKind, hrc_calibration::HrcCalibration};

#[test]
fn calibration_completes_after_the_programmed_reference_window() {
    let mut calibration = HrcCalibration::default();
    calibration.write(0x5000_0034, 0x3fff).unwrap();
    calibration.write(0x5000_0034, 0x4000_3fff).unwrap();
    calibration.advance(0x3ffe, 0x200);
    assert!(!calibration.done());
    calibration.advance(1, 0x200);
    assert!(calibration.done());
    assert_eq!(calibration.read(0x5000_0038), Ok(0x3fff_3fff));
    assert_eq!(calibration.measurements_completed, 1);
}

#[test]
fn result_is_read_only_and_unknown_control_bits_fail() {
    let mut calibration = HrcCalibration::default();
    assert_eq!(
        calibration.write(0x5000_0038, 1),
        Err(FaultKind::UnmodeledMmio)
    );
    assert_eq!(
        calibration.write(0x5000_0034, 1 << 29),
        Err(FaultKind::UnmodeledMmio)
    );
}
