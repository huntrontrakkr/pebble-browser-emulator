use pebble_sifli_board::{FaultKind, sip_pinmux::SipPinmux};

#[test]
fn package_pads_can_enter_the_hal_analog_state() {
    let mut pins = SipPinmux::default();
    assert_eq!(pins.read(0x5000_3000), Ok(0x2d0));
    assert_eq!(pins.read(0x5000_3004), Ok(0x2f0));
    for index in 0..13 {
        let address = 0x5000_3000 + index * 4;
        let expected = (pins.read(address).unwrap() & !0x5f) | 0xf;
        pins.write(address, expected).unwrap();
    }
    assert_eq!(pins.analog_transitions, 13);
}

#[test]
fn arbitrary_pin_functions_remain_unmodeled() {
    let mut pins = SipPinmux::default();
    assert_eq!(pins.write(0x5000_3000, 1), Err(FaultKind::UnmodeledMmio));
}
