//! HPSYS configuration fields used during early PebbleOS startup.
//! Unknown system controls remain unavailable because their reset and power
//! effects are not represented by this diagnostic board.
use crate::FaultKind;

pub struct SystemConfig {
    syscr: u32,
    security: u32,
    ulpmcr: u32,
    cau2_cr: u32,
    usart1_pinr: u32,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            syscr: 0,
            security: 1,
            ulpmcr: 0x0013_0213,
            cau2_cr: 0,
            usart1_pinr: 0,
        }
    }
}

impl SystemConfig {
    pub fn owns(address: u32) -> bool {
        matches!(
            address,
            0x5000_b00c | 0x5000_b010 | 0x5000_b01c | 0x5000_b058 | 0x5000_b094
        )
    }

    pub fn watchdog_reboots_chip(&self) -> bool {
        self.syscr & 1 != 0
    }

    /// USART1 TXD/RXD/RTS/CTS pad selections, as written to USART1_PINR.
    pub fn usart1_pins(&self) -> [u32; 4] {
        [0, 8, 16, 24].map(|shift| (self.usart1_pinr >> shift) & 0x3f)
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address {
            0x5000_b010 => Ok(self.syscr),
            0x5000_b00c => Ok(self.security),
            0x5000_b01c => Ok(self.ulpmcr),
            0x5000_b058 => Ok(self.usart1_pinr),
            0x5000_b094 => Ok(self.cau2_cr),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address {
            // WDT1_REBOOT is the only accepted field. SD-NAND selection and
            // LDO voltage switching need their own hardware effects.
            0x5000_b010 if value & !1 == 0 => self.syscr = value,
            0x5000_b00c if value & !1 == 0 => self.security = value,
            // Startup selects one of the documented SRAM/ROM retention
            // configurations. These fields affect no modeled memory timing.
            0x5000_b01c if value & !0x4013_1ff3 == 0 => self.ulpmcr = value,
            // DLL startup powers the high-performance bandgap. Analog trim
            // controls remain unsupported.
            // USART1_PINR routes TXD/RXD/RTS/CTS to pads. Each field is six
            // bits; this records the selection without modelling the pads.
            0x5000_b058 if value & !0x3f3f_3f3f == 0 => self.usart1_pinr = value,
            0x5000_b094 if value & !3 == 0 => self.cau2_cr = value,
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
