//! Functional DWT cycle/CPI counters for early HAL busy waits. Counts use the
//! execution engine's estimates, never measured STAR-MC1 cycles. No trace output.
//! Layouts follow pinned CMSIS core_cm33.h. Reset-disabled state is assumed.
use crate::FaultKind;
#[derive(Default)]
pub struct DebugCounter {
    ctrl: u32,
    demcr: u32,
    cycles: u32,
    cpi: u8,
}
impl DebugCounter {
    pub fn owns(a: u32) -> bool {
        matches!(
            a,
            0xe0001000 | 0xe0001004 | 0xe0001008 | 0xe000edfc | 0xe000e010
        )
    }
    pub fn advance(&mut self, estimated_cycles: u64) {
        if self.demcr & (1 << 24) == 0 {
            return;
        }
        // Probe executes secure code; CYCDISS suppresses its CYCCNT updates.
        if self.ctrl & 0x800001 == 1 {
            self.cycles = self.cycles.wrapping_add(estimated_cycles as u32);
        }
        if self.ctrl & (1 << 17) != 0 {
            self.cpi = self
                .cpi
                .wrapping_add(estimated_cycles.saturating_sub(1) as u8);
        }
    }
    pub fn read(&self, a: u32, width: u8) -> Result<u32, FaultKind> {
        if width != 4 {
            return Err(FaultKind::InvalidWidth);
        }
        match a {
            0xe0001000 => Ok(self.ctrl),
            0xe0001004 => Ok(self.cycles),
            0xe0001008 => Ok(self.cpi as u32),
            0xe000edfc => Ok(self.demcr),
            // Only the assumed disabled reset state is supported. Any attempt
            // to configure SysTick fails until timer/exception routing exists.
            0xe000e010 => Ok(0),
            _ => Err(FaultKind::UnsupportedSystemRegister),
        }
    }
    pub fn write(&mut self, a: u32, width: u8, value: u32) -> Result<(), FaultKind> {
        if width != 4 {
            return Err(FaultKind::InvalidWidth);
        }
        match a {
            0xe0001000 if value & !0x820001 == 0 => self.ctrl = value,
            0xe0001004 => self.cycles = value,
            0xe0001008 => self.cpi = value as u8,
            0xe000edfc if value & !(1 << 24) == 0 => self.demcr = value,
            _ => return Err(FaultKind::UnsupportedSystemRegister),
        }
        Ok(())
    }
}
