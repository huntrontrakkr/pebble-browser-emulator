//! Profiles for the public generic Pebble QEMU boards, not physical MCU models.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CpuProfile {
    CortexM4,
    CortexM33,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BoardProfile {
    pub id: u32,
    pub name: &'static str,
    pub cpu: CpuProfile,
    pub cpuid: u32,
    pub ram_bytes: usize,
    pub width: usize,
    pub height: usize,
    pub guest_bpp: u32,
    pub round: bool,
    pub touch: bool,
    pub audio: bool,
}
impl BoardProfile {
    pub const FLINT: Self = Self {
        id: 1,
        name: "qemu_flint",
        cpu: CpuProfile::CortexM4,
        cpuid: 0x410f_c240,
        ram_bytes: 256 * 1024,
        width: 144,
        height: 168,
        guest_bpp: 1,
        round: false,
        touch: false,
        audio: true,
    };
    pub const EMERY: Self = Self {
        id: 2,
        name: "qemu_emery",
        cpu: CpuProfile::CortexM33,
        cpuid: 0x410f_d213,
        ram_bytes: 512 * 1024,
        width: 200,
        height: 228,
        guest_bpp: 8,
        round: false,
        touch: true,
        audio: true,
    };
    pub const GABBRO: Self = Self {
        id: 3,
        name: "qemu_gabbro",
        cpu: CpuProfile::CortexM33,
        cpuid: 0x410f_d213,
        ram_bytes: 512 * 1024,
        width: 260,
        height: 260,
        guest_bpp: 8,
        round: true,
        touch: true,
        audio: false,
    };
    pub fn from_id(id: u32) -> Option<Self> {
        match id {
            1 => Some(Self::FLINT),
            2 => Some(Self::EMERY),
            3 => Some(Self::GABBRO),
            _ => None,
        }
    }
    pub fn features(self) -> u32 {
        self.touch as u32 | ((self.audio as u32) << 1) | ((self.round as u32) << 2)
    }
    pub fn guest_stride(self) -> usize {
        if self.guest_bpp == 1 {
            self.width.div_ceil(32) * 4
        } else {
            self.width
        }
    }
    pub fn guest_frame_len(self) -> usize {
        self.guest_stride() * self.height
    }
    pub fn frame_len(self) -> usize {
        self.width * self.height
    }
}
