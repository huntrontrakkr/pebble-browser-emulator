//! The always-on global timer driven by executed guest instructions rather
//! than by calling the model directly. The existing coverage exercises
//! `AonGlobalTimer` and `StartupIo` through host calls, so nothing checked
//! that the documented HAL enable/synchronize sequence reaches the timer
//! through the CPU, that counters advance from executed cycles, or that a
//! command the model does not accept reaches the guest as a structured fault
//! instead of silently succeeding.
//!
//! Register addresses and the enable-then-synchronize order follow UM5201
//! V0.8.8 section 4.3 and the pinned SiFli HAL, as for the model itself.
//! Oscillator frequencies remain uncalibrated nominal values, so this checks
//! sequence and bookkeeping, not silicon timing.
use pebble_sifli_board::{
    FaultKind, Operation, Revision,
    execution::{ResetProbe, Stop},
};

const LP_CR1: u32 = 0x4004_0004;
const LP_COUNT: u32 = 0x4004_0048;
const HP_CR1: u32 = 0x500c_0004;
const HP_COUNT: u32 = 0x500c_0034;
const GTIM_EN: u32 = 1 << 31;

// Reset vector layout shared with the other execution regressions.
const CODE_OFFSET: u32 = 0x1100;
const CODE_ADDRESS: u32 = 0x1202_1100;
const POOL_OFFSET: u32 = 0x1180;
const POOL_ADDRESS: u32 = 0x1202_1180;

/// The model advances one low-power tick per 48 MHz reference tick scaled by
/// the source frequency, so a counter step needs this many executed cycles.
const CYCLES_PER_TICK: u32 = 4_800;

#[derive(Default)]
struct Program {
    words: Vec<u16>,
    pool: Vec<u32>,
}

impl Program {
    fn literal(&mut self, value: u32) -> u32 {
        if let Some(i) = self.pool.iter().position(|v| *v == value) {
            return i as u32;
        }
        self.pool.push(value);
        self.pool.len() as u32 - 1
    }

    /// LDR Rt, [PC, #imm8*4] against the fixed literal pool.
    fn ldr_literal(&mut self, rt: u16, value: u32) {
        let index = self.literal(value);
        let pc = CODE_ADDRESS + 2 * self.words.len() as u32 + 4;
        let target = POOL_ADDRESS + 4 * index;
        let delta = target - (pc & !3);
        assert!(
            delta.is_multiple_of(4) && delta / 4 < 256,
            "literal out of range"
        );
        self.words.push(0x4800 | (rt << 8) | (delta / 4) as u16);
    }

    fn push(&mut self, word: u16) {
        self.words.push(word);
    }

    /// Address of the trailing `b .`, used as the breakpoint so the timer
    /// stops advancing the moment the program is done.
    fn halt(&self) -> u32 {
        assert_eq!(self.words.last(), Some(&0xe7fe), "program must end in b .");
        CODE_ADDRESS + 2 * self.words.len() as u32 - 2
    }

    fn image(&self) -> Vec<u8> {
        let mut image = vec![0xff; 0x1200];
        image[0x1000..0x1004].copy_from_slice(&0x2008_0000u32.to_le_bytes());
        image[0x1004..0x1008].copy_from_slice(&(CODE_ADDRESS | 1).to_le_bytes());
        for (i, word) in self.words.iter().enumerate() {
            let at = CODE_OFFSET as usize + i * 2;
            assert!(at + 2 <= POOL_OFFSET as usize, "code ran into the pool");
            image[at..at + 2].copy_from_slice(&word.to_le_bytes());
        }
        for (i, value) in self.pool.iter().enumerate() {
            let at = POOL_OFFSET as usize + i * 4;
            image[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        image
    }
}

/// Enable the low-power domain, enable the high-power domain, then write the
/// synchronization command — the order the pinned HAL uses.
fn enable_and_synchronize(p: &mut Program) {
    p.ldr_literal(0, LP_CR1);
    p.ldr_literal(1, GTIM_EN);
    p.push(0x6001); // str r1, [r0]
    p.ldr_literal(2, HP_CR1);
    p.push(0x6011); // str r1, [r2]
    p.ldr_literal(3, HP_COUNT);
    p.push(0x2401); // movs r4, #1
    p.push(0x601c); // str r4, [r3]
}

/// `iterations` of `subs`/`bne`, to spend cycles the timer can count.
fn delay(p: &mut Program, iterations: u32) {
    p.ldr_literal(5, iterations);
    p.push(0x3d01); // subs r5, #1
    p.push(0xd1fd); // bne .-2
}

fn start(revision: Revision, p: &Program) -> ResetProbe {
    ResetProbe::new(revision, p.image()).unwrap()
}

#[test]
fn guest_code_enables_synchronizes_and_advances_the_global_timer() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        let mut p = Program::default();
        enable_and_synchronize(&mut p);
        // Read both counters after the sync, before spending any cycles.
        p.push(0x681e); // ldr r6, [r3]
        p.ldr_literal(0, LP_COUNT);
        p.push(0x6807); // ldr r7, [r0]
        p.push(0xe7fe); // b .
        let mut probe = start(revision, &p);

        probe.run(100, Some(p.halt()));
        assert_eq!(probe.stop(), None, "{revision:?}: sequence completed");

        let io = probe.startup_io();
        assert_eq!(
            io.aon_timer.enabled(),
            (true, true),
            "{revision:?}: both domains enabled through the CPU"
        );
        assert_eq!(
            io.aon_timer.sync_writes, 1,
            "{revision:?}: one synchronization accepted"
        );
        let registers = probe.registers();
        assert_eq!(
            registers[6], registers[7],
            "{revision:?}: synchronized counters read equal from the guest"
        );

        // Spend enough cycles for the counter to step, then read it again.
        let before = io.aon_timer.counters();
        assert_eq!(
            registers[6], before.0,
            "{revision:?}: guest read matches the high-power counter"
        );
        let mut spin = Program::default();
        enable_and_synchronize(&mut spin);
        delay(&mut spin, CYCLES_PER_TICK); // one iteration is at least one cycle
        spin.push(0x681e); // ldr r6, [r3]
        spin.ldr_literal(0, LP_COUNT);
        spin.push(0x6807); // ldr r7, [r0]
        spin.push(0xe7fe); // b .
        let mut spun = start(revision, &spin);
        spun.run(100_000, Some(spin.halt()));
        assert_eq!(spun.stop(), None, "{revision:?}: delay completed");
        let after = spun.startup_io().aon_timer.counters();
        assert!(
            after.0 > before.0 && after.1 > before.1,
            "{revision:?}: counters advanced from executed cycles ({before:?} -> {after:?})",
        );
        let registers = spun.registers();
        assert_eq!(
            registers[6], after.0,
            "{revision:?}: guest read matches the advanced high-power counter"
        );
        assert_eq!(
            registers[7], after.1,
            "{revision:?}: guest read matches the low-power counter"
        );
    }
}

#[test]
fn synchronizing_before_both_domains_are_enabled_faults_the_guest() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        let mut p = Program::default();
        // Enable only the low-power domain, then attempt the synchronization.
        p.ldr_literal(0, LP_CR1);
        p.ldr_literal(1, GTIM_EN);
        p.push(0x6001); // str r1, [r0]
        p.ldr_literal(3, HP_COUNT);
        p.push(0x2401); // movs r4, #1
        p.push(0x601c); // str r4, [r3]
        p.push(0xe7fe); // b .
        let mut probe = start(revision, &p);

        probe.run(100, Some(p.halt()));

        match probe.stop() {
            Some(Stop::Access(fault)) => {
                assert_eq!(fault.kind, FaultKind::UnmodeledMmio, "{revision:?}");
                assert_eq!(fault.address, HP_COUNT, "{revision:?}");
                assert_eq!(fault.operation, Operation::Write, "{revision:?}");
            }
            other => panic!("{revision:?}: expected a structured fault, got {other:?}"),
        }
        assert_eq!(
            probe.startup_io().aon_timer.sync_writes,
            0,
            "{revision:?}: no synchronization recorded"
        );
    }
}

#[test]
fn an_unknown_counter_command_faults_instead_of_being_accepted() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        let mut p = Program::default();
        enable_and_synchronize(&mut p);
        // A second command value the model does not define.
        p.push(0x2402); // movs r4, #2
        p.push(0x601c); // str r4, [r3]
        p.push(0xe7fe); // b .
        let mut probe = start(revision, &p);

        probe.run(100, Some(p.halt()));

        match probe.stop() {
            Some(Stop::Access(fault)) => {
                assert_eq!(fault.kind, FaultKind::UnmodeledMmio, "{revision:?}");
                assert_eq!(fault.address, HP_COUNT, "{revision:?}");
            }
            other => panic!("{revision:?}: expected a structured fault, got {other:?}"),
        }
        assert_eq!(
            probe.startup_io().aon_timer.sync_writes,
            1,
            "{revision:?}: only the documented command was accepted"
        );
    }
}
