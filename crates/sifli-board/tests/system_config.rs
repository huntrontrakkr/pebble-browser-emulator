use pebble_sifli_board::{FaultKind, system_config::SystemConfig};

#[test]
fn watchdog_reset_scope_is_explicit_and_other_system_controls_fail() {
    let mut config = SystemConfig::default();
    assert!(!config.watchdog_reboots_chip());
    assert_eq!(config.read(0x5000_b00c), Ok(1));
    config.write(0x5000_b00c, 0).unwrap();
    assert_eq!(config.read(0x5000_b00c), Ok(0));
    assert_eq!(config.read(0x5000_b010), Ok(0));
    config.write(0x5000_b010, 1).unwrap();
    assert!(config.watchdog_reboots_chip());
    assert_eq!(config.read(0x5000_b010), Ok(1));
    assert_eq!(config.write(0x5000_b010, 2), Err(FaultKind::UnmodeledMmio));

    assert_eq!(config.read(0x5000_b01c), Ok(0x0013_0213));
    config.write(0x5000_b094, 3).unwrap();
    assert_eq!(config.read(0x5000_b094), Ok(3));
    assert_eq!(config.write(0x5000_b094, 4), Err(FaultKind::UnmodeledMmio));
}
