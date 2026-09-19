//! Deterministic early-boot clocks. Engine cycles are estimates, not STAR-MC1 timing.
//! Register fields: UM5201 V0.8.8 tables 2-6/4-3. Default HXT settling (1ms)
//! is a configurable model assumption, not a captured oscillator measurement.
use crate::FaultKind;

pub struct BootClock {
    pub estimated_cycles: u64,
    pub reference_ticks: u64,
    pub hxt_startup_ticks: Option<u64>,
    hxt_started: u64,
    acr: u32,
    csr: u32,
    cfgr: u32,
    deep_wfi_cfgr: u32,
}
impl Default for BootClock {
    fn default() -> Self {
        Self {
            estimated_cycles: 0,
            reference_ticks: 0,
            hxt_startup_ticks: Some(48_000),
            hxt_started: 0,
            acr: 7,
            csr: 0x1000,
            cfgr: 0x24101,
            deep_wfi_cfgr: (1 << 18) | (1 << 15) | (1 << 12) | (1 << 8) | 1,
        }
    }
}
impl BootClock {
    pub fn owns(a: u32) -> bool {
        matches!(a, 0x50000020 | 0x50000024 | 0x50000044 | 0x500c0010)
    }
    pub fn advance(&mut self, cycles: u64) {
        self.estimated_cycles = self.estimated_cycles.wrapping_add(cycles);
        // Only nominal 48MHz HRC/HXT sources are accepted. Reference ticks
        // continue at 48MHz when HCLK is divided.
        self.reference_ticks = self
            .reference_ticks
            .saturating_add(cycles.saturating_mul((self.cfgr & 255).max(1) as u64));
    }
    pub fn hxt_ready(&self) -> bool {
        self.acr & 2 != 0
            && self
                .hxt_startup_ticks
                .is_some_and(|delay| self.reference_ticks.saturating_sub(self.hxt_started) >= delay)
    }
    pub fn read(&self, a: u32) -> Result<u32, FaultKind> {
        match a {
            0x500c0010 => Ok(self.acr | ((self.acr & 1) << 30) | ((self.hxt_ready() as u32) << 31)),
            0x50000020 => Ok(self.csr),
            0x50000024 => Ok(self.cfgr),
            0x50000044 => Ok(self.deep_wfi_cfgr),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, value: u32) -> Result<(), FaultKind> {
        match a {
            0x500c0010 => {
                // Do not pretend to support power-down, debug power, or
                // disabling the currently executing clock source.
                if value & 0xc != 4
                    || (self.csr & 3 == 0 && value & 1 == 0)
                    || (self.csr & 3 == 1 && value & 2 == 0)
                {
                    return Err(FaultKind::UnmodeledMmio);
                }
                if self.acr & 2 == 0 && value & 2 != 0 {
                    self.hxt_started = self.reference_ticks;
                }
                self.acr = value & 7;
            }
            0x50000020 => {
                self.write_csr(value, false)?;
            }
            0x50000024 => self.cfgr = value & 0x3f77ff,
            0x50000044 if value & !0x0f07_f7ff == 0 => self.deep_wfi_cfgr = value,
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }

    pub fn write_csr(&mut self, value: u32, dll1_ready: bool) -> Result<(), FaultKind> {
        let value = value & 0xf0f7;
        if value & !0x1003 != 0 {
            return Err(FaultKind::UnmodeledMmio);
        }
        match value & 3 {
            0 if self.acr & 1 != 0 => {}
            1 if self.hxt_ready() => {}
            3 if dll1_ready => {}
            _ => return Err(FaultKind::PeripheralNotReady),
        }
        self.csr = value;
        Ok(())
    }
}
