//! Original, deterministic emulator foundation. This is NOT yet a PebbleOS-capable CPU.
//! The diagnostic machine intentionally has its own profile and MMIO contract.
pub mod protocol;

use serde::{Deserialize, Serialize};

pub const WIDTH: usize = 200;
pub const HEIGHT: usize = 228;
pub const RAM_BASE: u32 = 0x2000_0000;
pub const RAM_SIZE: usize = 512 * 1024;
pub const FRAME_BASE: u32 = 0x5000_0000;
const N: u32 = 1 << 31;
const Z: u32 = 1 << 30;
const C: u32 = 1 << 29;
const V: u32 = 1 << 28;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Machine {
    pub registers: [u32; 16],
    pub xpsr: u32,
    pub instructions: u64,
    pub halted: bool,
    pub fault: Option<String>,
    flash: Vec<u8>,
    ram: Vec<u8>,
    pub framebuffer: Vec<u8>,
    pub buttons: u32,
    pub battery: u32,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            registers: [0; 16],
            xpsr: 1 << 24,
            instructions: 0,
            halted: true,
            fault: None,
            flash: Vec::new(),
            ram: vec![0; RAM_SIZE],
            framebuffer: vec![0xc0; WIDTH * HEIGHT],
            buttons: 0,
            battery: 100,
        }
    }
}

impl Machine {
    /// Load a diagnostic-profile raw vector-table image. Production firmware is not supported.
    pub fn load(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() < 10 || bytes.len() > 4 * 1024 * 1024 {
            return Err("Image must be between 10 bytes and 4 MiB".into());
        }
        let sp = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let reset = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if sp < RAM_BASE || sp > RAM_BASE + RAM_SIZE as u32 || sp & 3 != 0 {
            return Err("Initial stack pointer is outside diagnostic SRAM or unaligned".into());
        }
        if reset & 1 == 0 || (reset & !1) < 8 || (reset & !1) as usize > bytes.len() - 2 {
            return Err("Reset vector must point to Thumb code inside this image".into());
        }
        *self = Self::default();
        self.flash = bytes.to_vec();
        self.registers[13] = sp;
        self.registers[15] = reset & !1;
        self.halted = false;
        Ok(())
    }

    pub fn reset(&mut self) -> Result<(), String> {
        self.load(&self.flash.clone())
    }

    pub fn load_diagnostic(&mut self) {
        // Reset handler at 0x08; literal pool at 0x1c. Generated from the documented
        // Thumb encodings; checked with independent ARM execution by verify-reference.py.
        let words: [u16; 10] = [
            0x4804, 0x4905, 0x22c0, 0x7002, 0x3001, 0x3201, 0x3901, 0xd1fa, 0xbe00, 0xbf00,
        ];
        let mut bytes = Vec::from((RAM_BASE + RAM_SIZE as u32).to_le_bytes());
        bytes.extend_from_slice(&9_u32.to_le_bytes());
        for word in words {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.extend_from_slice(&FRAME_BASE.to_le_bytes());
        bytes.extend_from_slice(&((WIDTH * HEIGHT) as u32).to_le_bytes());
        self.load(&bytes)
            .expect("built-in diagnostic must be valid");
    }

    pub fn read8(&self, address: u32) -> Result<u8, String> {
        if let Some(v) = self.flash.get(address as usize) {
            return Ok(*v);
        }
        if let Some(offset) = address.checked_sub(RAM_BASE)
            && let Some(v) = self.ram.get(offset as usize)
        {
            return Ok(*v);
        }
        if let Some(offset) = address.checked_sub(FRAME_BASE)
            && let Some(v) = self.framebuffer.get(offset as usize)
        {
            return Ok(*v);
        }
        let value = match address & !3 {
            0x4000_0000 => Some(self.buttons),
            0x4000_0004 => Some(self.battery),
            _ => None,
        };
        if let Some(value) = value {
            return Ok((value >> ((address & 3) * 8)) as u8);
        }
        Err(format!("Unmapped read at 0x{address:08x}"))
    }

    pub fn read16(&self, address: u32) -> Result<u16, String> {
        if address & 1 != 0 {
            return Err(format!("Unaligned halfword read at 0x{address:08x}"));
        }
        Ok(u16::from_le_bytes([
            self.read8(address)?,
            self.read8(address.wrapping_add(1))?,
        ]))
    }

    pub fn read32(&self, address: u32) -> Result<u32, String> {
        if address & 3 != 0 {
            return Err(format!("Unaligned word read at 0x{address:08x}"));
        }
        Ok(u32::from_le_bytes([
            self.read8(address)?,
            self.read8(address.wrapping_add(1))?,
            self.read8(address.wrapping_add(2))?,
            self.read8(address.wrapping_add(3))?,
        ]))
    }

    pub fn write8(&mut self, address: u32, value: u8) -> Result<(), String> {
        if let Some(offset) = address.checked_sub(RAM_BASE)
            && let Some(v) = self.ram.get_mut(offset as usize)
        {
            *v = value;
            return Ok(());
        }
        if let Some(offset) = address.checked_sub(FRAME_BASE)
            && let Some(v) = self.framebuffer.get_mut(offset as usize)
        {
            *v = value;
            return Ok(());
        }
        Err(format!("Unmapped or read-only write at 0x{address:08x}"))
    }

    pub fn write32(&mut self, address: u32, value: u32) -> Result<(), String> {
        if address & 3 != 0 {
            return Err(format!("Unaligned word write at 0x{address:08x}"));
        }
        // Check the complete range before modifying memory.
        let valid = address
            .checked_sub(RAM_BASE)
            .is_some_and(|o| (o as usize) <= RAM_SIZE - 4)
            || address
                .checked_sub(FRAME_BASE)
                .is_some_and(|o| (o as usize) <= WIDTH * HEIGHT - 4);
        if !valid {
            return Err(format!(
                "Unmapped or read-only word write at 0x{address:08x}"
            ));
        }
        for (i, byte) in value.to_le_bytes().iter().enumerate() {
            self.write8(address + i as u32, *byte)?;
        }
        Ok(())
    }

    fn nz(&mut self, value: u32) {
        self.xpsr = (self.xpsr & !(N | Z)) | (value & N) | if value == 0 { Z } else { 0 };
    }

    fn add(&mut self, a: u32, b: u32, carry: bool) -> u32 {
        let wide = a as u64 + b as u64 + u64::from(carry);
        let result = wide as u32;
        let signed = a as i32 as i64 + b as i32 as i64 + i64::from(carry);
        self.xpsr = (self.xpsr & !(C | V))
            | if wide > u32::MAX as u64 { C } else { 0 }
            | if signed > i32::MAX as i64 || signed < i32::MIN as i64 {
                V
            } else {
                0
            };
        self.nz(result);
        result
    }

    fn condition(&self, code: u16) -> bool {
        let (n, z, c, v) = (
            self.xpsr & N != 0,
            self.xpsr & Z != 0,
            self.xpsr & C != 0,
            self.xpsr & V != 0,
        );
        match code {
            0 => z,
            1 => !z,
            2 => c,
            3 => !c,
            4 => n,
            5 => !n,
            6 => v,
            7 => !v,
            8 => c && !z,
            9 => !c || z,
            10 => n == v,
            11 => n != v,
            12 => !z && n == v,
            13 => z || n != v,
            _ => false,
        }
    }

    pub fn step(&mut self) -> Result<(), String> {
        if self.halted {
            return Ok(());
        }
        let pc = self.registers[15];
        let result = if self.instructions >= 9_007_199_254_740_991 {
            Err("Diagnostic instruction counter limit reached".into())
        } else {
            self.execute(pc)
        };
        if let Err(error) = &result {
            self.halted = true;
            self.fault = Some(format!("PC 0x{pc:08x}: {error}"));
            self.registers[15] = pc;
        } else {
            self.instructions += 1;
        }
        result
    }

    fn execute(&mut self, pc: u32) -> Result<(), String> {
        let op = self.read16(pc)?;
        let next = pc.wrapping_add(2);
        self.registers[15] = next;
        let rd = (op & 7) as usize;
        let rn = ((op >> 3) & 7) as usize;
        if op & 0xf800 == 0x2000 {
            // MOVS immediate
            let r = ((op >> 8) & 7) as usize;
            self.registers[r] = (op & 255) as u32;
            self.nz(self.registers[r]);
        } else if op & 0xf800 == 0x2800 {
            // CMP immediate
            self.add(
                self.registers[((op >> 8) & 7) as usize],
                !((op & 255) as u32),
                true,
            );
        } else if op & 0xf800 == 0x3000 || op & 0xf800 == 0x3800 {
            let r = ((op >> 8) & 7) as usize;
            let b = (op & 255) as u32;
            self.registers[r] = if op & 0x0800 == 0 {
                self.add(self.registers[r], b, false)
            } else {
                self.add(self.registers[r], !b, true)
            };
        } else if op & 0xf800 == 0x1800 {
            // ADD/SUB register or imm3
            let b = if op & 0x0400 != 0 {
                ((op >> 6) & 7) as u32
            } else {
                self.registers[((op >> 6) & 7) as usize]
            };
            self.registers[rd] = if op & 0x0200 == 0 {
                self.add(self.registers[rn], b, false)
            } else {
                self.add(self.registers[rn], !b, true)
            };
        } else if op & 0xf800 == 0x4800 {
            // PC-relative LDR
            let address = (pc.wrapping_add(4) & !3).wrapping_add(((op & 255) as u32) * 4);
            self.registers[((op >> 8) & 7) as usize] = self.read32(address)?;
        } else if op & 0xe000 == 0x6000 {
            // LDR/STR word/byte immediate
            let byte = op & 0x1000 != 0;
            let load = op & 0x0800 != 0;
            let offset = ((op >> 6) & 31) as u32 * if byte { 1 } else { 4 };
            let address = self.registers[rn].wrapping_add(offset);
            match (load, byte) {
                (true, true) => self.registers[rd] = self.read8(address)? as u32,
                (true, false) => self.registers[rd] = self.read32(address)?,
                (false, true) => self.write8(address, self.registers[rd] as u8)?,
                (false, false) => self.write32(address, self.registers[rd])?,
            }
        } else if op & 0xf000 == 0xd000 && (op >> 8) & 15 < 14 {
            if self.condition((op >> 8) & 15) {
                self.registers[15] = pc
                    .wrapping_add(4)
                    .wrapping_add(((op as u8 as i8 as i32) * 2) as u32);
            }
        } else if op & 0xf800 == 0xe000 {
            let offset = (((op & 0x7ff) as i32) << 21) >> 20;
            self.registers[15] = pc.wrapping_add(4).wrapping_add(offset as u32);
        } else if op & 0xff00 == 0xbe00 {
            self.halted = true;
        } else if op == 0xbf00 { // NOP
        } else {
            return Err(format!(
                "Unsupported instruction 0x{op:04x}; this profile implements a diagnostic Thumb subset"
            ));
        }
        Ok(())
    }

    pub fn run(&mut self, budget: u32) -> u32 {
        let mut executed = 0;
        for _ in 0..budget.min(1_000_000) {
            if self.halted || self.step().is_err() {
                break;
            }
            executed += 1;
        }
        executed
    }

    pub fn snapshot(&self) -> String {
        serde_json::to_string(self).expect("serializable machine")
    }

    pub fn restore(&mut self, snapshot: &str) -> Result<(), String> {
        if snapshot.len() > 24 * 1024 * 1024 {
            return Err("Snapshot too large".into());
        }
        let other: Self = serde_json::from_str(snapshot).map_err(|e| e.to_string())?;
        if other.ram.len() != RAM_SIZE
            || other.framebuffer.len() != WIDTH * HEIGHT
            || other.flash.len() > 4 * 1024 * 1024
            || other.battery > 100
            || other.buttons > 15
            || other.instructions > 9_007_199_254_740_991
        {
            return Err("Snapshot does not match diagnostic profile".into());
        }
        *self = other;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn program(words: &[u16]) -> Machine {
        let mut bytes = Vec::from((RAM_BASE + RAM_SIZE as u32).to_le_bytes());
        bytes.extend_from_slice(&9_u32.to_le_bytes());
        for w in words {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        let mut m = Machine::default();
        m.load(&bytes).unwrap();
        m
    }
    #[test]
    fn diagnostic_writes_all_pixels() {
        let mut m = Machine::default();
        m.load_diagnostic();
        m.run(300_000);
        assert!(m.halted);
        assert_eq!(m.fault, None);
        assert_eq!(m.instructions, 228004);
        for (i, pixel) in m.framebuffer.iter().enumerate() {
            assert_eq!(*pixel, 0xc0_u8.wrapping_add(i as u8));
        }
    }
    #[test]
    fn subtraction_sets_borrow_and_zero() {
        let mut m = program(&[0x2000, 0x3801, 0x3001, 0xbe00]);
        m.step().unwrap();
        m.step().unwrap();
        assert_eq!(m.registers[0], u32::MAX);
        assert_eq!(m.xpsr & (C | N | Z), N);
        m.step().unwrap();
        assert_eq!(m.registers[0], 0);
        assert_eq!(m.xpsr & (C | N | Z), C | Z);
    }
    #[test]
    fn signed_overflow_is_independent_of_carry() {
        let mut m = Machine::default();
        assert_eq!(m.add(0x7fff_ffff, 1, false), 0x8000_0000);
        assert_eq!(m.xpsr & (C | V | N | Z), V | N);
    }
    #[test]
    fn branch_uses_architectural_pc_plus_four() {
        let mut m = program(&[0x2002, 0x3801, 0xd1fd, 0xbe00]);
        m.run(20);
        assert_eq!(m.registers[0], 0);
        assert_eq!(m.instructions, 6);
        assert!(m.halted);
    }
    #[test]
    fn unknown_instruction_stops_at_faulting_pc() {
        let mut m = program(&[0xffff, 0xbe00]);
        assert!(m.step().is_err());
        assert_eq!(m.registers[15], 8);
        assert_eq!(m.instructions, 0);
        assert!(m.halted);
    }
    #[test]
    fn invalid_image_is_transactional() {
        let mut m = program(&[0x2001, 0xbe00]);
        let before = m.clone();
        assert!(m.load(&[0; 16]).is_err());
        assert_eq!(m, before);
    }
    #[test]
    fn unmapped_and_readonly_access_is_rejected() {
        let mut m = Machine::default();
        assert!(m.read32(0xdead_beec).is_err());
        assert!(m.write32(0, 42).is_err());
        assert!(m.write32(RAM_BASE + 1, 42).is_err());
        assert!(m.write32(RAM_BASE + RAM_SIZE as u32 - 2, 42).is_err());
        m.write32(RAM_BASE, 0x12345678).unwrap();
        assert_eq!(m.read32(RAM_BASE).unwrap(), 0x12345678);
    }
    #[test]
    fn snapshot_replays_identically() {
        let mut a = Machine::default();
        a.load_diagnostic();
        a.run(1234);
        let mut b = Machine::default();
        b.restore(&a.snapshot()).unwrap();
        a.run(300_000);
        b.run(300_000);
        assert_eq!(a, b);
    }
}
