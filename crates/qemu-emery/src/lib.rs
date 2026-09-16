use rp2350_emu::{CortexM33, core::CoreBus, threaded::CoreAtomics};
use std::sync::Arc;
pub mod peripherals;
pub mod profile;
use profile::BoardProfile;

const RAM: u32 = 0x2000_0000;
const FRAME: u32 = 0x5000_0000;
pub struct PebbleBus {
    pub profile: BoardProfile,
    pub atomics: Arc<CoreAtomics>,
    pub code: Vec<u8>,
    pub ram: Vec<u8>,
    pub frame: Vec<u8>,
    /// Last completed display update, separate from guest drawing memory.
    pub presented_frame: Vec<u8>,
    pub flash: Vec<u8>,
    pub devices: peripherals::Devices,
    pub active_pc: u32,
    pub failed: Option<(u32, u32, bool)>,
    wait: u32,
    fetch: u32,
    observed_pending_irqs: u64,
    observed_pending_system: u32,
}
impl PebbleBus {
    pub fn new(code: Vec<u8>, atomics: Arc<CoreAtomics>) -> Self {
        Self::with_profile(code, atomics, BoardProfile::EMERY)
    }
    pub fn with_profile(code: Vec<u8>, atomics: Arc<CoreAtomics>, profile: BoardProfile) -> Self {
        Self {
            profile,
            atomics,
            code,
            ram: vec![0; profile.ram_bytes],
            frame: vec![0; 128 * 1024],
            presented_frame: vec![0; profile.frame_len()],
            flash: vec![255; 32 * 1024 * 1024],
            devices: peripherals::Devices::with_profile(profile),
            active_pc: 0,
            failed: None,
            wait: 0,
            fetch: 0,
            observed_pending_irqs: 0,
            observed_pending_system: 0,
        }
    }
    fn read_byte(&mut self, a: u32) -> u8 {
        let v = self
            .code
            .get(a as usize)
            .copied()
            .or_else(|| {
                a.checked_sub(0x10000000)
                    .and_then(|o| self.flash.get(o as usize).copied())
            })
            .or_else(|| {
                a.checked_sub(RAM)
                    .and_then(|o| self.ram.get(o as usize).copied())
            })
            .or_else(|| {
                a.checked_sub(FRAME)
                    .and_then(|o| self.frame.get(o as usize).copied())
            });
        if let Some(v) = v {
            v
        } else {
            self.fail(a, false);
            0
        }
    }
    fn write_byte(&mut self, a: u32, v: u8) {
        if let Some(o) = a.checked_sub(0x10000000)
            && let Some(p) = self.flash.get_mut(o as usize)
        {
            *p = v;
            return;
        }
        if let Some(o) = a.checked_sub(RAM)
            && let Some(p) = self.ram.get_mut(o as usize)
        {
            *p = v;
            return;
        }
        if let Some(o) = a.checked_sub(FRAME)
            && let Some(p) = self.frame.get_mut(o as usize)
        {
            *p = v;
            return;
        }
        self.fail(a, true)
    }
    fn fail(&mut self, a: u32, write: bool) {
        self.failed.get_or_insert((self.active_pc, a, write));
        self.atomics.set_bus_fault(0, a);
    }
}
impl CoreBus for PebbleBus {
    fn read8(&mut self, a: u32, _: u8) -> u8 {
        self.read_byte(a)
    }
    fn read16(&mut self, a: u32, _: u8) -> u16 {
        u16::from_le_bytes([self.read_byte(a), self.read_byte(a.wrapping_add(1))])
    }
    fn read32(&mut self, a: u32, _: u8) -> u32 {
        if (0x40000000..0x50000000).contains(&a)
            && let Some(v) = self.devices.read(a)
        {
            return v;
        }
        u32::from_le_bytes(std::array::from_fn(|i| {
            self.read_byte(a.wrapping_add(i as u32))
        }))
    }
    fn write8(&mut self, a: u32, v: u8, _: u8) {
        self.write_byte(a, v)
    }
    fn write16(&mut self, a: u32, v: u16, _: u8) {
        for (i, b) in v.to_le_bytes().iter().enumerate() {
            self.write_byte(a.wrapping_add(i as u32), *b)
        }
    }
    fn write32(&mut self, a: u32, v: u32, _: u8) {
        let frames = self.devices.frames;
        if self.devices.write(a, v, &mut self.flash) {
            if self.devices.frames != frames {
                if self.profile.guest_bpp == 1 {
                    // Pebble monochrome rows are 32-bit aligned, LSB first.
                    for y in 0..self.profile.height {
                        for x in 0..self.profile.width {
                            let white = self.frame[y * self.profile.guest_stride() + x / 8]
                                & (1 << (x % 8))
                                != 0;
                            self.presented_frame[y * self.profile.width + x] =
                                if white { 0xff } else { 0xc0 };
                        }
                    }
                } else {
                    self.presented_frame
                        .copy_from_slice(&self.frame[..self.profile.frame_len()]);
                }
            }
            return;
        }
        for (i, b) in v.to_le_bytes().iter().enumerate() {
            self.write_byte(a.wrapping_add(i as u32), *b)
        }
    }
    fn set_active_pc(&mut self, p: u32, _: u8) {
        self.active_pc = p
    }
    fn bus_fault(&self, c: u8) -> bool {
        self.atomics.is_bus_fault(c as usize)
    }
    fn bus_fault_addr(&self, c: u8) -> u32 {
        self.atomics.bus_fault_addr(c as usize)
    }
    fn clear_bus_fault(&mut self, c: u8) {
        self.atomics.clear_bus_fault(c as usize)
    }
    fn set_burst_mode(&mut self, _: bool) {}
    fn add_extra_wait_states(&mut self, n: u32) {
        self.wait = self.wait.saturating_add(n)
    }
    fn take_extra_wait_states(&mut self) -> u32 {
        std::mem::take(&mut self.wait)
    }
    fn atomics(&self) -> &Arc<CoreAtomics> {
        &self.atomics
    }
    // RP2350-specific coprocessor GPIO methods are deliberately faulting.
    fn gpio_read_out(&self) -> u32 {
        self.atomics.set_bus_fault(0, 0xd000_0010);
        0
    }
    fn gpio_write_out(&mut self, _: u32) {
        self.fail(0xd000_0010, true)
    }
    fn gpio_set_out(&mut self, _: u32) {
        self.fail(0xd000_0014, true)
    }
    fn gpio_clear_out(&mut self, _: u32) {
        self.fail(0xd000_0018, true)
    }
    fn gpio_xor_out(&mut self, _: u32) {
        self.fail(0xd000_001c, true)
    }
    fn gpio_read_oe(&self) -> u32 {
        self.atomics.set_bus_fault(0, 0xd000_0020);
        0
    }
    fn gpio_write_oe(&mut self, _: u32) {
        self.fail(0xd000_0020, true)
    }
    fn gpio_set_oe(&mut self, _: u32) {
        self.fail(0xd000_0024, true)
    }
    fn gpio_clear_oe(&mut self, _: u32) {
        self.fail(0xd000_0028, true)
    }
    fn gpio_xor_oe(&mut self, _: u32) {
        self.fail(0xd000_002c, true)
    }
    fn gpio_read_in(&self) -> u32 {
        self.atomics.set_bus_fault(0, 0xd000_0004);
        0
    }
    fn extra_wait_states(&self) -> u32 {
        self.wait
    }
    fn reset_extra_wait_states(&mut self) {
        self.wait = 0
    }
    fn last_fetch_addr(&self) -> u32 {
        self.fetch
    }
    fn set_last_fetch_addr(&mut self, a: u32) {
        self.fetch = a
    }
    fn mmio_trace_enabled(&self) -> bool {
        false
    }
    fn emit_mmio_trace(&mut self, _: char, _: u32, _: u32, _: u32, _: u8) {}
}
fn image(words: &[u16]) -> Vec<u8> {
    let mut b = vec![0; 0x100];
    b[..4].copy_from_slice(&(RAM + 512 * 1024).to_le_bytes());
    b[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    for w in words {
        b.extend_from_slice(&w.to_le_bytes())
    }
    b
}
pub fn boot(code: Vec<u8>) -> (CortexM33, PebbleBus) {
    boot_profile(code, BoardProfile::EMERY)
}
/// The shared instruction engine executes the common M4/M33 instruction set.
/// CPUID and memory differ per board; complete architecture exclusion is not yet modeled.
pub fn boot_profile(code: Vec<u8>, profile: BoardProfile) -> (CortexM33, PebbleBus) {
    let a = Arc::new(CoreAtomics::default());
    let mut bus = PebbleBus::with_profile(code, a.clone(), profile);
    let mut cpu = CortexM33::new(0, a);
    cpu.ppb.cpuid = profile.cpuid;
    cpu.regs.msp = bus.read32(0, 0);
    cpu.regs.r[13] = cpu.regs.msp;
    cpu.regs.r[14] = u32::MAX;
    cpu.regs.r[15] = bus.read32(4, 0) & !1;
    cpu.ppb.vtor = 0;
    (cpu, bus)
}
fn advance(cpu: &mut CortexM33, bus: &mut PebbleBus, n: u32) {
    for _ in 0..n {
        cpu.ppb.update_latest_cycles(cpu.cycles());
        cpu.step(bus);
        cpu.ppb.systick_advance(cpu.cycles());
    }
}
// Each return bit indicates a tested architectural/adapter feature; no dependencies are patched.
#[unsafe(no_mangle)]
pub extern "C" fn smoke() -> u32 {
    let mut passed = 0;
    // 32-bit Armv8-M MSR MSPLIM/PSPLIM, followed by a low-register instruction.
    let (mut c, mut b) = boot(image(&[0xf380, 0x880a, 0xf381, 0x880b, 0x2207]));
    c.regs.r[0] = RAM + 0x1008;
    c.regs.r[1] = RAM + 0x2008;
    advance(&mut c, &mut b, 3);
    if c.regs.msplim == RAM + 0x1008
        && c.regs.psplim == RAM + 0x2008
        && c.regs.r[2] == 7
        && b.failed.is_none()
    {
        passed |= 1
    }
    // SRAM word store + byte load through custom CoreBus.
    let (mut c, mut b) = boot(image(&[0x6008, 0x780a]));
    c.regs.r[0] = 0x12345678;
    c.regs.r[1] = RAM;
    advance(&mut c, &mut b, 2);
    if b.ram[..4] == [0x78, 0x56, 0x34, 0x12] && c.regs.r[2] == 0x78 && b.failed.is_none() {
        passed |= 2
    }
    // SVC vector, handler increments r4, BX LR restores interrupted thread.
    let mut code = image(&[0xdf00, 0x2209, 0xe7fe]);
    code[44..48].copy_from_slice(&0x121u32.to_le_bytes());
    code.resize(0x120, 0);
    for w in [0x3401u16, 0x4770] {
        code.extend_from_slice(&w.to_le_bytes())
    }
    let (mut c, mut b) = boot(code);
    advance(&mut c, &mut b, 4);
    if c.regs.r[4] == 1
        && c.regs.r[2] == 9
        && c.regs.ipsr() == 0
        && c.regs.msp == RAM + 512 * 1024
        && b.failed.is_none()
    {
        passed |= 4
    }
    // Generic memory at 0x50000000 is not intercepted as an RP2350 peripheral.
    let (mut c, mut b) = boot(image(&[0x7008, 0x780a]));
    c.regs.r[0] = 0xf3;
    c.regs.r[1] = FRAME;
    advance(&mut c, &mut b, 2);
    if b.frame[0] == 0xf3 && c.regs.r[2] == 0xf3 && b.failed.is_none() {
        passed |= 8
    }
    // Peripheral IRQ 3 through shared atomics + built-in NVIC; returns via BX LR.
    let mut code = image(&[0x2209, 0xe7fe]);
    code[4 * (16 + 3)..4 * (17 + 3)].copy_from_slice(&0x121u32.to_le_bytes());
    code.resize(0x120, 0);
    for w in [0x3401u16, 0x4770] {
        code.extend_from_slice(&w.to_le_bytes())
    }
    let (mut c, mut b) = boot(code);
    c.ppb.write32(0xe000e100, 1 << 3);
    c.ppb.write32(0xe000e400, 0xa0000000);
    b.atomics.assert_irq(0, 3);
    advance(&mut c, &mut b, 4);
    if c.regs.r[4] == 1 && c.regs.r[2] == 9 && c.regs.ipsr() == 0 && b.failed.is_none() {
        passed |= 16
    }
    passed
}
#[cfg(test)]
mod tests {
    #[test]
    fn smoke_all() {
        assert_eq!(super::smoke(), 31)
    }
}

/// Drive virtual board time even during WFI; uncalibrated cycles at nominal 64MHz.
pub fn board_step(cpu: &mut CortexM33, bus: &mut PebbleBus) {
    let prev = cpu.cycles();
    cpu.ppb.update_latest_cycles(bus.devices.ticks);
    let mask = bus.devices.irq_mask();
    // Convert peripheral levels to rising edges; re-pend still-high inactive lines.
    let active = cpu.ppb.nvic_iabr[0].load(std::sync::atomic::Ordering::Relaxed);
    let pending = cpu.ppb.nvic_ispr[0].load(std::sync::atomic::Ordering::Relaxed);
    let signal = mask & (!bus.devices.irq_levels | !active & !pending);
    for irq in 0..32 {
        if signal & (1 << irq) != 0 {
            bus.atomics.assert_irq(0, irq)
        }
    }
    bus.devices.irq_levels = mask;
    observe_pending_events(cpu, bus);
    wake_from_wfe(cpu, bus);
    if cpu.is_halted() && pending_exception_can_wake(cpu, bus, true) {
        cpu.wake()
    }
    cpu.step(bus);
    // An interrupt may already have been pending when WFI executed. Check
    // again before fast-forwarding sleep time: WFI then acts as a NOP.
    if cpu.is_halted() && pending_exception_can_wake(cpu, bus, true) {
        cpu.wake()
    }
    let mut elapsed = cpu.cycles().wrapping_sub(prev).max(1);
    if cpu.is_halted() || cpu.is_wfe_waiting() {
        let scale = if cpu.ppb.syst_csr & 4 != 0 { 1 } else { 64 };
        let until_systick = if cpu.ppb.syst_csr & 1 != 0 {
            (cpu.ppb.syst_cvr as u64).max(1) * scale - bus.devices.systick_fraction.min(scale - 1)
        } else {
            64_000
        };
        elapsed = until_systick;
        for t in &bus.devices.timer {
            if t.ctrl & 1 != 0 && t.load != 0 {
                let deadline = t.started + (t.load as u64) * (t.divider as u64 + 1);
                elapsed = elapsed.min(deadline.saturating_sub(bus.devices.ticks).max(1))
            }
        }
    }
    bus.devices.advance(bus.devices.ticks + elapsed);
    let source = cpu.ppb.syst_csr & 4;
    if source != bus.devices.systick_source {
        bus.devices.systick_fraction = 0;
        bus.devices.systick_source = source
    }
    let tick_count = if source != 0 {
        elapsed
    } else {
        let all = elapsed + bus.devices.systick_fraction;
        bus.devices.systick_fraction = all % 64;
        all / 64
    };
    advance_systick(cpu, tick_count);
    cpu.ppb.last_systick_cycles = bus.devices.ticks;
    observe_pending_events(cpu, bus);
}

// Pending transitions are sampled before wake/arbitration and after each
// instruction/timer advance. This covers hardware IRQ assertions, software
// NVIC/ICSR writes and SysTick expiry without repeatedly generating events for
// a still-pending interrupt. Event state survives until a WFE consumes it.
fn pending_snapshot(cpu: &CortexM33, bus: &PebbleBus) -> (u64, u32) {
    use std::sync::atomic::Ordering::Relaxed;
    let external = cpu.ppb.nvic_ispr[0].load(Relaxed) as u64
        | ((cpu.ppb.nvic_ispr[1].load(Relaxed) as u64) << 32)
        | bus.atomics.irq_pending_load(0);
    let system = cpu.ppb.icsr & ((1 << 31) | (1 << 28) | (1 << 26));
    (external, system)
}

fn observe_pending_events(cpu: &CortexM33, bus: &mut PebbleBus) {
    let (external, system) = pending_snapshot(cpu, bus);
    if cpu.ppb.scr & (1 << 4) != 0
        && ((external & !bus.observed_pending_irqs) != 0
            || (system & !bus.observed_pending_system) != 0)
    {
        bus.atomics.set_event_flag(0);
    }
    bus.observed_pending_irqs = external;
    bus.observed_pending_system = system;
}

// WFE resumes for a consumed event or an exception that can preempt. A
// masked/disabled IRQ alone is not an event unless SEVONPEND is enabled.
fn wake_from_wfe(cpu: &CortexM33, bus: &PebbleBus) {
    if cpu.is_wfe_waiting()
        && (bus.atomics.event_flag_consume(0) || pending_exception_can_wake(cpu, bus, false))
    {
        bus.atomics.clear_wfe_waiting(0);
    }
}

// WFI ignores PRIMASK only for wake eligibility; exception delivery still
// honors it in CortexM33::step. BASEPRI, FAULTMASK and active priority apply.
// Read the architectural pending latch as well as freshly asserted signals.
fn pending_exception_can_wake(cpu: &CortexM33, bus: &PebbleBus, ignore_primask: bool) -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    let mut priority: i16 = 256;
    if cpu.regs.faultmask & 1 != 0 {
        priority = -1;
    } else if !ignore_primask && cpu.regs.primask & 1 != 0 {
        priority = 0;
    }
    let basepri = (cpu.regs.basepri & 0xe0) as i16;
    if basepri != 0 {
        priority = priority.min(basepri);
    }
    if cpu.regs.ipsr() != 0 {
        priority = priority.min(cpu.ppb.exception_priority(cpu.regs.ipsr() as u16));
    }
    let can_preempt = |exception| cpu.ppb.exception_priority(exception) < priority;
    let (external, system) = pending_snapshot(cpu, bus);
    let system_ready = [(31, 2), (28, 14), (26, 15)]
        .into_iter()
        .any(|(bit, exception)| system & (1 << bit) != 0 && can_preempt(exception));
    let enabled = cpu.ppb.nvic_iser[0].load(Relaxed) as u64
        | ((cpu.ppb.nvic_iser[1].load(Relaxed) as u64) << 32);
    let mut ready = external & enabled;
    let mut external_ready = false;
    while ready != 0 {
        let bit = ready.trailing_zeros();
        if can_preempt(bit as u16 + 16) {
            external_ready = true;
            break;
        }
        ready &= ready - 1;
    }
    system_ready || external_ready
}

// Correct exact-zero transition; upstream 0.2.6 documents a gap for one-cycle quanta.
fn advance_systick(cpu: &mut CortexM33, mut ticks: u64) {
    if cpu.ppb.syst_csr & 1 == 0 {
        return;
    }
    while ticks > 0 {
        if cpu.ppb.syst_cvr == 0 {
            cpu.ppb.syst_cvr = cpu.ppb.syst_rvr & 0x00ff_ffff;
            ticks -= 1;
            if cpu.ppb.syst_cvr == 0 {
                return;
            }
        }
        let down = ticks.min(cpu.ppb.syst_cvr as u64);
        cpu.ppb.syst_cvr -= down as u32;
        ticks -= down;
        if down > 0 && cpu.ppb.syst_cvr == 0 {
            cpu.ppb.syst_csr |= 1 << 16;
            if cpu.ppb.syst_csr & 2 != 0 {
                cpu.ppb.pend_systick()
            }
        }
    }
}

thread_local! {
 static UPLOAD:std::cell::RefCell<Vec<u8>>=const{std::cell::RefCell::new(Vec::new())};
 static MACHINE:std::cell::RefCell<Option<(CortexM33,PebbleBus)>>=const{std::cell::RefCell::new(None)};
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_upload(size: u32) -> *mut u8 {
    if size > 36 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    UPLOAD.with(|b| {
        let mut b = b.borrow_mut();
        *b = vec![0; size as usize];
        b.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_boot(code_len: u32, flash_len: u32) -> u32 {
    spike_boot_profile(BoardProfile::EMERY.id, code_len, flash_len)
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_boot_profile(profile_id: u32, code_len: u32, flash_len: u32) -> u32 {
    let Some(profile) = BoardProfile::from_id(profile_id) else {
        return 0;
    };
    if !(8..=4 * 1024 * 1024).contains(&code_len) || flash_len != 32 * 1024 * 1024 {
        return 0;
    }
    let image = UPLOAD.with(|b| std::mem::take(&mut *b.borrow_mut()));
    if image.len() != code_len as usize + flash_len as usize {
        return 0;
    }
    let supplied = &image[..code_len as usize];
    let msp = u32::from_le_bytes(supplied[..4].try_into().unwrap());
    let reset = u32::from_le_bytes(supplied[4..8].try_into().unwrap());
    if !(RAM..=RAM + profile.ram_bytes as u32).contains(&msp)
        || msp & 7 != 0
        || reset & 1 == 0
        || (reset & !1) as u64 + 2 > code_len as u64
    {
        return 0;
    }
    let mut code = supplied.to_vec();
    code.resize(4 * 1024 * 1024, 0);
    let (mut cpu, mut bus) = boot_profile(code, profile);
    bus.flash = image[code_len as usize..].to_vec();
    cpu.ppb.syst_csr = 0;
    bus.failed = None;
    MACHINE.with(|m| *m.borrow_mut() = Some((cpu, bus)));
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_run(steps: u32) -> u32 {
    MACHINE.with(|m| {
        let mut m = m.borrow_mut();
        let Some((c, b)) = m.as_mut() else {
            return u32::MAX;
        };
        for _ in 0..steps.min(1_000_000) {
            board_step(c, b);
            if b.failed.is_some() {
                return u32::MAX;
            }
        }
        b.devices.frames as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_button(mask: u32) {
    MACHINE.with(|m| {
        if let Some((_, b)) = m.borrow_mut().as_mut() {
            b.devices.set_buttons(mask)
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame() -> *const u8 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |(_, b)| b.presented_frame.as_ptr())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_uart() -> *const u8 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |(_, b)| b.devices.uart[2].tx.as_ptr())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_uart_len() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.devices.uart[2].tx.len() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_pc() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().map_or(0, |(c, _)| c.regs.pc()))
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_ticks() -> f64 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0.0, |(_, b)| b.devices.ticks as f64)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_fault() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.failed.map_or(0, |(_, a, _)| a))
    })
}

// Scalar accessors and bounded UART upload avoid passing arbitrary pointers into Rust.
#[unsafe(no_mangle)]
pub extern "C" fn spike_receive_uart(index: u32, length: u32) -> u32 {
    UPLOAD.with(|u| {
        let u = u.borrow();
        if length as usize > u.len() {
            return 0;
        }
        MACHINE.with(|m| {
            m.borrow_mut().as_mut().map_or(0, |(_, b)| {
                b.devices
                    .receive_uart(index as usize, &u[..length as usize]) as u32
            })
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_uart_tx_ptr(index: u32) -> *const u8 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .and_then(|(_, b)| b.devices.uart.get(index as usize))
            .map_or(std::ptr::null(), |u| u.tx.as_ptr())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_uart_tx_len(index: u32) -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .and_then(|(_, b)| b.devices.uart.get(index as usize))
            .map_or(0, |u| u.tx.len() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_uart_tx_consume(index: u32, count: u32) -> u32 {
    MACHINE.with(|m| {
        let mut m = m.borrow_mut();
        let Some((_, b)) = m.as_mut() else { return 0 };
        let Some(u) = b.devices.uart.get_mut(index as usize) else {
            return 0;
        };
        let n = (count as usize).min(u.tx.len());
        u.tx.drain(..n);
        n as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_register(index: u32) -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .and_then(|(c, _)| c.regs.r.get(index as usize))
            .copied()
            .unwrap_or(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_xpsr() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().map_or(0, |(c, _)| c.regs.xpsr))
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_cfsr() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().map_or(0, |(c, _)| c.ppb.cfsr))
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_hfsr() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().map_or(0, |(c, _)| c.ppb.hfsr))
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_set_epoch(epoch: f64) -> u32 {
    if !epoch.is_finite() || epoch < 0.0 || epoch > u32::MAX as f64 {
        return 0;
    }
    MACHINE.with(|m| {
        if let Some((_, b)) = m.borrow_mut().as_mut() {
            b.devices.epoch = epoch as u64;
            b.devices.rtc_set_at = b.devices.ticks;
            1
        } else {
            0
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_fault_pc() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.failed.map_or(0, |(p, _, _)| p))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_fault_write() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.failed.map_or(0, |(_, _, w)| w as u32))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_faulted() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().is_some_and(|(_, b)| b.failed.is_some()) as u32)
}
#[cfg(test)]
mod board_tests {
    use super::*;
    #[test]
    fn systick_exact_zero_pends() {
        let (mut c, _) = boot(image(&[0xbf00]));
        c.ppb.syst_csr = 7;
        c.ppb.syst_rvr = 2;
        c.ppb.syst_cvr = 1;
        advance_systick(&mut c, 1);
        assert_eq!(c.ppb.syst_cvr, 0);
        assert_ne!(c.ppb.icsr & (1 << 26), 0);
        assert_ne!(c.ppb.syst_csr & (1 << 16), 0)
    }
    #[test]
    fn uart_fifo_is_bounded_and_level_sensitive() {
        let mut d = peripherals::Devices::default();
        assert_eq!(d.receive_uart(1, &[42; 300]), 256);
        d.uart[1].ctrl = 2;
        assert_eq!(d.irq_mask(), 2);
        for _ in 0..256 {
            assert_eq!(d.read(0x40001000), Some(42))
        }
        assert_eq!(d.irq_mask(), 0);
        assert_eq!(d.read(0x40001004), Some(1))
    }
    #[test]
    fn flash_erase_is_aligned_and_bounded() {
        let mut d = peripherals::Devices::default();
        let mut f = vec![0; 8192];
        d.write(0x40010004, 0x10001013, &mut f);
        d.write(0x40010000, 1, &mut f);
        assert!(f[..4096].iter().all(|b| *b == 0));
        assert!(f[4096..].iter().all(|b| *b == 255));
        d.write(0x40010004, u32::MAX, &mut f);
        assert!(d.write(0x40010000, 2, &mut f))
    }
    #[test]
    fn wfi_wakes_on_systick() {
        let (mut c, mut b) = boot(image(&[0xbf00]));
        c.ppb.syst_csr = 7;
        c.ppb.syst_rvr = 100;
        c.ppb.syst_cvr = 1;
        c.halt();
        board_step(&mut c, &mut b);
        assert_ne!(c.ppb.icsr & (1 << 26), 0);
        assert_eq!(b.devices.ticks, 1);
        c.ppb.icsr = 0;
        c.ppb.syst_csr = 3;
        c.ppb.syst_cvr = 1;
        board_step(&mut c, &mut b);
        assert_eq!(b.devices.ticks, 65);
        assert_ne!(c.ppb.icsr & (1 << 26), 0)
    }
}

/// Restart the loaded virtual board without replacing its persistent storage.
///
/// Returns 1 on success, 0 when no image is loaded. The firmware vector table,
/// internal code image, and current SPI flash bytes remain unchanged. CPU state,
/// SRAM, framebuffer, IRQ state, peripheral registers, and UART queues reset.
/// The RTC clock domain (including its subsecond phase) continues across reset;
/// spike_ticks therefore remains monotonic, while the new CPU cycle count is 0.
///
/// Callers must cancel pending protocol operations and create a fresh transport.
/// Existing memory views must be reacquired after this mutating Wasm call.
#[unsafe(no_mangle)]
pub extern "C" fn spike_restart() -> u32 {
    let restarted = MACHINE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some((cpu, bus)) = slot.as_mut() else {
            return 0;
        };

        // RTC time is epoch + (ticks - rtc_set_at) / nominal_clock. Keeping
        // these three scalars preserves the next second boundary exactly.
        let rtc = (bus.devices.epoch, bus.devices.rtc_set_at, bus.devices.ticks);
        let atomics = std::sync::Arc::new(CoreAtomics::default());
        bus.atomics = atomics.clone();
        bus.ram.fill(0);
        bus.frame.fill(0);
        bus.presented_frame.fill(0);
        bus.devices = peripherals::Devices::with_profile(bus.profile);
        bus.devices.epoch = rtc.0;
        bus.devices.rtc_set_at = rtc.1;
        bus.devices.ticks = rtc.2;
        bus.active_pc = 0;
        bus.failed = None;
        bus.wait = 0;
        bus.fetch = 0;
        bus.observed_pending_irqs = 0;
        bus.observed_pending_system = 0;

        // A new core also discards instruction-cache and exclusive-monitor
        // state. Reusing the bus retains both flash allocations without copies.
        let mut fresh = CortexM33::new(0, atomics);
        fresh.ppb.cpuid = bus.profile.cpuid;
        fresh.regs.msp = bus.read32(0, 0);
        fresh.regs.r[13] = fresh.regs.msp;
        fresh.regs.r[14] = u32::MAX;
        fresh.regs.r[15] = bus.read32(4, 0) & !1;
        fresh.ppb.vtor = 0;
        fresh.ppb.syst_csr = 0;
        *cpu = fresh;
        1
    });
    if restarted == 1 {
        // A pending uploaded UART packet belongs to the previous generation.
        UPLOAD.with(|upload| upload.borrow_mut().clear());
    }
    restarted
}

#[cfg(test)]
mod restart_regressions {
    use super::*;

    // No production firmware: MOVS r2,#42 followed by B . and a valid vector.
    fn load_synthetic_board() {
        let code = image(&[0x222a, 0xe7fe]);
        let code_len = code.len();
        let total = code_len + 32 * 1024 * 1024;
        assert!(!spike_upload(total as u32).is_null());
        UPLOAD.with(|upload| {
            let mut upload = upload.borrow_mut();
            upload[..code_len].copy_from_slice(&code);
            upload[code_len..].fill(0xa5);
        });
        assert_eq!(spike_boot(code_len as u32, 32 * 1024 * 1024), 1);
    }

    #[test]
    fn restart_without_loaded_image_is_noop() {
        MACHINE.with(|slot| *slot.borrow_mut() = None);
        assert!(!spike_upload(3).is_null());
        UPLOAD.with(|upload| upload.borrow_mut().copy_from_slice(&[7, 8, 9]));
        assert_eq!(spike_restart(), 0);
        UPLOAD.with(|upload| assert_eq!(&*upload.borrow(), &[7, 8, 9]));
    }

    #[test]
    fn restart_retains_modified_flash_and_resets_cpu_ram_and_devices() {
        load_synthetic_board();
        assert_eq!(spike_run(1), 0);
        assert_eq!(spike_register(2), 42);

        let (code_address, flash_address) = MACHINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let (cpu, bus) = slot.as_mut().unwrap();
            // Use the same bus route used by emulated program accesses.
            bus.write32(0x1000_4000, 0x1234_abcd, 0);
            bus.write8(0x11ff_ffff, 0x3c, 0);
            bus.write32(RAM + 32, 0xdead_beef, 0);
            bus.write8(FRAME + 64, 0xf3, 0);
            bus.devices.uart[1].ctrl = 3;
            bus.devices.uart[1].pending = 1;
            bus.devices.uart[1].rx.extend([0xfe, 0xed]);
            bus.devices.uart[1].tx.extend([0xbe, 0xef]);
            bus.devices.timer[0].load = 100;
            bus.devices.timer[0].ctrl = 3;
            bus.devices.timer[0].pending = 1;
            bus.devices.set_buttons(15);
            bus.devices.gpio_ctrl = 1;
            bus.devices.display[7] = 1;
            bus.devices.display[8] = 1;
            bus.devices.flash_addr = 42;
            bus.devices.sync_len = 99;
            bus.devices.frames = 12;
            bus.presented_frame.fill(255);
            bus.devices.irq_levels = 0xffff;
            bus.devices.alarm = 123;
            bus.devices.rtc_ctrl = 3;
            bus.devices.backup[1] = 0xdead_beef;
            bus.wait = 17;
            bus.fetch = 0xabc;
            bus.active_pc = 0xdef;
            bus.failed = Some((0x123, 0xcafebabe, true));
            bus.atomics.set_bus_fault(0, 0xcafebabe);
            bus.atomics.assert_irq(0, 3);
            bus.atomics.set_halted(0);
            cpu.regs.r[0] = 0xffff_ffff;
            cpu.regs.r[15] = 0x2000;
            cpu.regs.control = 3;
            cpu.regs.primask = 1;
            cpu.regs.basepri = 0x80;
            cpu.ppb.cfsr = 0x123;
            cpu.ppb.hfsr = 0x4000_0000;
            cpu.ppb.vtor = RAM;
            cpu.ppb.syst_csr = 7;
            cpu.ppb.syst_cvr = 30;
            cpu.ppb.syst_rvr = 60;
            (bus.code.as_ptr() as usize, bus.flash.as_ptr() as usize)
        });
        assert!(!spike_upload(4).is_null());
        assert_eq!(spike_restart(), 1);
        assert_eq!(spike_register(0), 0);
        assert_eq!(spike_register(2), 0);
        assert_eq!(spike_register(13), RAM + 512 * 1024);
        assert_eq!(spike_register(14), u32::MAX);
        assert_eq!(spike_pc(), 0x100);
        assert_eq!(spike_cfsr(), 0);
        assert_eq!(spike_hfsr(), 0);
        assert_eq!(spike_fault(), 0);
        assert_eq!(spike_uart_tx_len(1), 0);
        assert_eq!(
            spike_receive_uart(1, 4),
            0,
            "Old-generation upload must be invalidated"
        );
        MACHINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let (cpu, bus) = slot.as_mut().unwrap();
            assert_eq!(cpu.cycles(), 0);
            assert_eq!(cpu.regs.control, 0);
            assert_eq!(cpu.regs.primask, 0);
            assert_eq!(cpu.regs.basepri, 0);
            assert_eq!(cpu.ppb.vtor, 0);
            assert_eq!(cpu.ppb.syst_csr, 0);
            assert_eq!(cpu.ppb.cfsr, 0);
            assert_eq!(cpu.ppb.icsr & ((1 << 26) | (1 << 28)), 0);
            assert!(!cpu.is_halted());
            assert_eq!(bus.code.as_ptr() as usize, code_address);
            assert_eq!(bus.flash.as_ptr() as usize, flash_address);
            assert_eq!(bus.read32(0x1000_4000, 0), 0x1234_abcd);
            assert_eq!(bus.read8(0x11ff_ffff, 0), 0x3c);
            assert_eq!(bus.read8(0x1000_4004, 0), 0xa5);
            assert!(bus.ram.iter().all(|&v| v == 0));
            assert!(bus.frame.iter().all(|&v| v == 0));
            assert!(bus.presented_frame.iter().all(|&v| v == 0));
            assert_eq!(bus.devices.irq_mask(), 0);
            assert_eq!(bus.devices.uart[1].ctrl, 0);
            assert_eq!(bus.devices.uart[1].pending, 0);
            assert!(bus.devices.uart[1].rx.is_empty());
            assert_eq!(bus.devices.timer[0].load, 0);
            assert_eq!(bus.devices.timer[0].ctrl, 0);
            assert_eq!(bus.devices.buttons, 0);
            assert_eq!(bus.devices.frames, 0);
            assert_eq!(bus.devices.alarm, 0);
            assert_eq!(bus.devices.rtc_ctrl, 0);
            assert_eq!(bus.devices.backup[1], 0);
            assert_eq!(bus.wait, 0);
            assert_eq!(bus.fetch, 0);
            assert_eq!(bus.active_pc, 0);
        });
        assert_eq!(spike_run(1), 0);
        assert_eq!(
            spike_register(2),
            42,
            "The vector must execute again from a fresh CPU"
        );
    }

    #[test]
    fn restart_preserves_rtc_second_boundary_and_board_time() {
        load_synthetic_board();
        MACHINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let (_, bus) = slot.as_mut().unwrap();
            bus.devices.epoch = 1_800_000_000;
            bus.devices.rtc_set_at = 123;
            bus.devices.ticks = 123 + 4 * 64_000_000 + 63_999_999;
            assert_eq!(bus.devices.now(), 1_800_000_004);
        });
        let before = spike_ticks();
        assert_eq!(spike_restart(), 1);
        assert_eq!(spike_ticks(), before);
        MACHINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let (_, bus) = slot.as_mut().unwrap();
            assert_eq!(bus.devices.now(), 1_800_000_004);
            bus.devices.advance(bus.devices.ticks + 1);
            assert_eq!(
                bus.devices.now(),
                1_800_000_005,
                "Reset must not discard RTC fractional phase"
            );
        });
        assert_eq!(spike_restart(), 1, "Repeated restart is supported");
        MACHINE.with(|slot| {
            let slot = slot.borrow();
            let (cpu, bus) = slot.as_ref().unwrap();
            assert_eq!(cpu.cycles(), 0);
            assert_eq!(bus.devices.now(), 1_800_000_005);
        });
    }
}

/// Display exports describe the completed, canonical ARGB2222 presentation buffer.
/// Round clipping and backlight are host presentation choices; guest bytes remain intact.
#[unsafe(no_mangle)]
pub extern "C" fn spike_profile() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().map_or(0, |(_, b)| b.profile.id))
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame_width() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.profile.width as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame_height() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.profile.height as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame_len() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.presented_frame.len() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame_format() -> u32 {
    if spike_profile() == 0 { 0 } else { 8 }
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame_stride() -> u32 {
    spike_frame_width()
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_frame_round() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.profile.round as u32)
    })
}
/// Raw guest drawing memory, for oracle/debug capture. It may contain an unfinished update.
#[unsafe(no_mangle)]
pub extern "C" fn spike_guest_frame() -> *const u8 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |(_, b)| b.frame.as_ptr())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_guest_frame_len() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.profile.guest_frame_len() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_guest_frame_stride() -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .as_ref()
            .map_or(0, |(_, b)| b.profile.guest_stride() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn spike_guest_frame_format() -> u32 {
    MACHINE.with(|m| m.borrow().as_ref().map_or(0, |(_, b)| b.profile.guest_bpp))
}
