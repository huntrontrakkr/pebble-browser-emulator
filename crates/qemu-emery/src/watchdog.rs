//! CMSDK APB watchdog on the generic Pebble board's 1 MHz REFCLK.
//! Original model of the register/timer contract; see docs/WATCHDOG.md for references.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watchdog {
    pub load: u32,
    pub count: u32,
    /// Readback at the last board tick, including QEMU's exact-edge rounding.
    pub value: u32,
    pub control: u32,
    pub raw: bool,
    pub reset: bool,
    pub locked: bool,
    pub itcr: u32,
    pub itop: u32,
    pub running: bool,
    /// Next decrement/reload edge in the board's 64 MHz tick domain.
    pub next_tick: u64,
}
impl Default for Watchdog {
    fn default() -> Self {
        Self {
            load: u32::MAX,
            count: u32::MAX,
            value: u32::MAX,
            control: 0,
            raw: false,
            reset: false,
            locked: false,
            itcr: 0,
            itop: 0,
            running: false,
            next_tick: 0,
        }
    }
}
impl Watchdog {
    pub const PERIOD: u64 = 64;

    pub fn interrupt(&self) -> bool {
        if self.itcr != 0 {
            self.itop & 2 != 0
        } else {
            self.raw && self.control & 1 != 0
        }
    }

    pub fn reset_requested(&self) -> bool {
        if self.itcr != 0 {
            self.itop & 1 != 0
        } else {
            self.reset && self.control & 2 != 0
        }
    }

    pub fn deadline(&self) -> Option<u64> {
        self.running.then(|| {
            self.next_tick
                .saturating_add(u64::from(self.count.saturating_sub(1)) * Self::PERIOD)
        })
    }

    pub fn advance(&mut self, ticks: u64) {
        if self.running && ticks < self.next_tick && self.next_tick - ticks < Self::PERIOD {
            self.value = self.count;
        }
        // At most two expiries and one intervening reload; no per-clock loop.
        while self.running && ticks >= self.next_tick {
            if self.count == 0 {
                self.count = self.load;
                self.value = if ticks == self.next_tick {
                    0
                } else {
                    self.count
                };
                self.next_tick = self.next_tick.saturating_add(Self::PERIOD);
                if self.load == 0 {
                    self.running = false;
                }
            } else {
                let decrements =
                    ((ticks - self.next_tick) / Self::PERIOD + 1).min(u64::from(self.count));
                self.count -= decrements as u32;
                let exact_edge = ticks == self.next_tick + (decrements - 1) * Self::PERIOD;
                self.value = self.count + u32::from(exact_edge && self.count != 0);
                self.next_tick = self.next_tick.saturating_add(decrements * Self::PERIOD);
                if self.count == 0 {
                    if self.raw {
                        self.reset = true;
                        self.running = false;
                    } else {
                        self.raw = true;
                    }
                }
            }
        }
    }

    fn reload(&mut self, ticks: u64) {
        self.count = self.load;
        self.value = self.load;
        self.next_tick = ticks.saturating_add(Self::PERIOD);
        // QEMU's trigger-only-on-decrement policy does not expire a written zero.
        if self.count == 0 {
            self.running = false;
        }
    }

    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0 => self.load,
            4 => self.value,
            8 => self.control,
            0x10 => self.raw as u32,
            0x14 => (self.raw && self.control & 1 != 0) as u32,
            0xc00 => self.locked as u32,
            0xf00 => self.itcr,
            0xfd0..=0xffc if offset & 3 == 0 => {
                [4, 0, 0, 0, 0x24, 0xb8, 0x1b, 0, 0x0d, 0xf0, 5, 0xb1]
                    [((offset - 0xfd0) / 4) as usize]
            }
            // QEMU returns zero for write-only and reserved offsets in this device.
            _ => 0,
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, ticks: u64) {
        if self.locked && offset != 0xc00 {
            return;
        }
        match offset {
            0 => {
                self.load = value;
                self.reload(ticks);
            }
            8 => {
                let previous = self.control;
                self.control = value & 3;
                if (previous ^ self.control) & 1 != 0 {
                    self.running = self.control & 1 != 0;
                    if self.running {
                        self.reload(ticks);
                    } else {
                        self.count = self.value;
                    }
                }
            }
            0xc => {
                self.raw = false;
                self.reload(ticks);
            }
            0xc00 => self.locked = value != 0x1acce551,
            0xf00 => self.itcr = value & 1,
            0xf04 => self.itop = value & 3,
            _ => {} // Read-only/reserved writes have no effect in reference QEMU.
        }
    }

    pub fn valid(&self, ticks: u64) -> bool {
        self.control <= 3
            && self.count <= self.load
            && self.value <= self.load
            && self.itcr <= 1
            && self.itop <= 3
            && (!self.running
                || (self.control & 1 != 0
                    && self.load != 0
                    && self.next_tick > ticks
                    && self.next_tick - ticks <= Self::PERIOD))
    }
}
