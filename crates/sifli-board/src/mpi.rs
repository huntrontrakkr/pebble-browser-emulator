//! MPI2 register-mode SPI subset, UM5201 V0.8.8 table 14-2.
//! Functional transfer timing follows configured serial clocks; no silicon timing claim.
//! Unsupported DMA, IRQ, command chaining, decryption, write/erase and bus modes fault.
use crate::{
    FaultKind,
    nor::{Effect, Nor},
};
use std::collections::VecDeque;
struct Pending {
    ticks: u64,
    bytes: Vec<u8>,
    effect: Effect,
    command: u8,
}
pub struct Mpi {
    regs: [u32; 34],
    rx: VecDeque<u8>,
    tx: VecDeque<u8>,
    pending: Option<Pending>,
    pub nor: Option<Nor>,
    slot: Vec<u8>,
    pub commands_completed: u64,
    pub otp_bytes_read: u64,
    pub last_command: Option<u8>,
}
impl Default for Mpi {
    fn default() -> Self {
        let mut regs = [0; 34];
        regs[2] = 2 << 22;
        regs[3] = 4;
        regs[16] = 0x020b;
        regs[21] = 8 << 10;
        Self {
            regs,
            rx: VecDeque::new(),
            tx: VecDeque::new(),
            pending: None,
            nor: None,
            slot: vec![],
            commands_completed: 0,
            otp_bytes_read: 0,
            last_command: None,
        }
    }
}
impl Mpi {
    pub fn owns(a: u32) -> bool {
        (0x50042000..0x50042100).contains(&a)
    }
    pub fn set_slot(&mut self, bytes: Vec<u8>) {
        self.slot = bytes;
    }
    pub fn configure(&mut self, jedec: u32, sr1: u32, sr2: u32) -> bool {
        let Some(nor) = Nor::new(jedec, sr1, sr2) else {
            return false;
        };
        self.nor = Some(nor);
        true
    }
    pub fn reset_controller(&mut self) {
        let nor = self.nor.take();
        let slot = std::mem::take(&mut self.slot);
        *self = Self {
            nor,
            slot,
            ..Self::default()
        };
    }
    pub fn advance(&mut self, ticks: u64) {
        let Some(p) = self.pending.as_mut() else {
            return;
        };
        p.ticks = p.ticks.saturating_sub(ticks);
        if p.ticks != 0 {
            return;
        }
        let p = self.pending.take().unwrap();
        self.nor.as_mut().unwrap().complete(p.effect);
        self.commands_completed += 1;
        self.last_command = Some(p.command);
        if p.command == 0x48 {
            self.otp_bytes_read += p.bytes.len() as u64;
        }
        self.rx.extend(p.bytes);
        self.regs[4] |= 1;
    }
    pub fn read(&mut self, a: u32, width: u8) -> Result<u32, FaultKind> {
        if !Self::owns(a) {
            return Err(FaultKind::Unmapped);
        }
        let o = a - 0x50042000;
        if o == 4 {
            if !matches!(width, 1 | 2 | 4) {
                return Err(FaultKind::InvalidWidth);
            }
            if self.rx.is_empty() {
                return Err(FaultKind::PeripheralNotReady);
            }
            let mut v = 0;
            // Last partial FIFO word is padded in its unused high lanes. No
            // further empty read is acknowledged as valid data.
            for i in 0..width {
                if let Some(b) = self.rx.pop_front() {
                    v |= (b as u32) << (i * 8);
                }
            }
            return Ok(v);
        }
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        match o {
            0x14 => Ok(0), // dedicated write-one-clear register reads zero
            0x10 => Ok(self.regs[4] | ((self.pending.is_some() as u32) << 31)),
            0x54 => Ok(((self.rx.is_empty() as u32) << 1)
                | self.regs[21]
                | ((self.tx.len() == 64) as u32) << 9),
            0x58 => Ok(1 << 25),
            0x00 | 0x08 | 0x0c | 0x18 | 0x1c | 0x20 | 0x24 | 0x28 | 0x40 | 0x44 | 0x48 | 0x78
            | 0x84 => Ok(self.regs[(o / 4) as usize]),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, width: u8, value: u32) -> Result<(), FaultKind> {
        if !Self::owns(a) {
            return Err(FaultKind::Unmapped);
        }
        let o = a - 0x50042000;
        if o == 4 {
            if !matches!(width, 1 | 2 | 4) {
                return Err(FaultKind::InvalidWidth);
            }
            if self.pending.is_some() || self.tx.len() + width as usize > 64 {
                return Err(FaultKind::PeripheralNotReady);
            }
            for i in 0..width {
                self.tx.push_back((value >> (i * 8)) as u8);
            }
            return Ok(());
        }
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        if o == 0x14 {
            self.regs[4] &= !(value & 0x39);
            return Ok(());
        }
        if o == 0x54 {
            if self.pending.is_some() {
                return Err(FaultKind::PeripheralNotReady);
            }
            self.regs[21] = value & 0x7c00;
            if value & 1 != 0 {
                self.rx.clear();
            }
            if value & 0x100 != 0 {
                self.tx.clear();
            }
            return Ok(());
        }
        if o == 0 && value & (1 << 31) != 0 {
            if value & !(0x80000001) != 0 {
                return Err(FaultKind::UnmodeledMmio);
            }
            self.regs[0] = value & 1;
            self.pending = None;
            self.rx.clear();
            self.tx.clear();
            self.regs[4] = 0;
            return Ok(());
        }
        if self.pending.is_some() {
            return Err(FaultKind::PeripheralNotReady);
        }
        match o {
            0x00 if value & !1 == 0 => self.regs[0] = value,
            0x0c => self.regs[3] = value & 255,
            0x18 => {
                self.start(value as u8)?;
                self.regs[6] = value & 255;
            }
            0x1c | 0x20 | 0x44 | 0x78 => self.regs[(o / 4) as usize] = value,
            0x24 => self.regs[9] = value & 0xfffff,
            0x28 => self.regs[10] = value & 0x3fffff,
            0x40 => self.regs[16] = value & 0xffff,
            0x48 => self.regs[18] = value & 0x1fffff,
            0x84 => self.regs[33] = value & 0xffff,
            0x58 if value == 1 << 25 => {}
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
    fn start(&mut self, cmd: u8) -> Result<(), FaultKind> {
        if self.regs[0] & 1 == 0 {
            return Err(FaultKind::PeripheralNotReady);
        }
        let c = self.regs[10];
        let write = c & (1 << 21) != 0;
        let dmode = (c >> 18) & 7;
        let address = (c >> 3) & 7;
        let asize = (c >> 6) & 3;
        let dummy = (c >> 13) & 31;
        let (has_address, data_mode, write_mode, dummy_expected) = match cmd {
            0x48 | 0x0b => (true, 1, false, 8),
            0x03 => (true, 1, false, 0),
            0x9f | 0x05 | 0x35 => (false, 1, false, 0),
            0x01 | 0x31 => (false, 1, true, 0),
            0x06 | 0x04 | 0x50 | 0x66 | 0x99 => (false, 0, false, 0),
            _ => return Err(FaultKind::UnsupportedFlashCommand),
        };
        if c & 7 != 1
            || (c >> 8) & 7 != 0
            || write != write_mode
            || dmode != data_mode
            || address != u32::from(has_address)
            || (has_address && asize != 2)
            || dummy != dummy_expected
        {
            return Err(FaultKind::UnsupportedFlashCommand);
        }
        let len = if dmode == 0 {
            0
        } else {
            (self.regs[9] + 1) as usize
        };
        if len > 64 || (!write && !self.rx.is_empty()) {
            return Err(FaultKind::PeripheralNotReady);
        }
        if write && self.tx.len() < len {
            return Err(FaultKind::PeripheralNotReady);
        }
        let tx: Vec<_> = if write {
            self.tx.iter().take(len).copied().collect()
        } else {
            vec![]
        };
        let nor = self.nor.as_ref().ok_or(FaultKind::MissingNorState)?;
        let (bytes, effect) = nor.prepare(cmd, self.regs[7] & 0xffffff, len, &tx, &self.slot)?;
        // FIFO writes are word-packed by the HAL, including a final partial word.
        if write {
            for _ in 0..len.div_ceil(4) * 4 {
                self.tx.pop_front();
            }
        }
        let clocks = 8 + if has_address { 24 } else { 0 } + dummy as u64 + len as u64 * 8;
        self.pending = Some(Pending {
            ticks: clocks * self.regs[3].max(1) as u64
                + if matches!(cmd, 0x01 | 0x31) { 3 } else { 0 },
            bytes,
            effect,
            command: cmd,
        });
        Ok(())
    }
}
