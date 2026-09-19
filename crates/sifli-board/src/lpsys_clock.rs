//! Bounded SF32LB52 LPSYS RCC clock selection used by PebbleOS early startup.
//! The reset value and fields follow UM5201 V0.8.8 and the pinned SiFli HAL.
use crate::FaultKind;

const CSR: u32 = 0x4000_0010;
const SELECT_MASK: u32 = 0x75;
const SELECT_PERI_HXT48: u32 = 1 << 4;

#[derive(Default)]
pub struct LpsysClock {
    csr: u32,
    pub peripheral_source_changes: u32,
}

impl LpsysClock {
    pub fn owns(address: u32) -> bool {
        address == CSR
    }

    pub fn peripheral_uses_hxt48(&self) -> bool {
        self.csr & SELECT_PERI_HXT48 != 0
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            CSR => Ok(self.csr),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address {
            // CSR contains only the documented source selectors. The current
            // physical startup path changes LP_PERI to HXT48; accepting other
            // selector changes would claim clock behavior not yet modeled.
            CSR if value & !SELECT_MASK == 0 && (value ^ self.csr) & !SELECT_PERI_HXT48 == 0 => {
                if value != self.csr {
                    self.peripheral_source_changes += 1;
                }
                self.csr = value;
            }
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
