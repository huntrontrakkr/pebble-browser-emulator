//! Independent byte oracle for optimized bus accesses, including partial faults.
use emulator_qemu::{PebbleBus, profile::BoardProfile};
use rp2350_emu::{core::CoreBus, threaded::CoreAtomics};
use std::sync::Arc;

fn ranges(bus: &PebbleBus) -> [(u32, &[u8]); 4] {
    [
        (0, &bus.code),
        (0x10000000, &bus.flash),
        (0x20000000, &bus.ram),
        (0x50000000, &bus.frame),
    ]
}

#[test]
fn scalar_oracle_covers_widths_alignment_edges_wrap_and_fault_order() {
    for profile in [
        BoardProfile::FLINT,
        BoardProfile::EMERY,
        BoardProfile::GABBRO,
    ] {
        let mut bus =
            PebbleBus::with_profile(vec![0; 259], Arc::new(CoreAtomics::default()), profile);
        bus.flash.truncate(263);
        bus.ram.truncate(269);
        bus.frame.truncate(271);
        for bytes in [&mut bus.code, &mut bus.flash, &mut bus.ram, &mut bus.frame] {
            for (i, value) in bytes.iter_mut().enumerate() {
                *value = (i * 173 + 29) as u8;
            }
        }
        let mut addresses = vec![u32::MAX - 2, u32::MAX - 1, u32::MAX, 0x60000000, 0x4000ffff];
        for (base, bytes) in ranges(&bus) {
            for offset in 0..bytes.len() + 4 {
                addresses.push(base + offset as u32);
            }
            for offset in 1..=4 {
                addresses.push(base.wrapping_sub(offset));
            }
        }
        for a in addresses {
            for width in [1u32, 2, 4] {
                bus.active_pc = 0x1234;
                bus.failed = None;
                bus.clear_bus_fault(0);
                let mut expected = 0u32;
                let mut faults = Vec::new();
                for i in 0..width {
                    let address = a.wrapping_add(i);
                    let byte = ranges(&bus).iter().find_map(|(base, bytes)| {
                        address
                            .checked_sub(*base)
                            .and_then(|n| bytes.get(n as usize))
                    });
                    match byte {
                        Some(byte) => expected |= (*byte as u32) << (8 * i),
                        None => faults.push(address),
                    }
                }
                let actual = match width {
                    1 => bus.read8(a, 0) as u32,
                    2 => bus.read16(a, 0) as u32,
                    _ => bus.read32(a, 0),
                };
                assert_eq!(actual, expected, "read {a:08x}/{width}");
                assert_eq!(bus.failed, faults.first().map(|a| (0x1234, *a, false)));
                assert_eq!(bus.bus_fault(0), !faults.is_empty());
                if let Some(last) = faults.last() {
                    assert_eq!(bus.bus_fault_addr(0), *last);
                }

                let before = [
                    bus.code.clone(),
                    bus.flash.clone(),
                    bus.ram.clone(),
                    bus.frame.clone(),
                ];
                let mut expected = before.clone();
                faults.clear();
                let value = 0xb7e931a5u32;
                for i in 0..width {
                    let address = a.wrapping_add(i);
                    let mut written = false;
                    for (index, base) in [(1, 0x10000000u32), (2, 0x20000000), (3, 0x50000000)] {
                        if let Some(offset) = address.checked_sub(base)
                            && let Some(byte) = expected[index].get_mut(offset as usize)
                        {
                            *byte = (value >> (i * 8)) as u8;
                            written = true;
                            break;
                        }
                    }
                    if !written {
                        faults.push(address);
                    }
                }
                bus.failed = None;
                bus.clear_bus_fault(0);
                match width {
                    1 => bus.write8(a, value as u8, 0),
                    2 => bus.write16(a, value as u16, 0),
                    _ => bus.write32(a, value, 0),
                }
                for (region, (actual, expected)) in [&bus.code, &bus.flash, &bus.ram, &bus.frame]
                    .into_iter()
                    .zip(&expected)
                    .enumerate()
                {
                    assert!(
                        actual == expected,
                        "write {a:08x}/{width}: region {region} bytes differ"
                    );
                }
                assert_eq!(bus.failed, faults.first().map(|a| (0x1234, *a, true)));
                assert_eq!(bus.bus_fault(0), !faults.is_empty());
                if let Some(last) = faults.last() {
                    assert_eq!(bus.bus_fault_addr(0), *last);
                }
                [bus.code, bus.flash, bus.ram, bus.frame] = before;
            }
        }
    }
}
