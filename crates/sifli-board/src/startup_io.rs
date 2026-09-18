//! Bounded early-boot register behavior from UM5201 V0.8.8 tables 2-6, 5-4, 9-7.
//! This is a power-on register contract, not a measured bootloader handoff.
//! Unknown registers and unavailable gated peripherals remain explicit errors.
use crate::FaultKind;

pub struct StartupIo {
    pub clock: crate::clock::BootClock,
    pub lcpu: crate::lcpu_reset::LcpuReset,
    pub efuse: crate::efuse::Efuse,
    rstr1: u32,
    rstr2: u32,
    enr2: u32,
    pub mpi: crate::mpi::Mpi,
    pub calibration: crate::calibration::Calibration,
    issr: u32,
    pub backup: [u32; 10],
    pub enr1: u32,
    pub pa21: u32,
}
impl Default for StartupIo {
    fn default() -> Self {
        Self {
            clock: crate::clock::BootClock::default(),
            lcpu: crate::lcpu_reset::LcpuReset::default(),
            efuse: crate::efuse::Efuse::default(),
            rstr1: 0,
            rstr2: 0,
            enr2: 0x02401107,
            mpi: crate::mpi::Mpi::default(),
            calibration: crate::calibration::Calibration::default(),
            issr: 0x30,
            backup: [0; 10],
            enr1: 0x18c7fc17,
            pa21: 0x2d0,
        }
    }
}
impl StartupIo {
    pub fn advance(&mut self, cycles: u64) {
        if self.enr1 & (1 << 11) != 0 && self.rstr1 & (1 << 11) == 0 {
            let pdiv = 1 << ((self.clock.read(0x50000024).unwrap() >> 8) & 7);
            self.efuse.advance(cycles, pdiv);
        }
        let before = self.clock.reference_ticks;
        self.clock.advance(cycles);
        if let Some(nor) = self.mpi.nor.as_mut() {
            nor.advance(self.clock.reference_ticks - before);
        }
        if self.enr2 & 4 != 0 && self.rstr2 & 4 == 0 {
            self.mpi.advance(self.clock.reference_ticks - before);
        }
    }
    pub fn owns(a: u32) -> bool {
        crate::mpi::Mpi::owns(a)
            || crate::calibration::Calibration::owns(a)
            || crate::efuse::Efuse::owns(a)
            || crate::lcpu_reset::LcpuReset::owns(a)
            || crate::clock::BootClock::owns(a)
            || (0x500cb030..0x500cb058).contains(&a)
            || matches!(
                a,
                0x50000004
                    | 0x5000000c
                    | 0x50000014
                    | 0x5000001c
                    | 0x500ca094
                    | 0x50000000
                    | 0x50000008
                    | 0x50000010
                    | 0x50000018
                    | 0x500c002c
                    | 0x50003088
            )
    }
    pub fn read(&mut self, a: u32, width: u8) -> Result<u32, FaultKind> {
        if crate::mpi::Mpi::owns(a) {
            if self.enr2 & 4 == 0 || self.rstr2 & 4 != 0 {
                return Err(FaultKind::PeripheralNotReady);
            }
            return self.mpi.read(a, width);
        }
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        if crate::calibration::Calibration::owns(a) {
            return self.calibration.read(a);
        }
        if crate::clock::BootClock::owns(a) {
            return self.clock.read(a);
        }
        if crate::lcpu_reset::LcpuReset::owns(a) {
            return self.lcpu.read(a);
        }
        if crate::efuse::Efuse::owns(a) {
            if self.enr1 & (1 << 11) == 0 || self.rstr1 & (1 << 11) != 0 {
                return Err(FaultKind::UnmodeledMmio);
            }
            return self.efuse.read(a);
        }
        match a {
            0x50000000 => Ok(self.rstr1),
            0x50000004 => Ok(self.rstr2),
            0x5000000c => Ok(self.enr2),
            0x500cb030..=0x500cb054 => Ok(self.backup[((a - 0x500cb030) / 4) as usize]),
            0x50000008 => Ok(self.enr1),
            0x500c002c => Ok(self.issr),
            0x50003088 if self.enr1 & 4 != 0 => Ok(self.pa21),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, width: u8, value: u32) -> Result<(), FaultKind> {
        if crate::mpi::Mpi::owns(a) {
            if self.enr2 & 4 == 0 || self.rstr2 & 4 != 0 {
                return Err(FaultKind::PeripheralNotReady);
            }
            return self.mpi.write(a, width, value);
        }
        if width != 4 || a & 3 != 0 {
            return Err(FaultKind::InvalidWidth);
        }
        if crate::calibration::Calibration::owns(a) {
            return self.calibration.write(a, value);
        }
        if crate::clock::BootClock::owns(a) {
            return self.clock.write(a, value);
        }
        if crate::lcpu_reset::LcpuReset::owns(a) {
            return self.lcpu.write(a, value);
        }
        if crate::efuse::Efuse::owns(a) {
            if self.enr1 & (1 << 11) == 0 || self.rstr1 & (1 << 11) != 0 {
                return Err(FaultKind::UnmodeledMmio);
            }
            return self.efuse.write(a, value);
        }
        const MASK: u32 = 0x9af7fdf7;
        match a {
            0x50000004 if value & !4 == 0 => {
                if value & 4 != 0 {
                    self.mpi.reset_controller();
                }
                self.rstr2 = value;
            }
            0x5000000c if (value ^ self.enr2) & !4 == 0 => self.enr2 = value,
            0x50000014 if value & !4 == 0 => self.enr2 |= value,
            0x5000001c if value & !4 == 0 => self.enr2 &= !value,
            0x50000000 => {
                // Reset only the implemented controller. Other domains need
                // their own reset effects; never acknowledge an inert reset.
                if value & !(1 << 11) != 0 {
                    return Err(FaultKind::UnmodeledMmio);
                }
                if value & (1 << 11) != 0 {
                    self.efuse.reset();
                }
                self.rstr1 = value;
            }
            0x500cb030..=0x500cb054 => self.backup[((a - 0x500cb030) / 4) as usize] = value,
            0x500c002c => {
                if value & 0x10 == 0 {
                    return Err(FaultKind::UnmodeledMmio);
                }
                self.issr = (self.issr & !0x11) | (value & 0x11);
            }
            0x50000008 => self.enr1 = value & MASK,
            0x50000010 => self.enr1 |= value & MASK,
            0x50000018 => self.enr1 &= !(value & MASK),
            0x50003088 if self.enr1 & 4 != 0 => self.pa21 = value & 0x7ff,
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
