//! Complete generic-board state. This format is distinct from diagnostic-v1 snapshots.
use crate::{
    PebbleBus,
    peripherals::{Audio, Devices, Timer, Uart},
    profile::BoardProfile,
};
use rp2350_emu::{
    CortexM33,
    core::checkpoint::{Reader, Result, StateValue},
};
const MAGIC: &[u8] = b"PEBBLE-QEMU-STATE\x02";
pub const MAXIMUM: usize = 40 * 1024 * 1024;
macro_rules! fields {
    ($ty:ty { $($field:ident),+ $(,)? }) => { impl StateValue for $ty {
        fn encode(&self, out: &mut Vec<u8>) { let Self { $($field,)+ } = self; $($field.encode(out);)+ }
        fn decode(input: &mut Reader<'_>) -> Result<Self> { Ok(Self { $($field: StateValue::decode(input)?,)+ }) }
    } };
}
impl StateValue for BoardProfile {
    fn encode(&self, out: &mut Vec<u8>) {
        self.id.encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Self::from_id(u32::decode(input)?).ok_or("Unsupported checkpoint board")
    }
}
fields!(Uart {
    ctrl,
    pending,
    rx,
    tx
});
fields!(Timer {
    load,
    ctrl,
    pending,
    divider,
    started
});
fields!(Audio {
    ctrl,
    samplerate,
    intctrl,
    intstat,
    volume,
    ring,
    ring_read,
    ring_write,
    ring_count,
    running,
    stopping,
    started,
    next_drain,
    active_rate,
    samples_sent
});
fields!(Devices {
    profile,
    systick_fraction,
    systick_source,
    uart,
    timer,
    ticks,
    epoch,
    rtc_set_at,
    alarm,
    rtc_ctrl,
    backup,
    buttons,
    edges,
    gpio_ctrl,
    display,
    frames,
    flash_addr,
    sync_len,
    touch,
    audio,
    irq_levels
});

pub fn encode(cpu: &CortexM33, bus: &PebbleBus) -> Vec<u8> {
    let PebbleBus {
        profile,
        atomics: _,
        code,
        ram,
        frame,
        presented_frame,
        flash,
        devices,
        active_pc,
        failed,
        trace: _, // Observation is deliberately outside guest state.
        // Pacing configuration, not guest state: a restored bus takes the
        // default ratio and its caller re-applies any other setting. At the
        // default the remainder is always zero, so the format is unchanged.
        instructions_per_cycle: _,
        cycle_remainder: _,
        wait,
        fetch,
        observed_pending_irqs,
        observed_pending_system,
    } = bus;
    let mut out = MAGIC.to_vec();
    profile.encode(&mut out);
    cpu.encode(&mut out);
    code.encode(&mut out);
    ram.encode(&mut out);
    frame.encode(&mut out);
    presented_frame.encode(&mut out);
    flash.encode(&mut out);
    devices.encode(&mut out);
    active_pc.encode(&mut out);
    failed.encode(&mut out);
    wait.encode(&mut out);
    fetch.encode(&mut out);
    observed_pending_irqs.encode(&mut out);
    observed_pending_system.encode(&mut out);
    out
}
pub fn decode(bytes: &[u8], expected: BoardProfile) -> Result<(CortexM33, PebbleBus)> {
    if bytes.len() > MAXIMUM {
        return Err("Checkpoint is too large");
    }
    let mut input = Reader::new(bytes, MAXIMUM);
    if input.take(MAGIC.len())? != MAGIC {
        return Err("Unsupported checkpoint format");
    }
    let profile = BoardProfile::decode(&mut input)?;
    if profile != expected {
        return Err("Checkpoint belongs to another board");
    }
    let cpu = CortexM33::decode(&mut input)?;
    if !cpu.checkpoint_valid() || cpu.ppb.cpuid != profile.cpuid {
        return Err("Invalid checkpoint CPU state");
    }
    let bus = PebbleBus {
        profile,
        atomics: cpu.checkpoint_atomics(),
        code: StateValue::decode(&mut input)?,
        ram: StateValue::decode(&mut input)?,
        frame: StateValue::decode(&mut input)?,
        presented_frame: StateValue::decode(&mut input)?,
        flash: StateValue::decode(&mut input)?,
        devices: StateValue::decode(&mut input)?,
        active_pc: StateValue::decode(&mut input)?,
        failed: StateValue::decode(&mut input)?,
        trace: crate::trace::Trace::default(),
        instructions_per_cycle: 1,
        cycle_remainder: 0,
        wait: StateValue::decode(&mut input)?,
        fetch: StateValue::decode(&mut input)?,
        observed_pending_irqs: StateValue::decode(&mut input)?,
        observed_pending_system: StateValue::decode(&mut input)?,
    };
    if !input.remaining.is_empty()
        || bus.code.len() != 4 * 1024 * 1024
        || bus.ram.len() != profile.ram_bytes
        || bus.frame.len() != 128 * 1024
        || bus.presented_frame.len() != profile.frame_len()
        || bus.flash.len() != 32 * 1024 * 1024
        || bus.devices.profile != profile
        || bus.devices.rtc_set_at > bus.devices.ticks
        || bus.devices.audio.ring.len() != 4096 * 2
        || bus.devices.audio.ring_read >= 4096
        || bus.devices.audio.ring_write >= 4096
        || bus.devices.audio.ring_count > 4096
        || bus.devices.audio.ctrl > 1
        || bus.devices.audio.intctrl > 1
        || bus.devices.audio.intstat > 1
        || bus.devices.audio.volume > 100
        || (bus.devices.audio.running
            && (bus.devices.audio.started > bus.devices.ticks
                || bus.devices.audio.next_drain <= bus.devices.ticks
                || bus.devices.audio.active_rate == 0))
        || (!bus.devices.audio.running
            && (bus.devices.audio.ring_count != 0 || bus.devices.audio.stopping))
        || cpu.ppb.last_systick_cycles > bus.devices.ticks
        || bus.devices.buttons > 15
        || bus
            .devices
            .uart
            .iter()
            .any(|u| u.rx.len() > 256 || u.tx.len() > 4 * 1024 * 1024)
        || bus
            .devices
            .timer
            .iter()
            .any(|t| t.started > bus.devices.ticks)
    {
        return Err("Invalid checkpoint board state");
    }
    Ok((cpu, bus))
}
