//! Original deterministic models of the published generic Pebble QEMU register contracts.
//! Functional bring-up model; timing has not been validated against hardware.
use crate::profile::BoardProfile;
use std::collections::VecDeque;
#[derive(Default)]
pub struct Uart {
    pub ctrl: u32,
    pub pending: u32,
    pub rx: VecDeque<u8>,
    pub tx: Vec<u8>,
}
#[derive(Default, Clone, Copy)]
pub struct Timer {
    pub load: u32,
    pub ctrl: u32,
    pub pending: u32,
    pub divider: u32,
    pub started: u64,
}
/// Generic QEMU speaker registers and FIFO. The virtual-time drain follows
/// the pinned Pebble QEMU device with its rate-limited `driver=none` sink.
pub struct Audio {
    pub ctrl: u32,
    pub samplerate: u32,
    pub intctrl: u32,
    pub intstat: u32,
    pub volume: u32,
    pub ring: Vec<u8>,
    pub ring_read: u32,
    pub ring_write: u32,
    pub ring_count: u32,
    pub running: bool,
    pub stopping: bool,
    pub started: u64,
    pub next_drain: u64,
    pub active_rate: u32,
    pub samples_sent: u64,
}
impl Default for Audio {
    fn default() -> Self {
        Self {
            ctrl: 0,
            samplerate: 16000,
            intctrl: 0,
            intstat: 0,
            volume: 100,
            ring: vec![0; 4096 * 2],
            ring_read: 0,
            ring_write: 0,
            ring_count: 0,
            running: false,
            stopping: false,
            started: 0,
            next_drain: 0,
            active_rate: 0,
            samples_sent: 0,
        }
    }
}
impl Audio {
    const CAPACITY: u32 = 4096;
    const INTERVAL: u64 = 640_000; // 10 ms at the generic 64 MHz clock.

    fn start(&mut self, ticks: u64) {
        if self.stopping {
            self.stopping = false;
            return;
        }
        if self.running {
            return;
        }
        self.ring_read = 0;
        self.ring_write = 0;
        self.ring_count = 0;
        self.running = true;
        self.started = ticks;
        self.next_drain = ticks.saturating_add(Self::INTERVAL);
        self.active_rate = if self.samplerate == 0 {
            16000
        } else {
            self.samplerate
        };
        self.samples_sent = 0;
        self.intstat |= 1; // Initial refill IRQ in pinned generic QEMU.
    }

    fn stop(&mut self) {
        if self.running && !self.stopping {
            self.stopping = true;
            self.intstat &= !1;
        }
    }

    fn teardown(&mut self) {
        self.running = false;
        self.stopping = false;
        self.ring_read = 0;
        self.ring_write = 0;
        self.ring_count = 0;
        self.intstat = 0;
        self.next_drain = 0;
    }

    pub fn advance(&mut self, ticks: u64) {
        while self.running && ticks >= self.next_drain {
            // QEMU's null audio backend admits bytes according to elapsed
            // virtual time. Unused credit accumulates when the FIFO is empty.
            let allowed = ((self.next_drain - self.started) as u128 * self.active_rate as u128
                / 64_000_000) as u64;
            let sent = allowed
                .saturating_sub(self.samples_sent)
                .min(self.ring_count as u64) as u32;
            self.ring_read = (self.ring_read + sent) % Self::CAPACITY;
            self.ring_count -= sent;
            self.samples_sent += sent as u64;
            if self.stopping && self.ring_count == 0 {
                self.teardown();
            } else {
                if !self.stopping && Self::CAPACITY - self.ring_count >= 1024 {
                    self.intstat |= 1;
                }
                self.next_drain = self.next_drain.saturating_add(Self::INTERVAL);
            }
        }
    }

    fn read(&self, offset: u32) -> u32 {
        match offset {
            0 => self.ctrl,
            4 => 1, // STATUS: FIFO ready.
            8 => self.samplerate,
            16 => self.intctrl,
            20 => self.intstat,
            24 => Self::CAPACITY - self.ring_count,
            28 => self.volume,
            _ => 0, // Pinned QEMU logs bad register offsets and returns zero.
        }
    }

    fn write(&mut self, offset: u32, value: u32, ticks: u64) {
        match offset {
            0 => {
                let old = self.ctrl;
                self.ctrl = value & 1;
                if self.ctrl != 0 && old == 0 {
                    self.start(ticks);
                } else if self.ctrl == 0 && old != 0 {
                    self.stop();
                }
            }
            8 => self.samplerate = value,
            12 if self.running && self.ring_count < Self::CAPACITY => {
                let at = self.ring_write as usize * 2;
                self.ring[at..at + 2].copy_from_slice(&(value as u16).to_le_bytes());
                self.ring_write = (self.ring_write + 1) % Self::CAPACITY;
                self.ring_count += 1;
            }
            16 => self.intctrl = value & 1,
            20 => self.intstat &= !value,
            28 => self.volume = value.min(100),
            _ => {} // Pinned QEMU logs unsupported writes.
        }
    }
}
pub struct Devices {
    pub profile: BoardProfile,
    pub systick_fraction: u64,
    pub systick_source: u32,
    pub uart: [Uart; 3],
    pub timer: [Timer; 2],
    pub ticks: u64,
    pub epoch: u64,
    pub rtc_set_at: u64,
    pub alarm: u32,
    pub rtc_ctrl: u32,
    pub backup: [u32; 16],
    pub buttons: u32,
    pub edges: u32,
    pub gpio_ctrl: u32,
    pub display: [u32; 12],
    pub frames: u64,
    pub flash_addr: u32,
    pub sync_len: u32,
    pub touch: [u32; 5],
    pub audio: Audio,
    pub irq_levels: u32,
}
impl Default for Devices {
    fn default() -> Self {
        Self::with_profile(BoardProfile::EMERY)
    }
}
impl Devices {
    pub fn with_profile(profile: BoardProfile) -> Self {
        let mut backup = [0; 16];
        backup[0] = 2;
        Self {
            profile,
            systick_fraction: 0,
            systick_source: 0,
            uart: std::array::from_fn(|_| Uart::default()),
            timer: [Timer::default(); 2],
            ticks: 0,
            epoch: 1_789_545_600,
            rtc_set_at: 0,
            alarm: 0,
            rtc_ctrl: 0,
            backup,
            buttons: 0,
            edges: 0,
            gpio_ctrl: 0,
            display: [
                0,
                0,
                profile.width as u32,
                profile.height as u32,
                profile.guest_bpp,
                profile.round as u32,
                255,
                0,
                0,
                255,
                255,
                255,
            ],
            frames: 0,
            flash_addr: 0,
            sync_len: 0,
            touch: [0; 5],
            audio: Audio::default(),
            irq_levels: 0,
        }
    }
}
impl Devices {
    pub fn receive_uart(&mut self, index: usize, data: &[u8]) -> usize {
        let Some(u) = self.uart.get_mut(index) else {
            return 0;
        };
        let count = data.len().min(256usize.saturating_sub(u.rx.len()));
        u.rx.extend(&data[..count]);
        count
    }
    pub fn set_buttons(&mut self, mask: u32) {
        let mask = mask & 15;
        self.edges |= self.buttons ^ mask;
        self.buttons = mask
    }
    /// Generic touch-controller register contract. Host coordinates are logical
    /// display pixels. A position change while down or either contact edge raises IRQ.
    pub fn set_touch(&mut self, down: bool, x: u32, y: u32) -> bool {
        if !self.profile.touch || x >= self.profile.width as u32 || y >= self.profile.height as u32
        {
            return false;
        }
        let changed = self.touch[0] != down as u32;
        let moved = self.touch[1] != x || self.touch[2] != y;
        self.touch[0] = down as u32;
        self.touch[1] = x;
        self.touch[2] = y;
        if changed || (down && moved) {
            self.touch[4] |= 1;
        }
        true
    }
    pub fn now(&self) -> u64 {
        self.epoch + (self.ticks - self.rtc_set_at) / 64_000_000
    }
    pub fn advance(&mut self, ticks: u64) {
        self.ticks = ticks;
        if self.profile.audio {
            self.audio.advance(ticks);
        }
        for t in &mut self.timer {
            let period = t.load as u64 * (t.divider as u64 + 1);
            if t.ctrl & 1 != 0 && period != 0 && ticks.saturating_sub(t.started) >= period {
                t.pending |= 1;
                if t.ctrl & 4 != 0 {
                    t.ctrl &= !1
                } else {
                    t.started += ((ticks - t.started) / period) * period
                }
            }
        }
    }
    pub fn irq_mask(&self) -> u32 {
        let mut out = 0;
        for (i, u) in self.uart.iter().enumerate() {
            if (u.ctrl & 1 != 0 && u.pending & 1 != 0) || (u.ctrl & 2 != 0 && !u.rx.is_empty()) {
                out |= 1 << i
            }
        }
        for (i, t) in self.timer.iter().enumerate() {
            if t.ctrl & 2 != 0 && t.pending & 1 != 0 {
                out |= 1 << (i + 3)
            }
        }
        if self.rtc_ctrl & 3 == 3 {
            out |= 1 << 5
        }
        if self.gpio_ctrl & 1 != 0 && self.edges != 0 {
            out |= 1 << 6
        }
        if self.display[7] & self.display[8] & 1 != 0 {
            out |= 1 << 7
        }
        if self.touch[3] & self.touch[4] & 1 != 0 {
            out |= 1 << 9
        }
        if self.profile.audio && self.audio.intctrl & self.audio.intstat & 1 != 0 {
            out |= 1 << 10
        }
        out
    }
    pub fn read(&mut self, a: u32) -> Option<u32> {
        let page = a & 0xfffff000;
        let off = a & 0xfff;
        Some(match page {
            0x40000000 | 0x40001000 | 0x40002000 => {
                let u = &mut self.uart[((page - 0x40000000) >> 12) as usize];
                match off {
                    0 => u.rx.pop_front().unwrap_or(0) as u32,
                    4 => 1 | if u.rx.is_empty() { 0 } else { 2 },
                    8 => u.ctrl,
                    12 => u.pending | if u.rx.is_empty() { 0 } else { 2 },
                    _ => 0,
                }
            }
            0x40003000 | 0x40004000 => {
                let t = &self.timer[((page - 0x40003000) >> 12) as usize];
                match off {
                    0 => t.load,
                    4 => {
                        if t.ctrl & 1 == 0 {
                            0
                        } else {
                            t.load.saturating_sub(
                                ((self.ticks - t.started) / (t.divider as u64 + 1))
                                    .min(u32::MAX as u64) as u32,
                            )
                        }
                    }
                    8 => t.ctrl,
                    12 => t.pending,
                    16 => t.divider,
                    _ => 0,
                }
            }
            0x40005000 => match off {
                0 => self.now() as u32,
                4 => (self.now() >> 32) as u32,
                8 => self.alarm,
                12 => self.rtc_ctrl,
                16 => (self.ticks / 64_000) as u32,
                0x40..=0x7c => self.backup[((off - 0x40) / 4) as usize],
                _ => 0,
            },
            0x40006000 => match off {
                0 => self.buttons,
                4 | 12 => self.edges,
                8 => self.gpio_ctrl,
                _ => 0,
            },
            0x40007000 => match off {
                0 => self.profile.id,
                4 => self.profile.features(),
                8 => self.profile.width as u32,
                12 => self.profile.height as u32,
                16 => self.profile.guest_bpp,
                _ => 0,
            },
            0x40008000 => self.display.get((off / 4) as usize).copied().unwrap_or(0),
            0x40010000 => match off {
                4 => self.flash_addr,
                0x14 => 32 * 1024 * 1024,
                0x18 => self.sync_len,
                _ => 0,
            },
            0x40011000 if self.profile.touch => {
                self.touch.get((off / 4) as usize).copied().unwrap_or(0)
            }
            0x40012000 if self.profile.audio => self.audio.read(off),
            _ => return None,
        })
    }
    pub fn write(&mut self, a: u32, v: u32, flash: &mut [u8]) -> bool {
        let page = a & 0xfffff000;
        let off = a & 0xfff;
        match page {
            0x40000000 | 0x40001000 | 0x40002000 => {
                let u = &mut self.uart[((page - 0x40000000) >> 12) as usize];
                match off {
                    0 => {
                        u.tx.push(v as u8);
                        u.pending |= 1
                    }
                    8 => u.ctrl = v & 3,
                    12 => u.pending &= !v,
                    _ => {}
                }
            }
            0x40003000 | 0x40004000 => {
                let t = &mut self.timer[((page - 0x40003000) >> 12) as usize];
                match off {
                    0 => {
                        t.load = v;
                        if t.ctrl & 1 != 0 {
                            t.started = self.ticks
                        }
                    }
                    8 => {
                        if v & 1 != 0 && t.ctrl & 1 == 0 {
                            t.started = self.ticks
                        }
                        t.ctrl = v & 7
                    }
                    12 => t.pending &= !v,
                    16 => {
                        t.divider = v;
                        if t.ctrl & 1 != 0 {
                            t.started = self.ticks
                        }
                    }
                    _ => {}
                }
            }
            0x40005000 => match off {
                0 => {
                    self.epoch = (self.now() & 0xffffffff00000000) | v as u64;
                    self.rtc_set_at = self.ticks
                }
                4 => {
                    self.epoch = (self.now() & 0xffffffff) | ((v as u64) << 32);
                    self.rtc_set_at = self.ticks
                }
                8 => self.alarm = v,
                12 => self.rtc_ctrl = (self.rtc_ctrl & 2 & !v) | (v & 1),
                0x40..=0x7c => self.backup[((off - 0x40) / 4) as usize] = v,
                _ => {}
            },
            0x40006000 => match off {
                4 | 12 => self.edges &= !(v & 15),
                8 => self.gpio_ctrl = v & 1,
                _ => {}
            },
            0x40007000 => {}
            0x40008000 => match off {
                0 => {
                    self.display[0] = v & 1;
                    if v & 2 != 0 {
                        self.frames += 1;
                        self.display[7] |= 1
                    }
                }
                0x18 | 0x24 | 0x28 | 0x2c => self.display[(off / 4) as usize] = v & 255,
                0x1c => self.display[7] &= !v,
                0x20 => self.display[8] = v & 1,
                _ => {}
            },
            0x40010000 => match off {
                0 => {
                    let size = match v {
                        1 => 4096,
                        2 => 65536,
                        _ => 0,
                    };
                    if size != 0
                        && let Some(a) = self.flash_addr.checked_sub(0x10000000)
                    {
                        let start = (a as usize / size) * size;
                        let end = start.saturating_add(size);
                        if end <= flash.len() {
                            flash[start..end].fill(255)
                        }
                    }
                }
                4 => self.flash_addr = v,
                0x18 => self.sync_len = v,
                _ => {}
            },
            0x40011000 if self.profile.touch => match off {
                12 => self.touch[3] = v & 1,
                16 => self.touch[4] &= !v,
                _ => {}
            },
            0x40012000 if self.profile.audio => self.audio.write(off, v, self.ticks),
            _ => return false,
        }
        true
    }
}
