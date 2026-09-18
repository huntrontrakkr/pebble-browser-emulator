//! Execute unchanged slot-0 reset code under explicitly assumed CPU entry state.
//! No clocks, IRQ sources, ROM, PPB or SiFli controllers are supplied by this probe.
use crate::{AccessFault, ImageError, Operation, Revision, SifliAddressSpace};
use rp2350_emu::{CortexM33, core::CoreBus, threaded::CoreAtomics};
use std::{cell::Cell, sync::Arc};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stop {
    Access(AccessFault),
    Exception { pc: u32, cfsr: u32, hfsr: u32 },
    Coprocessor { pc: u32, opcode: u32 },
    Sleeping { pc: u32 },
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
    wrote: bool,
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
    fn read(&self, address: u32, width: u8) -> u32 {
        if self.failure.get().is_some() {
            return 0;
        }
        match self.memory.read(self.pc, address, width, Operation::Read) {
            Ok(value) => value,
            Err(fault) => {
                self.failure.set(Some(fault));
                self.atomics.set_bus_fault(0, address);
                // Required by CoreBus's scalar ABI. The faulted instruction is
                // terminal; this sentinel is never accepted as register data.
                0
            }
        }
    }
    fn write(&mut self, address: u32, width: u8, value: u32) {
        if self.failure.get().is_some() {
            return;
        }
        match self.memory.write(self.pc, address, width, value) {
            Ok(()) => self.wrote = true,
            Err(fault) => {
                self.failure.set(Some(fault));
                self.atomics.set_bus_fault(0, address);
            }
        }
    }
}

impl CoreBus for Bus {
    fn use_internal_peripherals(&self) -> bool {
        false
    }
    fn read8(&mut self, a: u32, _: u8) -> u8 {
        self.read(a, 1) as u8
    }
    fn read16(&mut self, a: u32, _: u8) -> u16 {
        self.read(a, 2) as u16
    }
    fn read32(&mut self, a: u32, _: u8) -> u32 {
        self.read(a, 4)
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
                wrote: false,
            },
            stop: None,
            fault_registers: None,
            instructions_completed: 0,
            steps_attempted: 0,
        })
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
            let fetch = |a| self.bus.memory.read(pc, a, 2, Operation::Fetch);
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
            self.instructions_completed += 1;
            if std::mem::take(&mut self.bus.wrote) {
                self.cpu.invalidate_decode_cache_all();
            }
        }
    }
}
