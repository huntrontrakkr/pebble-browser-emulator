//! Strict HCPU address-space foundation for two SF32LB52J watch revisions.
//! Includes a bounded reset-execution probe, not a complete firmware runtime.
//! Memory ranges follow pinned SiFli SDK `sf32lb52x/mem_map.h`; only locally
//! supplied slot-0 bytes and HCPU SRAM are backed. Every other access faults.

pub mod execution;
mod wasm;

const HCPU_ROM_END: u64 = 0x0001_0000;
const QSPI1_BASE: u64 = 0x1000_0000;
const QSPI2_BASE: u64 = 0x1200_0000;
const QSPI2_END: u64 = 0x2000_0000;
const SLOT0_BASE: u64 = 0x1202_0000;
const RAM_BASE: u64 = 0x2000_0000;
const RAM_END: u64 = 0x2008_0000;
const LCPU_RAM_BASE: u64 = 0x2040_0000;
const LCPU_RAM_END: u64 = 0x2041_0000;
const MMIO_BASE: u64 = 0x4000_0000;
const MMIO_END: u64 = 0x6000_0000;
const MAX_SLOT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Revision {
    ObelixPvt,
    GetafixDvt2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    Read,
    Write,
    Fetch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FaultKind {
    InvalidWidth,
    InvalidOperation,
    MissingHcpuRom,
    MissingQspi1,
    MissingQspi2,
    MissingLcpuState,
    UninitializedHcpuRam,
    UnmodeledMmio,
    ReadOnlyFlash,
    Unmapped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AccessFault {
    pub revision: Revision,
    pub pc: u32,
    pub address: u32,
    pub width: u8,
    pub operation: Operation,
    pub kind: FaultKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageError {
    InvalidSlotSize,
}

enum Backing {
    Slot(usize),
    Ram(usize),
}

pub struct SifliAddressSpace {
    revision: Revision,
    slot0: Vec<u8>,
    ram: Vec<u8>,
    ram_initialized: Vec<u8>,
}

impl SifliAddressSpace {
    /// Takes ownership of a separately audited raw slot-0 image. This does not
    /// validate an ELF, establish authenticity, or provide a boot entry state.
    pub fn new(revision: Revision, slot0: Vec<u8>) -> Result<Self, ImageError> {
        if !(0x1008..=MAX_SLOT_BYTES).contains(&slot0.len()) {
            return Err(ImageError::InvalidSlotSize);
        }
        Ok(Self {
            revision,
            slot0,
            ram: vec![0; (RAM_END - RAM_BASE) as usize],
            ram_initialized: vec![0; (RAM_END - RAM_BASE) as usize],
        })
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    fn region(
        &self,
        pc: u32,
        address: u32,
        width: u8,
        operation: Operation,
    ) -> Result<Backing, AccessFault> {
        let fault = |kind| AccessFault {
            revision: self.revision,
            pc,
            address,
            width,
            operation,
            kind,
        };
        if !matches!(width, 1 | 2 | 4) {
            return Err(fault(FaultKind::InvalidWidth));
        }
        let start = address as u64;
        let end = start + width as u64;
        if start >= SLOT0_BASE && end <= SLOT0_BASE + self.slot0.len() as u64 {
            return if operation == Operation::Write {
                Err(fault(FaultKind::ReadOnlyFlash))
            } else {
                Ok(Backing::Slot((start - SLOT0_BASE) as usize))
            };
        }
        if start >= RAM_BASE && end <= RAM_END {
            return Ok(Backing::Ram((start - RAM_BASE) as usize));
        }
        let kind = if start < HCPU_ROM_END && end <= HCPU_ROM_END {
            FaultKind::MissingHcpuRom
        } else if start >= QSPI1_BASE && end <= QSPI2_BASE {
            FaultKind::MissingQspi1
        } else if start >= QSPI2_BASE && end <= QSPI2_END {
            FaultKind::MissingQspi2
        } else if start >= LCPU_RAM_BASE && end <= LCPU_RAM_END {
            FaultKind::MissingLcpuState
        } else if start >= MMIO_BASE && end <= MMIO_END {
            FaultKind::UnmodeledMmio
        } else {
            FaultKind::Unmapped
        };
        Err(fault(kind))
    }

    pub fn read(
        &self,
        pc: u32,
        address: u32,
        width: u8,
        operation: Operation,
    ) -> Result<u32, AccessFault> {
        if operation == Operation::Write {
            return Err(AccessFault {
                revision: self.revision,
                pc,
                address,
                width,
                operation,
                kind: FaultKind::InvalidOperation,
            });
        }
        let backing = self.region(pc, address, width, operation)?;
        let bytes = match backing {
            Backing::Slot(offset) => &self.slot0[offset..offset + width as usize],
            Backing::Ram(offset) => {
                if self.ram_initialized[offset..offset + width as usize].contains(&0) {
                    return Err(AccessFault {
                        revision: self.revision,
                        pc,
                        address,
                        width,
                        operation,
                        kind: FaultKind::UninitializedHcpuRam,
                    });
                }
                &self.ram[offset..offset + width as usize]
            }
        };
        let mut word = [0; 4];
        word[..width as usize].copy_from_slice(bytes);
        Ok(u32::from_le_bytes(word))
    }

    pub fn write(
        &mut self,
        pc: u32,
        address: u32,
        width: u8,
        value: u32,
    ) -> Result<(), AccessFault> {
        let backing = self.region(pc, address, width, Operation::Write)?;
        let Backing::Ram(offset) = backing else {
            unreachable!("flash writes are rejected by region")
        };
        self.ram[offset..offset + width as usize]
            .copy_from_slice(&value.to_le_bytes()[..width as usize]);
        self.ram_initialized[offset..offset + width as usize].fill(1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(revision: Revision) -> SifliAddressSpace {
        let mut slot = vec![0xff; 0x1100];
        slot[0x1000..0x1008].copy_from_slice(&[0x40, 0x4d, 0x03, 0x20, 0xb9, 0x6b, 0x04, 0x12]);
        SifliAddressSpace::new(revision, slot).unwrap()
    }

    #[test]
    fn slot_image_is_mapped_at_its_physical_qspi2_address() {
        let bus = memory(Revision::ObelixPvt);
        assert_eq!(
            bus.read(0x1204_6bb9, 0x1202_1000, 4, Operation::Read),
            Ok(0x2003_4d40)
        );
        assert_eq!(
            bus.read(0x1204_6bb9, 0x1202_1004, 4, Operation::Fetch),
            Ok(0x1204_6bb9)
        );
        assert_eq!(bus.read(0, 0x1202_0000, 1, Operation::Read), Ok(0xff));
    }

    #[test]
    fn unknown_sources_and_mmio_fault_with_full_access_identity() {
        let bus = memory(Revision::GetafixDvt2);
        for (address, kind) in [
            (0, FaultKind::MissingHcpuRom),
            (0x1000_0000, FaultKind::MissingQspi1),
            (0x1200_0000, FaultKind::MissingQspi2),
            (0x1202_1100, FaultKind::MissingQspi2),
            (0x2040_0000, FaultKind::MissingLcpuState),
            (0x4000_0000, FaultKind::UnmodeledMmio),
            (0xf000_0000, FaultKind::Unmapped),
        ] {
            assert_eq!(
                bus.read(0x1234, address, 4, Operation::Read),
                Err(AccessFault {
                    revision: Revision::GetafixDvt2,
                    pc: 0x1234,
                    address,
                    width: 4,
                    operation: Operation::Read,
                    kind
                })
            );
        }
    }

    #[test]
    fn ram_writes_are_little_endian_and_invalid_writes_are_transactional() {
        let mut bus = memory(Revision::ObelixPvt);
        assert_eq!(
            bus.read(0, 0x2000_0000, 4, Operation::Read)
                .unwrap_err()
                .kind,
            FaultKind::UninitializedHcpuRam
        );
        bus.write(0x1234, 0x2000_0000, 4, 0x1234_abcd).unwrap();
        assert_eq!(bus.read(0, 0x2000_0001, 2, Operation::Read), Ok(0x34ab));
        assert_eq!(
            bus.write(0x1234, 0x2007_fffe, 4, 0),
            Err(AccessFault {
                revision: Revision::ObelixPvt,
                pc: 0x1234,
                address: 0x2007_fffe,
                width: 4,
                operation: Operation::Write,
                kind: FaultKind::Unmapped
            })
        );
        assert_eq!(
            bus.read(0, 0x2007_fffe, 2, Operation::Read)
                .unwrap_err()
                .kind,
            FaultKind::UninitializedHcpuRam
        );
        assert_eq!(
            bus.write(0x1234, 0x1202_0000, 1, 0),
            Err(AccessFault {
                revision: Revision::ObelixPvt,
                pc: 0x1234,
                address: 0x1202_0000,
                width: 1,
                operation: Operation::Write,
                kind: FaultKind::ReadOnlyFlash
            })
        );
        assert_eq!(bus.read(0, 0x1202_0000, 1, Operation::Read), Ok(0xff));
        assert_eq!(
            bus.read(0, 0x2000_0000, 8, Operation::Read)
                .unwrap_err()
                .kind,
            FaultKind::InvalidWidth
        );
        assert_eq!(
            bus.read(0, 0x2000_0000, 4, Operation::Write)
                .unwrap_err()
                .kind,
            FaultKind::InvalidOperation
        );
    }

    #[test]
    fn images_are_bounded() {
        assert!(matches!(
            SifliAddressSpace::new(Revision::ObelixPvt, vec![]),
            Err(ImageError::InvalidSlotSize)
        ));
        assert!(matches!(
            SifliAddressSpace::new(Revision::ObelixPvt, vec![0; MAX_SLOT_BYTES + 1]),
            Err(ImageError::InvalidSlotSize)
        ));
    }
}
