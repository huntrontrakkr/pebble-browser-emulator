use pebble_sifli_board::{FaultKind, dll::Dll};

#[test]
fn dll_lock_follows_enable_and_minimum_manual_delay() {
    let mut dll = Dll::default();
    let reset = dll.read(0x5000_002c).unwrap();
    assert_eq!(reset >> 31, 0);
    dll.write(0x5000_002c, reset | 1).unwrap();
    dll.advance(239);
    assert!(!dll.dll1_ready());
    dll.advance(1);
    assert!(dll.dll1_ready());
    assert_eq!(dll.locks_completed, 1);
}

#[test]
fn ready_is_read_only() {
    let mut dll = Dll::default();
    assert_eq!(
        dll.write(0x5000_002c, 1 << 31),
        Err(FaultKind::UnmodeledMmio)
    );
}
