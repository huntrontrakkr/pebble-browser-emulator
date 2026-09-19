//! Boot unchanged official QEMU firmware natively and print deterministic state
//! digests plus host throughput. Use it to check that a CPU change leaves
//! fault-free firmware execution byte-identical, and to compare speed.
//!
//! ```sh
//! gzip -dc public/firmware/v4.37.0/qemu_emery_v4.37.0_micro_flash.bin.gz > /tmp/micro.bin
//! gzip -dc public/firmware/v4.37.0/qemu_emery_v4.37.0_spi_flash.bin.gz > /tmp/spi.bin
//! cargo run --release -p emulator-qemu --example native_boot -- emery /tmp/micro.bin /tmp/spi.bin 20
//! ```
//!
//! The clock epoch is fixed, so repeated runs of one core are identical. The
//! digests are FNV-1a 64 over the presented frame, guest RAM and all UART
//! output. Host time measures this machine, not watch or browser performance.
use emulator_qemu::{PebbleBus, board_step_before, profile::BoardProfile};
use rp2350_emu::{CortexM33, core::CoreBus, threaded::CoreAtomics};
use std::{sync::Arc, time::Instant};

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ *byte as u64).wrapping_mul(0x0100_0000_01b3)
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, profile, micro, spi, seconds] = &args[..] else {
        eprintln!(
            "usage: native_boot <flint|emery|gabbro> <micro.bin> <spi.bin> <virtual seconds>"
        );
        std::process::exit(2);
    };
    let profile = match profile.as_str() {
        "flint" => BoardProfile::FLINT,
        "emery" => BoardProfile::EMERY,
        "gabbro" => BoardProfile::GABBRO,
        other => panic!("unknown profile {other}"),
    };
    let seconds: f64 = seconds.parse().expect("virtual seconds");
    let mut code = std::fs::read(micro).expect("micro flash image");
    code.resize(4 * 1024 * 1024, 0);
    let flash = std::fs::read(spi).expect("SPI flash image");
    assert_eq!(flash.len(), 32 * 1024 * 1024, "SPI flash image size");

    // Same initial state as `spike_boot_profile` followed by a fixed epoch.
    let atomics = Arc::new(CoreAtomics::default());
    let mut bus = PebbleBus::with_profile(code, atomics.clone(), profile);
    bus.flash = flash;
    let mut cpu = CortexM33::new(0, atomics);
    cpu.ppb.cpuid = profile.cpuid;
    cpu.regs.msp = bus.read32(0, 0);
    cpu.regs.r[13] = cpu.regs.msp;
    cpu.regs.r[14] = u32::MAX;
    cpu.regs.r[15] = bus.read32(4, 0) & !1;
    cpu.ppb.vtor = 0;
    cpu.ppb.syst_csr = 0;
    bus.devices.epoch = 1_700_000_000;
    bus.devices.rtc_set_at = bus.devices.ticks;

    let deadline = (seconds * 64_000_000.0) as u64;
    let start = Instant::now();
    let mut steps: u64 = 0;
    while bus.devices.ticks < deadline && bus.failed.is_none() {
        board_step_before(&mut cpu, &mut bus, deadline);
        steps += 1;
    }
    let host = start.elapsed().as_secs_f64();
    let uart: Vec<u8> = bus
        .devices
        .uart
        .iter()
        .flat_map(|u| u.tx.iter().copied())
        .collect();
    println!(
        "profile={} virtual_s={:.3} steps={steps} cycles={} frames={} frame_fnv={:016x} ram_fnv={:016x} uart_bytes={} uart_fnv={:016x} pc={:#x} cfsr={:#x} hfsr={:#x} failed={:?} host_s={host:.3} steps_per_s={:.0}",
        profile.name,
        bus.devices.ticks as f64 / 64e6,
        cpu.cycles(),
        bus.devices.frames,
        fnv1a(&bus.presented_frame),
        fnv1a(&bus.ram),
        uart.len(),
        fnv1a(&uart),
        cpu.regs.pc(),
        cpu.ppb.cfsr,
        cpu.ppb.hfsr,
        bus.failed,
        steps as f64 / host,
    );
}
