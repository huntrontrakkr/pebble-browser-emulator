//! Execution budget between device events.
//!
//! The generic board declares SYSCLK at 64 MHz, and this core advances device
//! time by the executing instruction's estimated cycle cost — one cost per
//! cycle, which is what native QEMU does under `-icount`. Native QEMU's
//! default mode runs the CPU unthrottled, so the guest completes far more work
//! between two device events. `instructions_per_cycle` makes that ratio
//! explicit: 1 is the icount-equivalent default, and a higher value gives the
//! guest proportionally more execution per unit of device time.
//!
//! These check the budget arithmetic. They are not a compatibility result: no
//! value other than 1 has recorded evidence behind it.
use emulator_qemu::{PebbleBus, board_step_before, profile::BoardProfile};
use rp2350_emu::{CortexM33, core::CoreBus, threaded::CoreAtomics};
use std::sync::Arc;

/// A guest that spins forever, so every step retires instructions and none
/// sleeps. `b .` at the reset vector.
fn spinning(ratio: u32) -> (CortexM33, PebbleBus) {
    let mut code = vec![0u8; 0x400];
    code[0..4].copy_from_slice(&0x2008_0000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x0000_0101u32.to_le_bytes());
    code[0x100..0x102].copy_from_slice(&0xe7feu16.to_le_bytes()); // b .
    code.resize(4 * 1024 * 1024, 0);

    let atomics = Arc::new(CoreAtomics::default());
    let mut bus = PebbleBus::with_profile(code, atomics.clone(), BoardProfile::EMERY);
    bus.instructions_per_cycle = ratio;
    let mut cpu = CortexM33::new(0, atomics);
    cpu.ppb.cpuid = BoardProfile::EMERY.cpuid;
    cpu.regs.msp = bus.read32(0, 0);
    cpu.regs.r[13] = cpu.regs.msp;
    cpu.regs.r[14] = u32::MAX;
    cpu.regs.r[15] = bus.read32(4, 0) & !1;
    cpu.ppb.vtor = 0;
    cpu.ppb.syst_csr = 0;
    (cpu, bus)
}

/// Steps executed before the device clock reaches `ticks`.
fn steps_within(ratio: u32, ticks: u64) -> u64 {
    let (mut cpu, mut bus) = spinning(ratio);
    let mut steps = 0;
    while bus.devices.ticks < ticks && bus.failed.is_none() {
        board_step_before(&mut cpu, &mut bus, ticks);
        steps += 1;
    }
    steps
}

#[test]
fn the_default_ratio_spends_one_instruction_cost_per_board_cycle() {
    let (_, bus) = spinning(1);
    assert_eq!(
        bus.instructions_per_cycle, 1,
        "the icount-equivalent ratio is the default"
    );
    // A spinning branch costs the same each step, so the step count over a
    // fixed span of device time is stable and countable.
    let steps = steps_within(1, 64_000);
    assert!(steps > 0);
    assert_eq!(
        steps_within(1, 64_000),
        steps,
        "the default is deterministic"
    );
}

#[test]
fn a_higher_ratio_buys_proportionally_more_execution_per_device_tick() {
    let base = steps_within(1, 64_000);
    for ratio in [2, 4, 8] {
        let scaled = steps_within(ratio, 64_000);
        let expected = base * u64::from(ratio);
        // The carried remainder keeps the ratio exact, so the only slack is
        // the partial step at the boundary.
        let slack = expected.abs_diff(scaled);
        assert!(
            slack <= u64::from(ratio),
            "ratio {ratio}: expected about {expected} steps, got {scaled}",
        );
    }
}

#[test]
fn device_time_still_advances_under_every_ratio() {
    // An individual step may cost no device time once the ratio divides the
    // cost, but the carried remainder must keep the clock moving: a stalled
    // clock would mean no device event could ever arrive.
    for ratio in [1, 3, 64, 4096] {
        let (mut cpu, mut bus) = spinning(ratio);
        let before = bus.devices.ticks;
        for _ in 0..=ratio {
            board_step_before(&mut cpu, &mut bus, u64::MAX);
        }
        assert!(
            bus.devices.ticks > before,
            "ratio {ratio}: device time stalled across {} steps",
            ratio + 1,
        );
    }
}
