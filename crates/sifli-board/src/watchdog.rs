//! SF32LB52x WDT1 register and command subset.
//! Layout, reset values and command bytes follow UM5201 V0.8.8 section 9.5.
//! The application-entry probe uses the documented inactive reset state; a
//! real bootloader handoff may differ and still needs a physical capture.
use crate::FaultKind;

const BASE: u32 = 0x5009_4000;
const START: u32 = 0x76;
const STOP: u32 = 0x34;

pub struct Watchdog {
    reload0: u32,
    reload1: u32,
    control: u32,
    active: bool,
    interrupt: bool,
    write_protected: bool,
    reset_flag: bool,
    sync_flag: bool,
    pub starts: u64,
    pub stops: u64,
}

impl Default for Watchdog {
    fn default() -> Self {
        Self {
            reload0: 0x00ff_ffff,
            reload1: 0x00ff_ffff,
            control: 1 << 4,
            active: false,
            interrupt: false,
            write_protected: false,
            reset_flag: false,
            sync_flag: false,
            starts: 0,
            stops: 0,
        }
    }
}

impl Watchdog {
    pub fn owns(address: u32) -> bool {
        (BASE..=BASE + 0x1c).contains(&address) && address & 3 == 0
    }

    pub fn active(&self) -> bool {
        self.active
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            BASE => Ok(self.reload0),
            a if a == BASE + 4 => Ok(self.reload1),
            a if a == BASE + 8 => Ok(self.control),
            a if a == BASE + 0x0c => Ok(0),
            a if a == BASE + 0x10 => Ok(0),
            a if a == BASE + 0x14 => Ok((self.active as u32) << 1 | self.interrupt as u32),
            a if a == BASE + 0x18 => Ok((self.write_protected as u32) << 31),
            a if a == BASE + 0x1c => {
                Ok((self.sync_flag as u32) << 3 | (self.reset_flag as u32) << 1)
            }
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        if self.write_protected && address != BASE + 0x18 {
            return Err(FaultKind::PeripheralNotReady);
        }
        match address {
            BASE if value <= 0x00ff_ffff => self.reload0 = value,
            a if a == BASE + 4 && value <= 0x00ff_ffff => self.reload1 = value,
            a if a == BASE + 8 && value & !0x17 == 0 => self.control = value,
            a if a == BASE + 0x0c && value == START => {
                self.active = true;
                self.interrupt = false;
                self.sync_flag = true;
                self.starts += 1;
            }
            a if a == BASE + 0x0c && value == STOP => {
                self.active = false;
                self.interrupt = false;
                self.sync_flag = true;
                self.stops += 1;
            }
            a if a == BASE + 0x10 && value & !1 == 0 => {
                if value & 1 != 0 {
                    self.interrupt = false;
                    self.sync_flag = true;
                }
            }
            a if a == BASE + 0x18 && value == 0x58ab_99fc => self.write_protected = true,
            a if a == BASE + 0x18 && value == 0x51ff_8621 => self.write_protected = false,
            a if a == BASE + 0x1c && value & !5 == 0 => {
                if value & 1 != 0 {
                    self.reset_flag = false;
                }
                if value & 4 != 0 {
                    self.sync_flag = false;
                }
            }
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
