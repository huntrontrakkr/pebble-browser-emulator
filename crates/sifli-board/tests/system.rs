use pebble_sifli_board::{
    FaultKind, Operation, Revision, SifliAddressSpace,
    cache::Cache,
    system::{Maintenance, Policy, SystemControl},
};
const RAM: u32 = 0x20020000;
fn memory() -> SifliAddressSpace {
    SifliAddressSpace::new(Revision::ObelixPvt, vec![0xff; 0x1200]).unwrap()
}
fn region(s: &mut SystemControl, n: u32, base: u32, limit: u32) {
    s.write(0xe000ed98, 4, n, true).unwrap();
    s.write(0xe000ed9c, 4, base, true).unwrap();
    s.write(0xe000eda0, 4, (limit & !31) | 1, true).unwrap();
}

#[test]
fn system_registers_are_bounded_and_preserve_unknowns() {
    let mut s = SystemControl::default();
    assert_eq!(s.read(0xe000ed90, 4, true), Ok(12 << 8));
    assert_eq!(
        s.read(0xe000ed00, 4, true),
        Err(FaultKind::UnsupportedSystemRegister)
    );
    assert_eq!(
        s.read(0xe002ed90, 4, true),
        Err(FaultKind::UnsupportedSystemRegister)
    );
    assert_eq!(s.read(0xe000ed90, 1, true), Err(FaultKind::InvalidWidth));
    assert_eq!(
        s.write(0xe000ed08, 4, 0x12345678, false),
        Err(FaultKind::MemoryProtection)
    );
    s.write(0xe000ed08, 4, 0x12345678, true).unwrap();
    assert_eq!(s.vtor, 0x12345600);
    s.write(0xe000ed98, 4, 11, true).unwrap();
    assert_eq!(
        s.write(0xe000ed98, 4, 12, true),
        Err(FaultKind::UnsupportedSystemRegister)
    );
    assert_eq!(s.rnr, 11);
    // Region aliases select their own lane within the same group of four.
    s.write(0xe000edac, 4, 0x20024007, true).unwrap();
    assert_eq!(s.regions[10].0, 0x20024007);
    assert_eq!(s.read(0xe000edac, 4, true), Ok(0x20024007));
}

#[test]
fn mpu_enforces_privilege_readonly_execute_and_region_crossings() {
    let mut s = SystemControl::default();
    s.mair[0] = 0x44;
    region(&mut s, 0, RAM | 4, (RAM + 31) | 1); // RO privileged, executable
    s.ctrl = 1;
    assert_eq!(
        s.access(RAM, 4, Operation::Read, true),
        Ok(Policy::Uncached)
    );
    assert_eq!(
        s.access(RAM, 2, Operation::Fetch, true),
        Ok(Policy::Uncached)
    );
    for (a, w, op, p) in [
        (RAM, 4, Operation::Write, true),
        (RAM, 4, Operation::Read, false),
        (RAM + 30, 4, Operation::Read, true),
    ] {
        assert_eq!(s.access(a, w, op, p), Err(FaultKind::MemoryProtection));
    }
    region(&mut s, 0, RAM | 7, (RAM + 31) | 1); // RO any privilege, XN
    assert_eq!(
        s.access(RAM, 4, Operation::Read, false),
        Ok(Policy::Uncached)
    );
    assert_eq!(
        s.access(RAM, 2, Operation::Fetch, true),
        Err(FaultKind::MemoryProtection)
    );
    s.ctrl = 5;
    assert_eq!(
        s.access(RAM + 32, 4, Operation::Read, true),
        Ok(Policy::WriteBack)
    );
    assert_eq!(
        s.access(RAM + 32, 4, Operation::Read, false),
        Err(FaultKind::MemoryProtection)
    );
    region(&mut s, 1, RAM, (RAM + 31) | 1);
    assert_eq!(
        s.access(RAM, 4, Operation::Read, true),
        Err(FaultKind::MemoryProtection)
    );
    assert_eq!(
        s.access(0xffffffff, 4, Operation::Read, true),
        Err(FaultKind::MemoryProtection)
    );
}

#[test]
fn unknown_attributes_and_device_execution_are_rejected() {
    let mut s = SystemControl::default();
    region(&mut s, 0, RAM, (RAM + 31) | 1);
    s.ctrl = 1;
    assert_eq!(
        s.access(RAM, 2, Operation::Fetch, true),
        Err(FaultKind::MemoryProtection)
    );
    s.mair[0] = 0xab;
    assert_eq!(
        s.access(RAM, 4, Operation::Read, true),
        Err(FaultKind::UnsupportedMemoryAttribute)
    );
    s.ctrl = 0;
    assert_eq!(
        s.access(0x20000000, 4, Operation::Read, true),
        Ok(Policy::Uncached)
    ); // DTCM
}

#[test]
fn split_cache_visibility_requires_clean_and_invalidate() {
    let mut m = memory();
    let mut d = Cache::data();
    let mut i = Cache::instruction();
    m.write(0, RAM, 4, 0x12345678).unwrap();
    assert_eq!(i.read(&mut m, 0, RAM, 4, Operation::Fetch), Ok(0x12345678));
    d.write(&mut m, 0, RAM, 4, 0x87654321, Policy::WriteBack)
        .unwrap();
    assert_eq!(d.read(&mut m, 0, RAM, 4, Operation::Read), Ok(0x87654321));
    assert_eq!(m.read(0, RAM, 4, Operation::Read), Ok(0x12345678));
    d.maintain(&mut m, 0, RAM, false, true, false).unwrap();
    assert_eq!(m.read(0, RAM, 4, Operation::Read), Ok(0x87654321));
    assert_eq!(i.read(&mut m, 0, RAM, 4, Operation::Fetch), Ok(0x12345678));
    i.invalidate_address(RAM);
    assert_eq!(i.read(&mut m, 0, RAM, 4, Operation::Fetch), Ok(0x87654321));
}

#[test]
fn dirty_invalidate_loses_unwritten_bytes_and_clean_does_not_invent_ram() {
    let mut m = memory();
    let mut d = Cache::data();
    d.write(&mut m, 0, RAM, 1, 69, Policy::WriteBack).unwrap();
    assert_eq!(d.read(&mut m, 0, RAM, 1, Operation::Read), Ok(69));
    assert!(d.read(&mut m, 0, RAM + 1, 1, Operation::Read).is_err());
    d.maintain(&mut m, 0, RAM, false, true, false).unwrap();
    assert_eq!(m.read(0, RAM, 1, Operation::Read), Ok(69));
    assert!(m.read(0, RAM + 1, 1, Operation::Read).is_err());
    d.write(&mut m, 0, RAM, 1, 70, Policy::WriteBack).unwrap();
    d.maintain(&mut m, 0, RAM, false, false, true).unwrap();
    assert_eq!(d.read(&mut m, 0, RAM, 1, Operation::Read), Ok(69));
}

#[test]
fn write_through_and_set_way_maintenance_match_backing_visibility() {
    let mut m = memory();
    let mut d = Cache::data();
    d.write(&mut m, 0, RAM, 4, 7, Policy::WriteThrough).unwrap();
    assert_eq!(m.read(0, RAM, 4, Operation::Read), Ok(7));
    d.read(&mut m, 0, RAM, 4, Operation::Read).unwrap();
    d.write(&mut m, 0, RAM, 4, 9, Policy::WriteThrough).unwrap();
    assert_eq!(d.read(&mut m, 0, RAM, 4, Operation::Read), Ok(9));
    d.write(&mut m, 0, RAM, 4, 11, Policy::WriteBack).unwrap();
    d.maintain(&mut m, 0, 0, true, true, true).unwrap(); // way 0, set 0
    assert_eq!(m.read(0, RAM, 4, Operation::Read), Ok(11));
    let mut s = SystemControl::default();
    assert_eq!(
        s.write(0xe000ef74, 4, 0, true),
        Ok(Maintenance::Data {
            value: 0,
            by_set: true,
            clean: true,
            invalidate: true
        })
    );
    assert_eq!((s.read(0xe000ed80, 4, true).unwrap() >> 13) & 0x7fff, 127);
    s.write(0xe000ed84, 4, 1, true).unwrap();
    assert_eq!((s.read(0xe000ed80, 4, true).unwrap() >> 13) & 0x7fff, 511);
}

#[test]
fn fifth_tag_in_one_data_set_writes_back_the_dirty_victim() {
    let mut m = memory();
    let mut d = Cache::data();
    for n in 0..4 {
        d.write(&mut m, 0, RAM + n * 4096, 4, 100 + n, Policy::WriteBack)
            .unwrap();
    }
    assert!(m.read(0, RAM, 4, Operation::Read).is_err());
    d.write(&mut m, 0, RAM + 4 * 4096, 4, 104, Policy::WriteBack)
        .unwrap();
    assert_eq!(m.read(0, RAM, 4, Operation::Read), Ok(100));
    // Unwritten adjacent bytes must not be fabricated during eviction.
    assert!(m.read(0, RAM + 4, 1, Operation::Read).is_err());
    assert_eq!(
        d.read(&mut m, 0, RAM + 4 * 4096, 4, Operation::Read),
        Ok(104)
    );
}
