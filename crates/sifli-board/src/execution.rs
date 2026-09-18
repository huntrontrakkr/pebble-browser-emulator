//! Execute unchanged slot-0 reset code under explicitly assumed CPU entry state.
//! Architectural startup, MPU and functional caches; clocks/SoC devices remain separate.
use crate::{AccessFault, ImageError, Operation, Revision, SifliAddressSpace};
use crate::{
    cache::Cache,
    system::{Maintenance, Policy, SystemControl},
};
use rp2350_emu::{CortexM33, core::CoreBus, threaded::CoreAtomics};
use std::{cell::Cell, sync::Arc};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stop {
    Access(AccessFault),
    Exception { pc: u32, cfsr: u32, hfsr: u32 },
    Coprocessor { pc: u32, opcode: u32 },
    Sleeping { pc: u32 },
}

#[cfg(test)]
mod cache_execution_tests {
    use super::*;
    #[test]
    fn cpu_fetch_observes_instruction_cache_until_invalidation() {
        let mut slot = vec![0; 0x1200];
        slot[0x1000..0x1004].copy_from_slice(&0x20080000u32.to_le_bytes());
        slot[0x1004..0x1008].copy_from_slice(&0x12021101u32.to_le_bytes());
        let mut p = ResetProbe::new(Revision::ObelixPvt, slot).unwrap();
        let ram = 0x20020000;
        p.bus.memory.write(0, ram, 2, 0x2001).unwrap(); // MOVS r0,#1
        p.bus.system.ccr |= 1 << 17;
        p.cpu.regs.r[15] = ram;
        p.run(1, None);
        assert_eq!(p.cpu.regs.r[0], 1);
        // A bus-master write does not update the CPU's instruction cache.
        p.bus.memory.write(0, ram, 2, 0x2002).unwrap();
        p.cpu.regs.r[15] = ram;
        p.run(1, None);
        assert_eq!(p.cpu.regs.r[0], 1);
        p.bus.access_write(0xe000ef50, 4, 0).unwrap();
        p.cpu.regs.r[15] = ram;
        p.run(1, None);
        assert_eq!(p.cpu.regs.r[0], 2);
        assert_eq!(p.stop(), None);
    }
}

#[derive(Debug)]
pub enum EntryError {
    Image(ImageError),
    Access(AccessFault),
    InvalidVector,
}

struct Bus {
    memory: SifliAddressSpace,
    atomics: Arc<CoreAtomics>,
    failure: Cell<Option<AccessFault>>,
    pc: u32,
    wait: u32,
    fetch: u32,
    system: SystemControl,
    debug: crate::debug_counter::DebugCounter,
    icache: Cache,
    dcache: Cache,
    privileged: bool,
    io: crate::startup_io::StartupIo,
}

impl Bus {
    fn fail(&self, address: u32, width: u8, operation: Operation) {
        let fault = self
            .memory
            .read(self.pc, address, width, operation)
            .unwrap_err();
        self.failure.set(self.failure.get().or(Some(fault)));
        self.atomics.set_bus_fault(0, address);
    }
    fn record(&self, fault: AccessFault) {
        self.failure.set(self.failure.get().or(Some(fault)));
        self.atomics.set_bus_fault(0, fault.address);
    }
    fn error(
        &self,
        address: u32,
        width: u8,
        operation: Operation,
        kind: crate::FaultKind,
    ) -> AccessFault {
        AccessFault {
            revision: self.memory.revision(),
            pc: self.pc,
            address,
            width,
            operation,
            kind,
        }
    }
    fn access_read(&mut self, address: u32, width: u8, op: Operation) -> Result<u32, AccessFault> {
        let policy = self
            .system
            .access(address, width, op, self.privileged)
            .map_err(|k| self.error(address, width, op, k))?;
        if crate::startup_io::StartupIo::owns(address) {
            return self
                .io
                .read(address, width)
                .map_err(|k| self.error(address, width, op, k));
        }
        if crate::debug_counter::DebugCounter::owns(address) {
            return self
                .debug
                .read(address, width)
                .map_err(|k| self.error(address, width, op, k));
        }
        if (0xe0000000..0xf0000000).contains(&address) {
            return self
                .system
                .read(address, width, self.privileged)
                .map_err(|k| self.error(address, width, op, k));
        }
        if op == Operation::Fetch
            && self.system.ccr & (1 << 17) != 0
            && matches!(policy, Policy::WriteThrough | Policy::WriteBack)
        {
            self.icache
                .read(&mut self.memory, self.pc, address, width, op)
        } else if op == Operation::Read
            && self.system.ccr & (1 << 16) != 0
            && matches!(policy, Policy::WriteThrough | Policy::WriteBack)
        {
            self.dcache
                .read(&mut self.memory, self.pc, address, width, op)
        } else {
            self.memory.read(self.pc, address, width, op)
        }
    }
    fn read(&mut self, address: u32, width: u8, op: Operation) -> u32 {
        if self.failure.get().is_some() {
            return 0;
        }
        match self.access_read(address, width, op) {
            Ok(v) => v,
            Err(f) => {
                self.record(f);
                0
            }
        }
    }
    fn access_write(&mut self, address: u32, width: u8, value: u32) -> Result<(), AccessFault> {
        let op = Operation::Write;
        let policy = self
            .system
            .access(address, width, op, self.privileged)
            .map_err(|k| self.error(address, width, op, k))?;
        if crate::startup_io::StartupIo::owns(address) {
            return self
                .io
                .write(address, width, value)
                .map_err(|k| self.error(address, width, op, k));
        }
        if crate::debug_counter::DebugCounter::owns(address) {
            return self
                .debug
                .write(address, width, value)
                .map_err(|k| self.error(address, width, op, k));
        }
        if (0xe0000000..0xf0000000).contains(&address) {
            let action = self
                .system
                .write(address, width, value, self.privileged)
                .map_err(|k| self.error(address, width, op, k))?;
            match action {
                Maintenance::None => {}
                Maintenance::InstructionAll => self.icache.invalidate_all(),
                Maintenance::InstructionAddress(a) => self.icache.invalidate_address(a),
                Maintenance::Data {
                    value,
                    by_set,
                    clean,
                    invalidate,
                } => self.dcache.maintain(
                    &mut self.memory,
                    self.pc,
                    value,
                    by_set,
                    clean,
                    invalidate,
                )?,
            }
            return Ok(());
        }
        if self.system.ccr & (1 << 16) != 0
            && matches!(policy, Policy::WriteThrough | Policy::WriteBack)
        {
            self.dcache
                .write(&mut self.memory, self.pc, address, width, value, policy)
        } else {
            self.memory.write(self.pc, address, width, value)
        }
    }
    fn write(&mut self, address: u32, width: u8, value: u32) {
        if self.failure.get().is_some() {
            return;
        }
        if let Err(f) = self.access_write(address, width, value) {
            self.record(f);
        }
    }
}

impl CoreBus for Bus {
    fn fetch16(&mut self, a: u32, _: u8) -> u16 {
        self.read(a, 2, Operation::Fetch) as u16
    }
    fn cache_decoded_instructions(&self) -> bool {
        false
    }

    fn use_internal_peripherals(&self) -> bool {
        false
    }
    fn read8(&mut self, a: u32, _: u8) -> u8 {
        self.read(a, 1, Operation::Read) as u8
    }
    fn read16(&mut self, a: u32, _: u8) -> u16 {
        self.read(a, 2, Operation::Read) as u16
    }
    fn read32(&mut self, a: u32, _: u8) -> u32 {
        self.read(a, 4, Operation::Read)
    }
    fn write8(&mut self, a: u32, v: u8, _: u8) {
        self.write(a, 1, v as u32)
    }
    fn write16(&mut self, a: u32, v: u16, _: u8) {
        self.write(a, 2, v as u32)
    }
    fn write32(&mut self, a: u32, v: u32, _: u8) {
        self.write(a, 4, v)
    }
    fn set_active_pc(&mut self, pc: u32, _: u8) {
        self.pc = pc
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
    fn gpio_read_out(&self) -> u32 {
        self.fail(0xd0000010, 4, Operation::Read);
        0
    }
    fn gpio_write_out(&mut self, v: u32) {
        self.write(0xd0000010, 4, v)
    }
    fn gpio_set_out(&mut self, v: u32) {
        self.write(0xd0000014, 4, v)
    }
    fn gpio_clear_out(&mut self, v: u32) {
        self.write(0xd0000018, 4, v)
    }
    fn gpio_xor_out(&mut self, v: u32) {
        self.write(0xd000001c, 4, v)
    }
    fn gpio_read_oe(&self) -> u32 {
        self.fail(0xd0000020, 4, Operation::Read);
        0
    }
    fn gpio_write_oe(&mut self, v: u32) {
        self.write(0xd0000020, 4, v)
    }
    fn gpio_set_oe(&mut self, v: u32) {
        self.write(0xd0000024, 4, v)
    }
    fn gpio_clear_oe(&mut self, v: u32) {
        self.write(0xd0000028, 4, v)
    }
    fn gpio_xor_oe(&mut self, v: u32) {
        self.write(0xd000002c, 4, v)
    }
    fn gpio_read_in(&self) -> u32 {
        self.fail(0xd0000004, 4, Operation::Read);
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

pub struct ResetProbe {
    cpu: CortexM33,
    bus: Bus,
    stop: Option<Stop>,
    fault_registers: Option<[u32; 16]>,
    pub instructions_completed: u64,
    pub steps_attempted: u64,
}

impl ResetProbe {
    /// Assumptions: Secure privileged Thread mode, Thumb, interrupts inactive,
    /// reset engine register defaults, MSP/PC from the slot-0 vector table.
    /// These are a probe contract, not measured post-bootloader state.
    pub fn new(revision: Revision, slot: Vec<u8>) -> Result<Self, EntryError> {
        let memory = SifliAddressSpace::new(revision, slot).map_err(EntryError::Image)?;
        let msp = memory
            .read(0, 0x12021000, 4, Operation::Read)
            .map_err(EntryError::Access)?;
        let reset = memory
            .read(0, 0x12021004, 4, Operation::Read)
            .map_err(EntryError::Access)?;
        if reset & 1 == 0 || msp & 7 != 0 || !(0x20000008..=0x20080000).contains(&msp) {
            return Err(EntryError::InvalidVector);
        }
        memory
            .read(reset & !1, reset & !1, 2, Operation::Fetch)
            .map_err(EntryError::Access)?;
        let atomics = Arc::new(CoreAtomics::default());
        let mut cpu = CortexM33::new(0, atomics.clone());
        cpu.regs.msp = msp;
        cpu.regs.r[13] = msp;
        cpu.regs.r[14] = u32::MAX;
        cpu.regs.r[15] = reset & !1;
        cpu.ppb.vtor = 0x12021000;
        Ok(Self {
            cpu,
            bus: Bus {
                memory,
                atomics,
                failure: Cell::new(None),
                pc: reset & !1,
                wait: 0,
                fetch: 0,
                system: SystemControl::default(),
                debug: crate::debug_counter::DebugCounter::default(),
                icache: Cache::instruction(),
                dcache: Cache::data(),
                privileged: true,
                // Documented RTC backup-domain POR values (UM5201 §9.7).
                // This probe assumes a newly powered backup domain; it does
                // not stand in for a captured warm-boot retention image.
                io: crate::startup_io::StartupIo::default(),
            },
            stop: None,
            fault_registers: None,
            instructions_completed: 0,
            steps_attempted: 0,
        })
    }

    /// Configure oscillator startup before execution. None injects crystal failure.
    /// The ticks are nominal 48MHz reference ticks, not wall-clock or measured cycles.
    pub fn configure_hxt(&mut self, startup_ticks: Option<u64>) -> bool {
        if self.steps_attempted != 0 || self.stop.is_some() {
            return false;
        }
        self.bus.io.clock.hxt_startup_ticks = startup_ticks;
        true
    }

    pub fn supply_chip_id(&mut self, value: u32) -> bool {
        if self.steps_attempted != 0 || self.stop.is_some() {
            return false;
        }
        self.bus.io.calibration.chip_id = Some(value);
        true
    }
    pub fn supply_efuse(&mut self, bank: usize, bytes: [u8; 32]) -> bool {
        if self.steps_attempted != 0 || self.stop.is_some() {
            return false;
        }
        self.bus.io.efuse.supply(bank, bytes)
    }
    pub fn startup_io(&self) -> &crate::startup_io::StartupIo {
        &self.bus.io
    }

    pub fn clock(&self) -> &crate::clock::BootClock {
        &self.bus.io.clock
    }

    pub fn system(&self) -> &SystemControl {
        &self.bus.system
    }

    pub fn registers(&self) -> [u32; 16] {
        self.fault_registers.unwrap_or(self.cpu.regs.r)
    }
    pub fn msplim(&self) -> u32 {
        self.cpu.regs.msplim
    }
    pub fn psplim(&self) -> u32 {
        self.cpu.regs.psplim
    }
    pub fn stop(&self) -> Option<Stop> {
        self.stop
    }
    pub fn revision(&self) -> Revision {
        self.bus.memory.revision()
    }
    /// Non-mutating CPU-visible data inspection. Does not read peripherals or
    /// clean dirty cache lines; backing-memory inspection remains separate.
    pub fn read_cpu_byte(&self, address: u32) -> Result<u32, AccessFault> {
        self.bus
            .memory
            .region(self.cpu.regs.pc(), address, 1, Operation::Read)?;
        let policy = self
            .bus
            .system
            .access(address, 1, Operation::Read, self.bus.privileged)
            .map_err(|k| self.bus.error(address, 1, Operation::Read, k))?;
        if self.bus.system.ccr & (1 << 16) != 0
            && matches!(policy, Policy::WriteThrough | Policy::WriteBack)
            && let Some(value) = self.bus.dcache.peek_byte(address)
        {
            return value
                .map(u32::from)
                .map_err(|k| self.bus.error(address, 1, Operation::Read, k));
        }
        self.read(address, 1)
    }
    pub fn read(&self, address: u32, width: u8) -> Result<u32, AccessFault> {
        self.bus
            .memory
            .read(self.cpu.regs.pc(), address, width, Operation::Read)
    }

    /// Bounded batches allow a Worker to yield or be terminated. Breakpoints
    /// stop BEFORE an instruction; a terminal fault cannot be resumed.
    pub fn run(&mut self, budget: u32, breakpoint: Option<u32>) {
        for _ in 0..budget.min(100_000) {
            let pc = self.cpu.regs.pc();
            if self.stop.is_some() || breakpoint == Some(pc) {
                return;
            }
            if self.bus.atomics.is_halted(0) || self.bus.atomics.is_wfe_waiting(0) {
                self.stop = Some(Stop::Sleeping { pc });
                return;
            }
            self.bus.pc = pc;
            self.bus.privileged = self.cpu.regs.ipsr() != 0 || self.cpu.regs.control & 1 == 0;
            let mut fetch = |a| self.bus.access_read(a, 2, Operation::Fetch);
            let hw = match fetch(pc) {
                Ok(v) => v,
                Err(e) => {
                    self.stop = Some(Stop::Access(e));
                    return;
                }
            };
            if hw & 0xf800 >= 0xe800 {
                let hi = match fetch(pc.wrapping_add(2)) {
                    Ok(v) => v,
                    Err(e) => {
                        self.stop = Some(Stop::Access(e));
                        return;
                    }
                };
                // Do not inherit RP2350 coprocessors or unverified FP behavior.
                if hw & 0xec00 == 0xec00 {
                    self.stop = Some(Stop::Coprocessor {
                        pc,
                        opcode: hw << 16 | hi,
                    });
                    return;
                }
            }
            self.steps_attempted += 1;
            let before = self.cpu.regs.r;
            self.cpu.ppb.vtor = self.bus.system.vtor;
            self.cpu.ppb.cpacr = self.bus.system.cpacr;
            self.cpu.ppb.shcsr = self.bus.system.shcsr;
            self.cpu.ppb.ccr = self.bus.system.ccr;
            let cycles_before = self.cpu.cycles();
            self.cpu.step(&mut self.bus);
            if let Some(e) = self.bus.failure.get() {
                self.fault_registers = Some(before);
                self.stop = Some(Stop::Access(e));
                return;
            }
            if self.cpu.regs.ipsr() != 0 || self.cpu.ppb.cfsr != 0 || self.cpu.ppb.hfsr != 0 {
                self.fault_registers = Some(before);
                self.stop = Some(Stop::Exception {
                    pc,
                    cfsr: self.cpu.ppb.cfsr,
                    hfsr: self.cpu.ppb.hfsr,
                });
                return;
            }
            self.bus
                .debug
                .advance(self.cpu.cycles().wrapping_sub(cycles_before));
            self.bus
                .io
                .advance(self.cpu.cycles().wrapping_sub(cycles_before));
            self.instructions_completed += 1;
        }
    }
}
