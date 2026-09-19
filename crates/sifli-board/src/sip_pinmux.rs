//! SF32LB52 SiP-memory pad controls used by PebbleOS early power setup.
//! Reset pulls follow UM5201 V0.8.8 table 5-4. Only the HAL analog transition
//! is accepted; electrical pad behavior is outside this execution probe.
use crate::FaultKind;

const BASE: u32 = 0x5000_3000;
const COUNT: usize = 13;
const ANALOG_CHANGE_MASK: u32 = 0x5f;

pub struct SipPinmux {
    pads: [u32; COUNT],
    pub analog_transitions: u32,
}

impl Default for SipPinmux {
    fn default() -> Self {
        // DS0, Schmitt input and input/pull enables are the common POR state;
        // PS varies with the package signal's documented default pull.
        let mut pads = [0x2d0; COUNT];
        for index in [1, 4, 5, 6, 8, 11] {
            pads[index] |= 1 << 5;
        }
        Self {
            pads,
            analog_transitions: 0,
        }
    }
}

impl SipPinmux {
    pub fn owns(address: u32) -> bool {
        (BASE..BASE + COUNT as u32 * 4).contains(&address)
    }

    fn index(address: u32) -> Result<usize, FaultKind> {
        if !Self::owns(address) {
            return Err(FaultKind::UnmodeledMmio);
        }
        Ok(((address - BASE) / 4) as usize)
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        Ok(self.pads[Self::index(address)?])
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        let index = Self::index(address)?;
        let expected = (self.pads[index] & !ANALOG_CHANGE_MASK) | 0xf;
        if value != expected {
            return Err(FaultKind::UnmodeledMmio);
        }
        if value != self.pads[index] {
            self.analog_transitions += 1;
        }
        self.pads[index] = value;
        Ok(())
    }
}
