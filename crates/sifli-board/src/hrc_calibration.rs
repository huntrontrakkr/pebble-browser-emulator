//! SF32LB52 HRC48 calibration counter used by the pinned startup HAL.
//! Register layout and completion duration follow UM5201 V0.8.8. The nominal
//! equal-frequency result is a model assumption until measured on a watch.
use crate::FaultKind;

const HRCCAL1: u32 = 0x5000_0034;
const HRCCAL2: u32 = 0x5000_0038;
const CAL_EN: u32 = 1 << 30;
const CAL_DONE: u32 = 1 << 31;

pub struct HrcCalibration {
    control: u32,
    result: u32,
    remaining_reference_ticks: Option<u64>,
    pub measurements_completed: u32,
}

impl Default for HrcCalibration {
    fn default() -> Self {
        Self {
            control: 0x8000,
            result: 0,
            remaining_reference_ticks: None,
            measurements_completed: 0,
        }
    }
}

impl HrcCalibration {
    pub fn owns(address: u32) -> bool {
        matches!(address, HRCCAL1 | HRCCAL2)
    }

    pub fn done(&self) -> bool {
        self.control & CAL_DONE != 0
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            HRCCAL1 => Ok(self.control),
            HRCCAL2 => Ok(self.result),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address {
            HRCCAL1 if value & !(0xffff | CAL_EN | CAL_DONE) == 0 => {
                let was_enabled = self.control & CAL_EN != 0;
                self.control = value & (0xffff | CAL_EN);
                if !was_enabled && value & CAL_EN != 0 {
                    self.result = 0;
                    self.remaining_reference_ticks = Some((value & 0xffff).max(1) as u64);
                } else if value & CAL_EN == 0 {
                    self.remaining_reference_ticks = None;
                }
            }
            HRCCAL2 => return Err(FaultKind::UnmodeledMmio),
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }

    pub fn advance(&mut self, reference_ticks: u64, hrc_trim: u16) {
        let Some(remaining) = self.remaining_reference_ticks else {
            return;
        };
        if reference_ticks < remaining {
            self.remaining_reference_ticks = Some(remaining - reference_ticks);
            return;
        }

        let hxt_count = self.control & 0xffff;
        // The manual defines the counters but not the trim transfer function.
        // Center trim (the documented POR value) is represented as nominal
        // 48 MHz. Nearby values have a conservative monotonic one-count slope.
        let difference = i32::from(hrc_trim) - 0x200;
        let hrc_count = (hxt_count as i32 + difference).clamp(0, u16::MAX as i32) as u32;
        self.result = (hxt_count << 16) | hrc_count;
        self.control |= CAL_DONE;
        self.remaining_reference_ticks = None;
        self.measurements_completed += 1;
    }
}
