//! Read-only factory-data controller, UM5201 V0.8.8 table 13-4.
//! Register reset values are documented; OTP contents must be supplied separately.
//! Transfer timing uses an explicit functional estimate (512 + THRCK PCLK ticks).
//! Programming and IRQ mode are unsupported, never silently acknowledged.
use crate::FaultKind;
pub struct Efuse {
    banks: [Option<[u8; 32]>; 4],
    latched: [[u32; 8]; 4],
    cr: u32,
    timr: u32,
    done: bool,
    pending: Option<(usize, u64)>,
    remainder: u64,
    pub reads_completed: u64,
}
impl Default for Efuse {
    fn default() -> Self {
        Self {
            banks: [None; 4],
            latched: [[0; 8]; 4],
            cr: 0,
            timr: (0x78 << 10) | 6,
            done: false,
            pending: None,
            remainder: 0,
            reads_completed: 0,
        }
    }
}
impl Efuse {
    pub fn owns(a: u32) -> bool {
        (0x5000c000..0x5000c0b0).contains(&a)
    }
    pub fn loaded_mask(&self) -> u32 {
        self.banks
            .iter()
            .enumerate()
            .fold(0, |mask, (i, b)| mask | ((b.is_some() as u32) << i))
    }
    pub fn supply(&mut self, bank: usize, bytes: [u8; 32]) -> bool {
        if bank >= 4 || self.pending.is_some() {
            return false;
        }
        self.banks[bank] = Some(bytes);
        true
    }
    pub fn reset(&mut self) {
        // Reset register/controller state, never erase persistent OTP.
        let banks = self.banks;
        *self = Self {
            banks,
            ..Self::default()
        };
    }
    pub fn advance(&mut self, core_cycles: u64, pdiv: u32) {
        let Some((bank, remaining)) = self.pending else {
            return;
        };
        let total = self.remainder + core_cycles;
        let ticks = total / pdiv as u64;
        self.remainder = total % pdiv as u64;
        if ticks < remaining {
            self.pending = Some((bank, remaining - ticks));
            return;
        }
        let bytes = self.banks[bank]
            .as_ref()
            .expect("pending read has supplied data");
        for (i, w) in self.latched[bank].iter_mut().enumerate() {
            *w = u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        }
        self.pending = None;
        self.cr &= !1;
        self.done = true;
        self.reads_completed += 1;
    }
    pub fn read(&self, a: u32) -> Result<u32, FaultKind> {
        match a {
            0x5000c000 => Ok(self.cr),
            0x5000c004 => Ok(self.timr),
            0x5000c008 => Ok(self.done as u32),
            0x5000c030..=0x5000c0ac if a & 3 == 0 => {
                let word = ((a - 0x5000c030) / 4) as usize;
                Ok(self.latched[word / 8][word % 8]) // documented DATA latch reset=0
            }
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, value: u32) -> Result<(), FaultKind> {
        match a {
            0x5000c000 => {
                if value & 0x12 != 0 || self.pending.is_some() {
                    return Err(FaultKind::UnmodeledMmio);
                }
                let bank = ((value >> 2) & 3) as usize;
                if value & 1 != 0 {
                    if self.banks[bank].is_none() {
                        return Err(FaultKind::MissingFactoryCalibration);
                    }
                    self.pending = Some((bank, 512 + (self.timr & 0x7f) as u64));
                    self.remainder = 0;
                }
                self.cr = value & 0xd;
            }
            0x5000c004 if self.pending.is_none() => self.timr = value & 0x1fffff,
            0x5000c008 => {
                if value & 1 != 0 {
                    self.done = false;
                }
            }
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
