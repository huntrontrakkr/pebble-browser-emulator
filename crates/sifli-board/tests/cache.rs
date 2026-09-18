use pebble_sifli_board::{
    FaultKind, Operation, Revision, SifliAddressSpace, cache::Cache, system::Policy,
};
#[test]
fn diagnostic_peek_sees_dirty_bytes_without_cleaning_or_filling() {
    let mut m = SifliAddressSpace::new(Revision::ObelixPvt, vec![0; 0x1200]).unwrap();
    let mut c = Cache::data();
    let a = 0x20020000;
    m.write(0, a, 1, 0x11).unwrap();
    c.write(&mut m, 0, a, 1, 0x69, Policy::WriteBack).unwrap();
    for _ in 0..3 {
        assert_eq!(c.peek_byte(a), Some(Ok(0x69)));
    }
    assert_eq!(m.read(0, a, 1, Operation::Read), Ok(0x11));
    assert_eq!(
        c.peek_byte(a + 1),
        Some(Err(FaultKind::UninitializedHcpuRam))
    );
    assert_eq!(c.peek_byte(a + 32), None);
    c.invalidate_all();
    assert_eq!(c.peek_byte(a), None);
    assert_eq!(m.read(0, a, 1, Operation::Read), Ok(0x11));
}
