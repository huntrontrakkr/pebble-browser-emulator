//! PMUC low-power oscillator subset used by unchanged PebbleOS startup.
//! Digital fields follow UM5201 V0.8.8 table 3-3 and the pinned SiFli HAL.
//! Readiness delay and nominal oscillator rates are explicit model assumptions,
//! not physical calibration data.
use crate::FaultKind;

const LRC32_EN: u32 = 1;
const LRC32_RDY: u32 = 1 << 31;
const LRC32_WRITABLE: u32 = 0x3ff;

pub struct PmucClock {
    cr: u32,
    wer: u32,
    lrc32_cr: u32,
    hxt_cr1: u32,
    hrc_cr: u32,
    buck_cr2: u32,
    aon_ldo: u32,
    hpsys_ldo: u32,
    lpsys_ldo: u32,
    hpsys_swr: u32,
    lpsys_swr: u32,
    hxt_cr3: u32,
    wakeup_count: u32,
    power_key_count: u32,
    elapsed_ticks: u64,
    pub lrc32_startup_ticks: Option<u64>,
}

impl Default for PmucClock {
    fn default() -> Self {
        Self {
            cr: 0,
            wer: 0,
            // RSEL reset value is 6; RC32K starts disabled.
            lrc32_cr: 6 << 6,
            hxt_cr1: (0x1ca << 20)
                | (1 << 19)
                | (3 << 17)
                | (0xa << 13)
                | (1 << 11)
                | (1 << 9)
                | (1 << 6)
                | (1 << 3)
                | 7,
            hrc_cr: (2 << 26)
                | (1 << 25)
                | (2 << 21)
                | (1 << 20)
                | (1 << 15)
                | (0x200 << 5)
                | (0xa << 1)
                | 1,
            buck_cr2: (4 << 28) | (3 << 24) | (0xa << 20),
            aon_ldo: (1 << 4) | 6,
            hpsys_ldo: (8 << 10) | (5 << 2) | 1,
            lpsys_ldo: (8 << 10) | (7 << 2) | 1,
            hpsys_swr: (3 << 4) | (1 << 2) | 2,
            lpsys_swr: (3 << 4) | (1 << 2) | 2,
            hxt_cr3: (31 << 4) | (1 << 2) | 1,
            wakeup_count: u32::MAX,
            power_key_count: 0x186a << 4,
            elapsed_ticks: 0,
            // One millisecond at the nominal 48 MHz reference is assumed.
            lrc32_startup_ticks: Some(48_000),
        }
    }
}

impl PmucClock {
    pub fn owns(address: u32) -> bool {
        matches!(
            address,
            0x500c_a000
                | 0x500c_a004
                | 0x500c_a01c
                | 0x500c_a028
                | 0x500c_a030
                | 0x500c_a04c
                | 0x500c_a050
                | 0x500c_a054
                | 0x500c_a058
                | 0x500c_a068
                | 0x500c_a070
                | 0x500c_a074
                | 0x500c_a08c
                | 0x500c_a090
        )
    }

    pub fn lrc32_ready(&self) -> bool {
        self.lrc32_cr & LRC32_EN != 0
            && self
                .lrc32_startup_ticks
                .is_some_and(|delay| self.elapsed_ticks >= delay)
    }

    pub fn low_power_hz(&self) -> u32 {
        if self.cr & 1 != 0 { 32_000 } else { 10_000 }
    }

    pub fn hrc_trim(&self) -> u16 {
        ((self.hrc_cr >> 5) & 0x3ff) as u16
    }

    pub fn advance(&mut self, reference_ticks: u64) {
        if self.lrc32_cr & LRC32_EN != 0 && !self.lrc32_ready() {
            self.elapsed_ticks = self.elapsed_ticks.saturating_add(reference_ticks);
        }
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            0x500c_a000 => Ok(self.cr),
            0x500c_a004 => Ok(self.wer),
            0x500c_a01c => Ok(self.lrc32_cr | if self.lrc32_ready() { LRC32_RDY } else { 0 }),
            0x500c_a068 => Ok(self.hxt_cr1),
            0x500c_a074 => Ok(self.hrc_cr),
            0x500c_a028 => Ok(self.aon_ldo),
            0x500c_a030 => Ok(self.buck_cr2),
            0x500c_a04c => Ok(self.hpsys_ldo),
            0x500c_a050 => Ok(self.lpsys_ldo),
            0x500c_a054 => Ok(self.hpsys_swr),
            0x500c_a058 => Ok(self.lpsys_swr),
            0x500c_a070 => Ok(self.hxt_cr3),
            0x500c_a08c => Ok(self.wakeup_count),
            0x500c_a090 => Ok(self.power_key_count),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address {
            0x500c_a01c if value & !(LRC32_WRITABLE | LRC32_RDY) == 0 => {
                let was_enabled = self.lrc32_cr & LRC32_EN != 0;
                self.lrc32_cr = value & LRC32_WRITABLE;
                if !was_enabled && self.lrc32_cr & LRC32_EN != 0 {
                    self.elapsed_ticks = 0;
                }
                if self.lrc32_cr & LRC32_EN == 0 {
                    self.elapsed_ticks = 0;
                }
            }
            // PebbleOS only changes SEL_LPCLK here. Hibernate, reboot, pin
            // retention and wake-pin fields require separate state machines.
            0x500c_a000 if value & !1 == 0 => {
                if value & 1 != 0 && !self.lrc32_ready() {
                    return Err(FaultKind::PeripheralNotReady);
                }
                self.cr = value;
            }
            // RTC, WDT1/2, two wake pins, low-battery and charger are the
            // documented writable wake-enable sources on SF32LB52x.
            0x500c_a004 if value & !0x19f == 0 => self.wer = value,
            // Early startup only enables the documented DLL buffer. Preserve
            // the analog reset configuration without claiming DLL lock.
            0x500c_a068 if (value ^ self.hxt_cr1) & !(1 << 5) == 0 => self.hxt_cr1 = value,
            // Calibration selects both counter taps and changes FREQ_TRIM.
            // Other analog HRC controls retain their documented POR values.
            0x500c_a074 if (value ^ self.hrc_cr) & !((3 << 26) | (3 << 21) | (0x3ff << 5)) == 0 => {
                self.hrc_cr = value
            }
            0x500c_a030 if (value ^ self.buck_cr2) & !0x0f00_ffff == 0 => self.buck_cr2 = value,
            0x500c_a028 if value & !0x7f == 0 => self.aon_ldo = value,
            0x500c_a04c if (value ^ self.hpsys_ldo) & !(0x3f << 10) == 0 => self.hpsys_ldo = value,
            0x500c_a050 if (value ^ self.lpsys_ldo) & !(0x3f << 10) == 0 => self.lpsys_ldo = value,
            0x500c_a054 if (value ^ self.hpsys_swr) & !(7 << 4) == 0 => self.hpsys_swr = value,
            0x500c_a058 if (value ^ self.lpsys_swr) & !(7 << 4) == 0 => self.lpsys_swr = value,
            0x500c_a070 if (value ^ self.hxt_cr3) & !(0x3f << 4) == 0 => self.hxt_cr3 = value,
            0x500c_a08c => self.wakeup_count = value,
            0x500c_a090 if value & !0x000f_fff0 == 0 => self.power_key_count = value,
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
