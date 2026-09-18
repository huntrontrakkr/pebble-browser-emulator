use pebble_sifli_board::{
    FaultKind, Operation, Revision,
    execution::{EntryError, ResetProbe, Stop},
};

fn slot(words: &[u16], literal: u32) -> Vec<u8> {
    let mut image = vec![0xff; 0x1200];
    image[0x1000..0x1004].copy_from_slice(&0x20080000u32.to_le_bytes());
    image[0x1004..0x1008].copy_from_slice(&0x12021101u32.to_le_bytes());
    for (i, word) in words.iter().enumerate() {
        image[0x1100 + i * 2..0x1102 + i * 2].copy_from_slice(&word.to_le_bytes());
    }
    image[0x110c..0x1110].copy_from_slice(&literal.to_le_bytes());
    image
}

#[test]
fn unchanged_thumb_program_initializes_ram_and_stops_before_breakpoint() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        // ldr r0,[pc,#8]; movs r1,#69; str r1,[r0]; ldr r2,[r0]; b .
        let mut p = ResetProbe::new(
            revision,
            slot(&[0x4802, 0x2145, 0x6001, 0x6802, 0xe7fe], 0x20000000),
        )
        .unwrap();
        p.run(100, Some(0x12021108));
        assert_eq!(p.stop(), None);
        assert_eq!(p.instructions_completed, 4);
        assert_eq!(p.registers()[2], 69);
        assert_eq!(p.read(0x20000000, 4), Ok(69));
        assert_eq!(
            p.read(0x20000004, 1).unwrap_err().kind,
            FaultKind::UninitializedHcpuRam
        );
    }
}

#[test]
fn all_access_widths_reject_ppb_sio_and_missing_hardware() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        for address in [
            0xe000ed00, 0xd0000060, 0x40000100, 0, 0x20400000, 0x20000000,
        ] {
            for (opcode, width, operation) in [
                (0x6801, 4, Operation::Read),
                (0x8801, 2, Operation::Read),
                (0x7801, 1, Operation::Read),
                (0x6001, 4, Operation::Write),
                (0x8001, 2, Operation::Write),
                (0x7001, 1, Operation::Write),
            ] {
                if address == 0x20000000 && operation == Operation::Write {
                    continue;
                }
                let mut p =
                    ResetProbe::new(revision, slot(&[0x4802, opcode, 0x2245], address)).unwrap();
                p.run(100, None);
                let Some(Stop::Access(fault)) = p.stop() else {
                    panic!("{:?}", p.stop());
                };
                assert_eq!(
                    (
                        fault.revision,
                        fault.pc,
                        fault.address,
                        fault.width,
                        fault.operation
                    ),
                    (revision, 0x12021102, address, width, operation)
                );
                assert_eq!(p.instructions_completed, 1);
                let registers = p.registers();
                p.run(100, None);
                assert_eq!(p.registers(), registers);
                assert_eq!(p.stop(), Some(Stop::Access(fault)));
            }
        }
    }
}

#[test]
fn vectors_sleep_and_unsupported_instructions_are_explicit() {
    let mut image = slot(&[0xbf30], 0); // WFI
    let mut p = ResetProbe::new(Revision::ObelixPvt, image.clone()).unwrap();
    p.run(100, None);
    assert!(matches!(p.stop(), Some(Stop::Sleeping { .. })));
    image[0x1004] &= !1;
    assert!(matches!(
        ResetProbe::new(Revision::ObelixPvt, image),
        Err(EntryError::InvalidVector)
    ));
    let mut p = ResetProbe::new(Revision::ObelixPvt, slot(&[0xee10, 0x0010], 0)).unwrap();
    p.run(100, None);
    assert!(matches!(p.stop(), Some(Stop::Coprocessor { .. })));
    assert_eq!(p.steps_attempted, 0);
    let mut p = ResetProbe::new(Revision::ObelixPvt, slot(&[0xde00], 0)).unwrap(); // UDF
    p.run(100, None);
    assert!(p.stop().is_some());
    assert_eq!(p.instructions_completed, 0);
}

#[test]
fn branch_to_uninitialized_ram_is_a_fetch_fault_and_budget_is_bounded() {
    let mut p =
        ResetProbe::new(Revision::GetafixDvt2, slot(&[0x4802, 0x4700], 0x20000001)).unwrap();
    p.run(100, None);
    assert!(
        matches!(p.stop(),Some(Stop::Access(f)) if f.operation == Operation::Fetch && f.address == 0x20000000)
    );
    let mut p = ResetProbe::new(Revision::GetafixDvt2, slot(&[0xe7fe], 0)).unwrap();
    p.run(u32::MAX, None);
    assert_eq!(p.instructions_completed, 100000);
    assert_eq!(p.stop(), None);
}
