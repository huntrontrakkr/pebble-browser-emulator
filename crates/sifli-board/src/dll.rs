//! SF32LB52 high-speed DLL controls used by the HCPU DVFS startup path.
//! Fields and the minimum five-microsecond lock time come from UM5201 V0.8.8.
//! The precise analog lock response remains unverified on physical hardware.
use crate::FaultKind;

const DLL1CR: u32 = 0x5000_002c;
const DLL2CR: u32 = 0x5000_0030;
const ENABLE: u32 = 1;
const READY: u32 = 1 << 31;
const WRITABLE: u32 = 0x7fff_ffff;
const RESET: u32 =
    (1 << 16) | (1 << 15) | (1 << 14) | (1 << 13) | (1 << 12) | (0xa << 8) | (1 << 6);

pub struct Dll {
    control: [u32; 2],
    elapsed: [u64; 2],
    pub lock_ticks: Option<u64>,
    pub locks_completed: u32,
}

impl Default for Dll {
    fn default() -> Self {
        Self {
            control: [RESET; 2],
            elapsed: [0; 2],
            // Manual requires at least 5 us; reference clock is nominal 48 MHz.
            lock_ticks: Some(240),
            locks_completed: 0,
        }
    }
}

impl Dll {
    pub fn owns(address: u32) -> bool {
        matches!(address, DLL1CR | DLL2CR)
    }

    fn index(address: u32) -> Result<usize, FaultKind> {
        match address {
            DLL1CR => Ok(0),
            DLL2CR => Ok(1),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    fn ready(&self, index: usize) -> bool {
        self.control[index] & ENABLE != 0
            && self
                .lock_ticks
                .is_some_and(|delay| self.elapsed[index] >= delay)
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        let index = Self::index(address)?;
        Ok(self.control[index] | if self.ready(index) { READY } else { 0 })
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        let index = Self::index(address)?;
        if value & !WRITABLE != 0 {
            return Err(FaultKind::UnmodeledMmio);
        }
        let was_ready = self.ready(index);
        let was_enabled = self.control[index] & ENABLE != 0;
        self.control[index] = value & WRITABLE;
        if !was_enabled && value & ENABLE != 0 {
            self.elapsed[index] = 0;
        }
        if value & ENABLE == 0 {
            self.elapsed[index] = 0;
        }
        if was_ready && !self.ready(index) {
            // A register reconfiguration starts a new lock interval.
            self.elapsed[index] = 0;
        }
        Ok(())
    }

    pub fn advance(&mut self, reference_ticks: u64) {
        for index in 0..2 {
            let was_ready = self.ready(index);
            if self.control[index] & ENABLE != 0 && !was_ready {
                self.elapsed[index] = self.elapsed[index].saturating_add(reference_ticks);
                if self.ready(index) {
                    self.locks_completed += 1;
                }
            }
        }
    }

    pub fn dll1_ready(&self) -> bool {
        self.ready(0)
    }
}
