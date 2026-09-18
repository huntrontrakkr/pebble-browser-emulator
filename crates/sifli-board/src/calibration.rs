//! PMUC factory trim latches (UM5201 table 3-3). This models digital calibration
//! fields, not measured analog voltages, regulator dynamics or readiness timing.
//! Identity has no default: it must be supplied, like the matching EFUSE bank.
use crate::FaultKind;
pub struct Calibration {
    pub chip_id: Option<u32>,
    pub vret: u32,
    pub aon_bg: u32,
    pub buck: u32,
    pub peri_ldo: u32,
    pub hp_vout: u32,
    pub lp_vout: u32,
}
impl Default for Calibration {
    fn default() -> Self {
        Self {
            chip_id: None,
            vret: (0x20 << 16) | (7 << 10) | (7 << 2) | 1,
            aon_bg: 3 << 3,
            buck: (1 << 31)
                | (3 << 28)
                | (4 << 17)
                | (2 << 15)
                | (1 << 13)
                | (4 << 9)
                | (4 << 6)
                | 1,
            peri_ldo: (6 << 17) | (6 << 9) | (12 << 1),
            hp_vout: 11,
            lp_vout: 5,
        }
    }
}
impl Calibration {
    pub fn owns(a: u32) -> bool {
        matches!(
            a,
            0x5000b004
                | 0x500ca014
                | 0x500ca024
                | 0x500ca02c
                | 0x500ca05c
                | 0x500ca094
                | 0x500ca098
        )
    }
    pub fn read(&self, a: u32) -> Result<u32, FaultKind> {
        match a {
            0x5000b004 => self.chip_id.ok_or(FaultKind::MissingChipIdentity),
            0x500ca014 => Ok(self.vret),
            0x500ca024 => Ok(self.aon_bg),
            0x500ca02c => Ok(self.buck),
            0x500ca05c => Ok(self.peri_ldo),
            0x500ca094 => Ok(self.hp_vout),
            0x500ca098 => Ok(self.lp_vout),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, v: u32) -> Result<(), FaultKind> {
        let (r, mask, ro) = match a {
            0x500ca014 => (&mut self.vret, 0x3c00, 1 << 31),
            0x500ca024 => (&mut self.aon_bg, 0x27, 0),
            0x500ca02c => (&mut self.buck, 0x4e000000, 1 << 31),
            0x500ca05c => (&mut self.peri_ldo, 0x1e1e1e, 0),
            0x500ca094 => (&mut self.hp_vout, 15, 0),
            0x500ca098 => (&mut self.lp_vout, 15, 0),
            _ => return Err(FaultKind::UnmodeledMmio),
        };
        // Power mode/enable fields need their device state machines. A factory
        // trim write may only alter the supported fields; preserve read-only bits.
        if (v ^ *r) & !(mask | ro) != 0 {
            return Err(FaultKind::UnmodeledMmio);
        }
        *r = (*r & !mask) | (v & mask);
        Ok(())
    }
}
