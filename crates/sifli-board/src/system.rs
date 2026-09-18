//! STAR-MC1 architectural startup subset. Register layouts: pinned SiFli CMSIS.
//! Twelve MPU regions: pinned Pebble SystemInit. Reset entry values are explicit
//! model assumptions, not captured bootloader state. Unknown registers fail.
use crate::{FaultKind, Operation};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Policy {
    Device,
    Uncached,
    WriteThrough,
    WriteBack,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Maintenance {
    None,
    InstructionAll,
    InstructionAddress(u32),
    Data {
        value: u32,
        by_set: bool,
        clean: bool,
        invalidate: bool,
    },
}

pub struct SystemControl {
    pub vtor: u32,
    pub cpacr: u32,
    pub shcsr: u32,
    pub ccr: u32,
    pub ctrl: u32,
    pub rnr: u32,
    pub regions: [(u32, u32); 12],
    pub mair: [u32; 2],
    csselr: u32,
}

impl Default for SystemControl {
    fn default() -> Self {
        Self {
            vtor: 0x12021000,
            cpacr: 0,
            shcsr: 0,
            ccr: 0x200,
            ctrl: 0,
            rnr: 0,
            regions: [(0, 0); 12],
            mair: [0; 2],
            csselr: 0,
        }
    }
}
impl SystemControl {
    fn region_index(&self, a: u32) -> usize {
        if a <= 0xe000eda0 {
            self.rnr as usize
        } else {
            (self.rnr as usize & !3) | (((a - 0xe000eda4) / 8 + 1) as usize)
        }
    }
    pub fn read(&self, a: u32, width: u8, privileged: bool) -> Result<u32, FaultKind> {
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        if !privileged {
            return Err(FaultKind::MemoryProtection);
        }
        Ok(match a {
            0xe000ed08 => self.vtor,
            0xe000ed14 => self.ccr,
            0xe000ed24 => self.shcsr,
            // 32-byte lines; published 16 KiB/4-way D, 32 KiB/2-way I.
            // Allocation/policy flags describe the functional model, not a
            // captured silicon CCSIDR identification value.
            0xe000ed80 => {
                if self.csselr == 0 {
                    0xf0000000 | (127 << 13) | (3 << 3) | 1
                } else {
                    0x20000000 | (511 << 13) | (1 << 3) | 1
                }
            }
            0xe000ed84 => self.csselr,
            0xe000ed88 => self.cpacr,
            0xe000ed90 => 12 << 8,
            0xe000ed94 => self.ctrl,
            0xe000ed98 => self.rnr,
            0xe000ed9c | 0xe000eda4 | 0xe000edac | 0xe000edb4 => {
                self.regions[self.region_index(a)].0
            }
            0xe000eda0 | 0xe000eda8 | 0xe000edb0 | 0xe000edb8 => {
                self.regions[self.region_index(a)].1
            }
            0xe000edc0 => self.mair[0],
            0xe000edc4 => self.mair[1],
            _ => return Err(FaultKind::UnsupportedSystemRegister),
        })
    }
    pub fn write(
        &mut self,
        a: u32,
        width: u8,
        value: u32,
        privileged: bool,
    ) -> Result<Maintenance, FaultKind> {
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        if !privileged {
            return Err(FaultKind::MemoryProtection);
        }
        match a {
            0xe000ed08 => self.vtor = value & !0x7f,
            0xe000ed14 => {
                // Do not accept unimplemented trap/security semantics.
                if value & !0x30200 != 0 {
                    return Err(FaultKind::UnsupportedSystemRegister);
                }
                self.ccr = value;
            }
            0xe000ed24 => {
                if value & !0x70000 != 0 {
                    return Err(FaultKind::UnsupportedSystemRegister);
                }
                self.shcsr = value;
            }
            0xe000ed84 if value <= 1 => self.csselr = value,
            0xe000ed88 => self.cpacr = value & 0x00f0003f,
            0xe000ed94 => self.ctrl = value & 7,
            0xe000ed98 if value < 12 => self.rnr = value,
            0xe000ed9c | 0xe000eda4 | 0xe000edac | 0xe000edb4 => {
                let i = self.region_index(a);
                self.regions[i].0 = value;
            }
            0xe000eda0 | 0xe000eda8 | 0xe000edb0 | 0xe000edb8 => {
                let i = self.region_index(a);
                self.regions[i].1 = value & !0x10;
            }
            0xe000edc0 => self.mair[0] = value,
            0xe000edc4 => self.mair[1] = value,
            0xe000ef50 => return Ok(Maintenance::InstructionAll),
            0xe000ef58 => return Ok(Maintenance::InstructionAddress(value)),
            0xe000ef5c | 0xe000ef60 | 0xe000ef64 | 0xe000ef68 | 0xe000ef6c | 0xe000ef70
            | 0xe000ef74 => {
                return Ok(Maintenance::Data {
                    value,
                    by_set: matches!(a, 0xe000ef60 | 0xe000ef6c | 0xe000ef74),
                    clean: a >= 0xe000ef64,
                    invalidate: matches!(a, 0xe000ef5c | 0xe000ef60 | 0xe000ef70 | 0xe000ef74),
                });
            }
            _ => return Err(FaultKind::UnsupportedSystemRegister),
        }
        Ok(Maintenance::None)
    }

    pub fn access(
        &self,
        address: u32,
        width: u8,
        operation: Operation,
        privileged: bool,
    ) -> Result<Policy, FaultKind> {
        if !matches!(width, 1 | 2 | 4) {
            return Err(FaultKind::InvalidWidth);
        }
        let mut policy = None;
        for offset in 0..width {
            let a = address
                .checked_add(offset as u32)
                .ok_or(FaultKind::MemoryProtection)?;
            let p = self.byte_policy(a, operation, privileged)?;
            if policy.is_some_and(|old| old != p) {
                return Err(FaultKind::UnsupportedMemoryAttribute);
            }
            policy = Some(p);
        }
        Ok(policy.unwrap())
    }
    fn byte_policy(&self, a: u32, op: Operation, privileged: bool) -> Result<Policy, FaultKind> {
        if a >= 0xe0000000 {
            return if privileged && op != Operation::Fetch {
                Ok(Policy::Device)
            } else {
                Err(FaultKind::MemoryProtection)
            };
        }
        let mut selected = None;
        if self.ctrl & 1 != 0 {
            for &(base, limit) in &self.regions {
                if limit & 1 != 0 && a >= base & !31 && a <= limit | 31 {
                    if selected.is_some() {
                        return Err(FaultKind::MemoryProtection);
                    }
                    selected = Some((base, limit));
                }
            }
        }
        let p = if let Some((base, limit)) = selected {
            let ap = (base >> 1) & 3;
            if (!privileged && ap & 1 == 0)
                || (op == Operation::Write && ap & 2 != 0)
                || (op == Operation::Fetch && base & 1 != 0)
            {
                return Err(FaultKind::MemoryProtection);
            }
            let index = ((limit >> 1) & 7) as usize;
            let attr = ((self.mair[index / 4] >> (index % 4 * 8)) & 0xff) as u8;
            match attr {
                0x00 | 0x04 | 0x08 | 0x0c => Policy::Device,
                0x44 => Policy::Uncached,
                0x22 => Policy::WriteThrough,
                0xff => Policy::WriteBack,
                _ => return Err(FaultKind::UnsupportedMemoryAttribute),
            }
        } else {
            if self.ctrl & 1 != 0 && (!privileged || self.ctrl & 4 == 0) {
                return Err(FaultKind::MemoryProtection);
            }
            match a {
                0..=0x1fffffff => Policy::WriteThrough,
                0x20000000..=0x3fffffff => Policy::WriteBack,
                0x60000000..=0x7fffffff => Policy::WriteBack,
                0x80000000..=0x9fffffff => Policy::WriteThrough,
                _ => Policy::Device,
            }
        };
        if p == Policy::Device && (op == Operation::Fetch) {
            return Err(FaultKind::MemoryProtection);
        }
        // The first 128 KiB is DTCM and bypasses the data cache, including
        // when its background memory attributes are cacheable.
        Ok(if (0x20000000..0x20020000).contains(&a) {
            Policy::Uncached
        } else {
            p
        })
    }
}
