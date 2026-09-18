//! Bounded early-boot register behavior from UM5201 V0.8.8 tables 2-6, 5-4, 9-7.
//! This is a power-on register contract, not a measured bootloader handoff.
//! Unknown registers and unavailable gated peripherals remain explicit errors.
use crate::FaultKind;

pub struct StartupIo {
    pub backup: [u32; 10],
    pub enr1: u32,
    pub pa21: u32,
}
impl Default for StartupIo {
    fn default() -> Self {
        Self {
            backup: [0; 10],
            enr1: 0x18c7fc17,
            pa21: 0x2d0,
        }
    }
}
impl StartupIo {
    pub fn owns(a: u32) -> bool {
        (0x500cb030..0x500cb058).contains(&a)
            || matches!(
                a,
                0x50000008 | 0x50000010 | 0x50000018 | 0x50000020 | 0x50003088
            )
    }
    pub fn read(&self, a: u32, width: u8) -> Result<u32, FaultKind> {
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        match a {
            0x500cb030..=0x500cb054 => Ok(self.backup[((a - 0x500cb030) / 4) as usize]),
            0x50000008 => Ok(self.enr1),
            // POR selection: HRC48 system clock, HXT48 peripheral clock.
            // Switching/ready sequencing is intentionally not implemented here.
            0x50000020 => Ok(0x1000),
            0x50003088 if self.enr1 & 4 != 0 => Ok(self.pa21),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, width: u8, value: u32) -> Result<(), FaultKind> {
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        const MASK: u32 = 0x9af7fdf7;
        match a {
            0x500cb030..=0x500cb054 => self.backup[((a - 0x500cb030) / 4) as usize] = value,
            0x50000008 => self.enr1 = value & MASK,
            0x50000010 => self.enr1 |= value & MASK,
            0x50000018 => self.enr1 &= !(value & MASK),
            0x50003088 if self.enr1 & 4 != 0 => self.pa21 = value & 0x7ff,
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
