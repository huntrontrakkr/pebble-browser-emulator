//! HCPU-facing LCPU reset controls, from pinned SF32LB52x AON/RCC headers.
//! Entry assumes an active domain awaiting reset, no CPUWAIT and no sleep request.
//! This is not captured bootloader state and does not execute LCPU instructions.
use crate::FaultKind;
#[derive(Default)]
pub struct LcpuReset {
    cpuwait: bool,
    resets: u32,
    pub reset_assertions: u64,
    pub reset_releases: u64,
}
impl LcpuReset {
    pub const MASK: u32 = 0x003d877f;
    pub fn owns(a: u32) -> bool {
        matches!(a, 0x40040000 | 0x40040040 | 0x40000000)
    }
    pub fn halted(&self) -> bool {
        self.cpuwait
    }
    pub fn asserted(&self) -> u32 {
        self.resets
    }
    pub fn read(&self, a: u32) -> Result<u32, FaultKind> {
        match a {
            0x40040000 => Ok(if self.cpuwait { 4 } else { 0 }),
            // Explicit active-domain entry contract. Sleep is not supported.
            0x40040040 => Ok(0),
            0x40000000 => Ok(self.resets),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }
    pub fn write(&mut self, a: u32, value: u32) -> Result<(), FaultKind> {
        match a {
            0x40040000 if value == 4 => self.cpuwait = true,
            // Releasing the CPU would require its ROM, RAM and execution core.
            0x40040000 => return Err(FaultKind::MissingLcpuState),
            0x40000000 if self.cpuwait => {
                let next = value & Self::MASK;
                if next & 1 != 0 && self.resets & 1 == 0 {
                    self.reset_assertions += 1;
                }
                if next & 1 == 0 && self.resets & 1 != 0 {
                    self.reset_releases += 1;
                }
                self.resets = next;
            }
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
