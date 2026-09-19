//! HPSYS always-on wake enables configured by PebbleOS early startup.
//! This records source enables only; no wake event is manufactured.
use crate::FaultKind;

const WER: u32 = 0x500c_0020;
const EARLY_SOURCES: u32 = (1 << 1) | (1 << 2) | (1 << 6) | (1 << 7);

#[derive(Default)]
pub struct HpaonWakeup {
    enabled: u32,
}

impl HpaonWakeup {
    pub fn owns(address: u32) -> bool {
        address == WER
    }

    pub fn enabled(&self) -> u32 {
        self.enabled
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            WER => Ok(self.enabled),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address {
            WER if value & !EARLY_SOURCES == 0 => self.enabled = value,
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
