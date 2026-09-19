//! Separate Wasm ABI for the physical reset probe. No generic-board devices.
use crate::{
    Revision,
    execution::{ResetProbe, Stop},
};
use std::cell::RefCell;
thread_local! {
    static OTP_INPUT: RefCell<Option<Box<[u8;256]>>> = const { RefCell::new(None) };
    static EFUSE_INPUT: RefCell<Option<Box<[u8; 32]>>> = const { RefCell::new(None) };
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static PROBE: RefCell<Option<ResetProbe>> = const { RefCell::new(None) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
fn output(value: serde_json::Value) {
    OUTPUT.with(|o| *o.borrow_mut() = value.to_string().into_bytes());
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_abi_version() -> u32 {
    5
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_input(size: u32) -> *mut u8 {
    if !(0x1008..=64 * 1024 * 1024).contains(&size) {
        INPUT.with(|i| i.borrow_mut().clear());
        return std::ptr::null_mut();
    }
    INPUT.with(|i| {
        let mut i = i.borrow_mut();
        i.resize(size as usize, 0);
        i.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_load(revision: u32) -> u32 {
    PROBE.with(|p| *p.borrow_mut() = None);
    EFUSE_INPUT.with(|i| *i.borrow_mut() = None);
    OTP_INPUT.with(|i| *i.borrow_mut() = None);
    let revision = match revision {
        0 => Revision::ObelixPvt,
        1 => Revision::GetafixDvt2,
        _ => {
            output(serde_json::json!({"error": "unsupported revision"}));
            return 0;
        }
    };
    let slot = INPUT.with(|i| std::mem::take(&mut *i.borrow_mut()));
    match ResetProbe::new(revision, slot) {
        Ok(probe) => {
            PROBE.with(|p| *p.borrow_mut() = Some(probe));
            output(serde_json::json!({"loaded": true}));
            1
        }
        Err(e) => {
            output(serde_json::json!({"error": format!("{e:?}")}));
            0
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_configure_nor(jedec: u32, sr1: u32, sr2: u32) -> u32 {
    PROBE.with(|p| {
        p.borrow_mut()
            .as_mut()
            .is_some_and(|p| p.configure_nor(jedec, sr1, sr2)) as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_otp_input() -> *mut u8 {
    OTP_INPUT.with(|i| i.borrow_mut().insert(Box::new([0; 256])).as_mut_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_load_otp(page: u32) -> u32 {
    let Some(data) = OTP_INPUT.with(|i| i.borrow_mut().take()) else {
        return 0;
    };
    PROBE.with(|p| {
        p.borrow_mut()
            .as_mut()
            .is_some_and(|p| p.supply_otp(page, *data)) as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_set_chip_id(value: u32) -> u32 {
    PROBE.with(|p| {
        p.borrow_mut()
            .as_mut()
            .is_some_and(|p| p.supply_chip_id(value)) as u32
    })
}
/// Separate single-use staging buffer; no default factory data is supplied.
#[unsafe(no_mangle)]
pub extern "C" fn sifli_efuse_input() -> *mut u8 {
    EFUSE_INPUT.with(|i| {
        let mut i = i.borrow_mut();
        let b = i.insert(Box::new([0; 32]));
        b.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_load_efuse_bank(bank: u32) -> u32 {
    let data = EFUSE_INPUT.with(|i| i.borrow_mut().take());
    let Some(data) = data else {
        return 0;
    };
    PROBE.with(|p| {
        p.borrow_mut()
            .as_mut()
            .is_some_and(|p| p.supply_efuse(bank as usize, *data)) as u32
    })
}
/// Configure a loaded but unexecuted probe. u32::MAX injects crystal failure.
#[unsafe(no_mangle)]
pub extern "C" fn sifli_configure_hxt(startup_ticks: u32) -> u32 {
    PROBE.with(|p| {
        p.borrow_mut().as_mut().is_some_and(|p| {
            p.configure_hxt((startup_ticks != u32::MAX).then_some(startup_ticks as u64))
        }) as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_run(budget: u32, breakpoint: u32) -> u32 {
    PROBE.with(|p| {
        let mut p = p.borrow_mut();
        let Some(p) = p.as_mut() else {
            output(serde_json::json!({"error": "no probe loaded"}));
            return 0;
        };
        p.run(budget, (breakpoint != 0).then_some(breakpoint));
        let stop = p.stop();
        let system = p.system();
        output(serde_json::json!({
            "revision": format!("{:?}", p.revision()),
            "instructionsCompleted": p.instructions_completed, "stepsAttempted": p.steps_attempted,
            "registers": p.registers(), "msplim": p.msplim(), "psplim": p.psplim(),
            "stop": stop.map(|s| match s {
                Stop::Access(f) => serde_json::json!({"type":"access", "pc":f.pc,
                    "address": f.address, "width": f.width, "operation": format!("{:?}",f.operation),
                    "kind": format!("{:?}",f.kind)}),
                Stop::Exception{pc,cfsr,hfsr} => serde_json::json!({"type":"exception","pc":pc,"cfsr":cfsr,"hfsr":hfsr}),
                Stop::Coprocessor{pc,opcode} => serde_json::json!({"type":"unsupported-coprocessor","pc":pc,"opcode":opcode}),
                Stop::Sleeping{pc} => serde_json::json!({"type":"sleeping-without-wake-model","pc":pc}),
            }),
            "lcpuReset": {"cpuWait":p.startup_io().lcpu.halted(),
                "assertedMask":p.startup_io().lcpu.asserted(),
                "assertions":p.startup_io().lcpu.reset_assertions,
                "releases":p.startup_io().lcpu.reset_releases,
                "entryState":"assumed-active-awaiting-reset", "executesLcpu":false},
            "nor": {"profile":if p.startup_io().mpi.nor.is_some(){"caller-selected-w25q128jv"}else{"missing"},
                "otpLoadedMask":p.startup_io().mpi.nor.as_ref().map_or(0,|n|n.otp_mask()),
                "commandsCompleted":p.startup_io().mpi.commands_completed,
                "otpBytesRead":p.startup_io().mpi.otp_bytes_read,"lastCommand":p.startup_io().mpi.last_command,
                "timingVerified":false},
            "calibration": {"chipId":p.startup_io().calibration.chip_id,
                "vret":p.startup_io().calibration.vret,"aonBg":p.startup_io().calibration.aon_bg,
                "buck":p.startup_io().calibration.buck,"periLdo":p.startup_io().calibration.peri_ldo,
                "hpVout":p.startup_io().calibration.hp_vout,"lpVout":p.startup_io().calibration.lp_vout,
                "buckVout":p.startup_io().calibration.buck_vout,
                "analogVerified":false},
            "factoryData": {"loadedBankMask":p.startup_io().efuse.loaded_mask(),
                "readsCompleted":p.startup_io().efuse.reads_completed,
                "source": if p.startup_io().efuse.loaded_mask() == 0 {"missing"} else {"caller-supplied-unverified"}},
            "clock": {"estimatedCoreCycles": p.clock().estimated_cycles,
                "referenceTicks48MHz": p.clock().reference_ticks, "hxtReady": p.clock().hxt_ready(),
                "hxtStartupTicks": p.clock().hxt_startup_ticks, "timingVerified": false},
            "globalTimer": {"enabled": p.startup_io().aon_timer.enabled(),
                "counters": p.startup_io().aon_timer.counters(),
                "synchronizations": p.startup_io().aon_timer.sync_writes,
                "sourceHz": p.startup_io().pmuc.low_power_hz(), "timingVerified": false},
            "usart1": {"transmitterEnabled": p.startup_io().usart1.transmitter_enabled(),
                "bytesTransmitted": p.startup_io().usart1.bytes_transmitted,
                "configurations": p.startup_io().usart1.configurations,
                "baudDivisor": p.startup_io().usart1.baud_divisor(),
                "pins": p.startup_io().system_config.usart1_pins(),
                "transmitted": String::from_utf8_lossy(p.startup_io().usart1.transmitted()).to_string(),
                "timingVerified": false},
            "pmucClock": {"rc32Ready": p.startup_io().pmuc.lrc32_ready(),
                "rc32StartupTicks": p.startup_io().pmuc.lrc32_startup_ticks,
                "lowPowerHz": p.startup_io().pmuc.low_power_hz(), "timingVerified": false},
            "lpsysClock": {"peripheralSource": if p.startup_io().lpsys_clock.peripheral_uses_hxt48(){"hxt48"}else{"hrc48"},
                "sourceChanges": p.startup_io().lpsys_clock.peripheral_source_changes,
                "timingVerified": false},
            "hrcCalibration": {"measurementsCompleted": p.startup_io().hrc_calibration.measurements_completed,
                "done": p.startup_io().hrc_calibration.done(), "analogVerified": false,
                "timingVerified": false},
            "dll": {"dll1Ready": p.startup_io().dll.dll1_ready(),
                "locksCompleted": p.startup_io().dll.locks_completed,
                "analogVerified": false, "timingVerified": false},
            "sipPins": {"analogTransitions": p.startup_io().sip_pinmux.analog_transitions,
                "electricalBehaviorVerified": false},
            "wakeupSources": {"enabledMask": p.startup_io().hpaon_wakeup.enabled(),
                "eventsInjected": 0},
            "watchdog": {"active": p.startup_io().watchdog.active(),
                "starts": p.startup_io().watchdog.starts,
                "stops": p.startup_io().watchdog.stops,
                "countdownTimingVerified": false},
            "system": {"vtor":system.vtor, "cpacr":system.cpacr, "shcsr":system.shcsr,
                "ccr":system.ccr, "mpuControl":system.ctrl, "mpuRegions":system.regions, "mair":system.mair},
            "registerState": if stop.is_some() {"last-completed-instruction"} else {"current"},
            "bootComplete": false, "entryState": "assumed-secure-reset-probe-v2"
        }));
        if stop.is_some() { 2 } else { 1 }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_read_cpu_byte(address: u32) -> u32 {
    PROBE.with(|p| {
        p.borrow()
            .as_ref()
            .and_then(|p| p.read_cpu_byte(address).ok())
            .unwrap_or(u32::MAX)
    })
}
// Inspection has a distinct failure sentinel and never initializes memory.
#[unsafe(no_mangle)]
pub extern "C" fn sifli_read_byte(address: u32) -> u32 {
    PROBE.with(|p| {
        p.borrow()
            .as_ref()
            .and_then(|p| p.read(address, 1).ok())
            .unwrap_or(u32::MAX)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn sifli_output_len() -> u32 {
    OUTPUT.with(|o| o.borrow().len() as u32)
}
