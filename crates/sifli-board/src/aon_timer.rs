//! SF32LB52x always-on global timer subset used during HCPU startup.
//! Register layout and enable/synchronization sequence follow UM5201 V0.8.8
//! section 4.3 and the pinned SiFli HAL. The counter follows the selected
//! low-power clock; oscillator frequencies remain uncalibrated nominal values.
use crate::FaultKind;

const GTIM_EN: u32 = 1 << 31;
const REFERENCE_HZ: u64 = 48_000_000;

#[derive(Default)]
pub struct AonGlobalTimer {
    hp_cr1: u32,
    lp_cr1: u32,
    hp_count: u32,
    lp_count: u32,
    hp_remainder: u64,
    lp_remainder: u64,
    pub sync_writes: u64,
}

impl AonGlobalTimer {
    pub fn owns(address: u32) -> bool {
        matches!(
            address,
            0x4004_0004 | 0x4004_0048 | 0x500c_0004 | 0x500c_0034
        )
    }

    pub fn enabled(&self) -> (bool, bool) {
        (self.hp_cr1 & GTIM_EN != 0, self.lp_cr1 & GTIM_EN != 0)
    }

    pub fn counters(&self) -> (u32, u32) {
        (self.hp_count, self.lp_count)
    }

    pub fn advance(&mut self, reference_ticks: u64, low_power_hz: u32) {
        let scaled = reference_ticks.saturating_mul(u64::from(low_power_hz));
        if self.hp_cr1 & GTIM_EN != 0 {
            let ticks = self.hp_remainder.saturating_add(scaled);
            self.hp_count = self.hp_count.wrapping_add((ticks / REFERENCE_HZ) as u32);
            self.hp_remainder = ticks % REFERENCE_HZ;
        }
        if self.lp_cr1 & GTIM_EN != 0 {
            let ticks = self.lp_remainder.saturating_add(scaled);
            self.lp_count = self.lp_count.wrapping_add((ticks / REFERENCE_HZ) as u32);
            self.lp_remainder = ticks % REFERENCE_HZ;
        }
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            0x4004_0004 => Ok(self.lp_cr1),
            0x4004_0048 => Ok(self.lp_count),
            0x500c_0004 => Ok(self.hp_cr1),
            0x500c_0034 => Ok(self.hp_count),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address {
            // Wake-pin modes and output selection have separate behavior. Do
            // not accept them merely because they share the control register.
            0x4004_0004 if value & !GTIM_EN == 0 => self.lp_cr1 = value,
            0x500c_0004 if value & !GTIM_EN == 0 => self.hp_cr1 = value,
            // The pinned HAL writes one after enabling both domains to align
            // HPSYS with the LPSYS counter. Other command values are unknown.
            0x500c_0034 if value == 1 && self.enabled() == (true, true) => {
                self.hp_count = self.lp_count;
                self.hp_remainder = self.lp_remainder;
                self.sync_writes += 1;
            }
            0x4004_0048 | 0x500c_0034 => return Err(FaultKind::UnmodeledMmio),
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
