use emulator_qemu::PebbleBus;
use rp2350_emu::{core::CoreBus, threaded::CoreAtomics};
use std::sync::Arc;
#[test]
fn display_presents_only_completed_updates() {
    let mut bus = PebbleBus::new(vec![], Arc::new(CoreAtomics::default()));
    bus.write8(0x50000000, 0xff, 0);
    bus.write8(0x50000000 + 45599, 0xf0, 0);
    assert_eq!(
        bus.presented_frame[0], 0,
        "unfinished guest drawing must not leak"
    );
    bus.write32(0x40008000, 1, 0);
    assert_eq!(bus.devices.frames, 0, "enable alone does not present");
    bus.write32(0x40008000, 3, 0);
    assert_eq!(bus.devices.frames, 1);
    assert_eq!(
        (bus.presented_frame[0], bus.presented_frame[45599]),
        (0xff, 0xf0)
    );
    bus.write8(0x50000000, 0xc0, 0);
    assert_eq!(
        bus.presented_frame[0], 0xff,
        "the completed frame survives later guest writes"
    );
    bus.write32(0x40008000, 3, 0);
    assert_eq!(bus.devices.frames, 2);
    assert_eq!(bus.presented_frame[0], 0xc0);
    assert_eq!(
        bus.presented_frame[45599], 0xf0,
        "unmodified pixels persist"
    );
}
