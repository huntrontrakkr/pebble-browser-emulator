//! Bounded W25Q128JV SPI read/volatile-status profile. It is explicitly selected
//! by the caller, not asserted to be the flash fitted to a physical watch.
//! Firmware slot bytes and factory security-register bytes remain separate.
use crate::FaultKind;
#[derive(Clone)]
pub enum Effect {
    None,
    WriteEnable,
    WriteDisable,
    VolatileEnable,
    Status(u8, u8),
    ResetEnable,
    Reset,
}
pub struct Nor {
    pub status: [u8; 2],
    power_on_status: [u8; 2],
    wel: bool,
    volatile_enable: bool,
    reset_enable: bool,
    reset_ticks: u64,
    otp: [Option<[u8; 256]>; 3],
}
impl Nor {
    /// JEDEC uses on-wire order: EF 40 18. No other part is silently aliased.
    pub fn new(jedec: u32, sr1: u32, sr2: u32) -> Option<Self> {
        if jedec != 0xef4018 || sr1 & !0xfc != 0 || sr2 & !0x7b != 0 {
            return None;
        }
        Some(Self {
            status: [sr1 as u8, sr2 as u8],
            power_on_status: [sr1 as u8, sr2 as u8],
            wel: false,
            volatile_enable: false,
            reset_enable: false,
            reset_ticks: 0,
            otp: [None; 3],
        })
    }
    pub fn advance(&mut self, ticks: u64) {
        self.reset_ticks = self.reset_ticks.saturating_sub(ticks);
    }
    pub fn supply(&mut self, page: u32, data: [u8; 256]) -> bool {
        if !(1..=3).contains(&page) {
            return false;
        }
        self.otp[(page - 1) as usize] = Some(data);
        true
    }
    pub fn otp_mask(&self) -> u32 {
        self.otp
            .iter()
            .enumerate()
            .fold(0, |m, (i, p)| m | ((p.is_some() as u32) << i))
    }
    pub fn prepare(
        &self,
        cmd: u8,
        address: u32,
        len: usize,
        tx: &[u8],
        slot: &[u8],
    ) -> Result<(Vec<u8>, Effect), FaultKind> {
        if len > 64 {
            return Err(FaultKind::InvalidOperation);
        }
        if self.reset_ticks != 0 {
            return Err(FaultKind::PeripheralNotReady);
        }
        let bad = FaultKind::UnsupportedFlashCommand;
        Ok(match cmd {
            0x9f if len == 3 => (vec![0xef, 0x40, 0x18], Effect::None),
            0x05 => (
                vec![self.status[0] | ((self.wel as u8) << 1); len],
                Effect::None,
            ),
            0x35 => (vec![self.status[1]; len], Effect::None),
            0x06 => (vec![], Effect::WriteEnable),
            0x04 => (vec![], Effect::WriteDisable),
            0x50 => (vec![], Effect::VolatileEnable),
            0x01 | 0x31 => {
                if !self.volatile_enable
                    || (cmd == 0x01 && !(1..=2).contains(&tx.len()))
                    || (cmd == 0x31 && tx.len() != 1)
                {
                    return Err(bad);
                }
                let lo = if cmd == 0x01 {
                    tx[0] & 0xfc
                } else {
                    self.status[0]
                };
                let hi = if cmd == 0x31 {
                    tx[0]
                } else if tx.len() == 2 {
                    tx[1]
                } else {
                    self.status[1]
                };
                // Do not emulate programming OTP lock bits through a volatile write.
                if (lo ^ self.status[0]) & 0x80 != 0
                    || (hi ^ self.status[1]) & !0x42 != 0
                    || self.status[1] & 1 != 0
                {
                    return Err(bad);
                }
                (vec![], Effect::Status(lo, hi))
            }
            0x48 => {
                if address & !0x30ff != 0 || address >> 12 == 0 {
                    return Err(bad);
                }
                let page = (address >> 12) - 1;
                let bytes = self.otp[page as usize]
                    .as_ref()
                    .ok_or(FaultKind::MissingFlashOtp)?;
                (
                    (0..len)
                        .map(|i| bytes[(address as usize + i) & 255])
                        .collect(),
                    Effect::None,
                )
            }
            0x03 | 0x0b => {
                let start = address
                    .checked_sub(0x20000)
                    .ok_or(FaultKind::MissingQspi2)? as usize;
                let bytes = slot
                    .get(start..start + len)
                    .ok_or(FaultKind::MissingQspi2)?;
                (bytes.to_vec(), Effect::None)
            }
            0x66 => (vec![], Effect::ResetEnable),
            0x99 if self.reset_enable => (vec![], Effect::Reset),
            _ => return Err(bad),
        })
    }
    pub fn complete(&mut self, e: Effect) {
        let armed = matches!(e, Effect::ResetEnable);
        match e {
            Effect::None => {}
            Effect::WriteEnable => self.wel = true,
            Effect::WriteDisable => {
                self.wel = false;
                self.volatile_enable = false;
            }
            Effect::VolatileEnable => self.volatile_enable = true,
            Effect::Status(a, b) => {
                self.status = [a, b];
                self.volatile_enable = false;
                self.wel = false;
            }
            Effect::ResetEnable => {}
            Effect::Reset => {
                self.reset_ticks = 1440; // datasheet approximate 30us at nominal 48MHz
                self.status = self.power_on_status;
                self.wel = false;
                self.volatile_enable = false;
            }
        }
        self.reset_enable = armed;
    }
}
