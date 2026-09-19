use pebble_sifli_board::{FaultKind, hpaon_wakeup::HpaonWakeup};

#[test]
fn early_wakeup_sources_are_enabled_without_creating_events() {
    let mut wakeup = HpaonWakeup::default();
    for source in [6, 7, 2, 1] {
        let next = wakeup.enabled() | (1 << source);
        wakeup.write(0x500c_0020, next).unwrap();
    }
    assert_eq!(wakeup.enabled(), 0xc6);
    assert_eq!(wakeup.read(0x500c_0020), Ok(0xc6));
    assert_eq!(
        wakeup.write(0x500c_0020, 1 << 8),
        Err(FaultKind::UnmodeledMmio)
    );
}
