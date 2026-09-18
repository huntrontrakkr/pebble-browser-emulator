use emulator_qemu::{peripherals::Devices, profile::BoardProfile};

const CTRL: u32 = 0x4001_2000;
const DATA: u32 = CTRL + 12;
const INTCTRL: u32 = CTRL + 16;
const INTSTAT: u32 = CTRL + 20;
const FREE: u32 = CTRL + 24;
const IRQ_AUDIO: u32 = 1 << 10;

fn write(devices: &mut Devices, address: u32, value: u32) {
    assert!(devices.write(address, value, &mut []));
}

#[test]
fn speaker_start_refill_and_graceful_stop_follow_virtual_time() {
    let mut d = Devices::with_profile(BoardProfile::EMERY);
    assert_eq!(d.read(FREE), Some(4096));
    write(&mut d, INTCTRL, 1);
    write(&mut d, CTRL, 1);
    assert_eq!(d.read(INTSTAT), Some(1));
    assert_eq!(d.irq_mask() & IRQ_AUDIO, IRQ_AUDIO);
    for sample in 0..512 {
        write(&mut d, DATA, sample);
    }
    assert_eq!(d.read(FREE), Some(4096 - 512));
    write(&mut d, INTSTAT, 1);
    assert_eq!(d.irq_mask() & IRQ_AUDIO, 0);
    d.advance(640_000);
    assert_eq!(d.read(FREE), Some(4096 - 352));
    assert_eq!(d.irq_mask() & IRQ_AUDIO, IRQ_AUDIO);
    write(&mut d, CTRL, 0);
    assert_eq!(d.irq_mask() & IRQ_AUDIO, 0);
    d.advance(3_200_000);
    assert!(!d.audio.running);
    assert_eq!(d.read(FREE), Some(4096));
}

#[test]
fn refill_irq_waits_for_1024_free_samples_and_ring_never_overflows() {
    let mut d = Devices::with_profile(BoardProfile::FLINT);
    write(&mut d, INTCTRL, 1);
    write(&mut d, CTRL, 1);
    for sample in 0..5000 {
        write(&mut d, DATA, sample);
    }
    assert_eq!(d.read(FREE), Some(0));
    write(&mut d, INTSTAT, 1);
    for step in 1..=6 {
        d.advance(step * 640_000);
        assert_eq!(d.irq_mask() & IRQ_AUDIO, 0);
    }
    d.advance(7 * 640_000);
    assert_eq!(d.read(FREE), Some(1120));
    assert_eq!(d.irq_mask() & IRQ_AUDIO, IRQ_AUDIO);
}

#[test]
fn audio_is_absent_on_gabbro_and_null_sink_credit_tracks_elapsed_time() {
    let mut d = Devices::with_profile(BoardProfile::GABBRO);
    assert_eq!(d.read(CTRL), None);
    assert!(!d.write(CTRL, 1, &mut []));
    d = Devices::with_profile(BoardProfile::EMERY);
    write(&mut d, CTRL + 8, 8000);
    write(&mut d, CTRL, 1);
    d.advance(64_000_000);
    for sample in 0..4096 {
        write(&mut d, DATA, sample);
    }
    d.advance(64_640_000);
    assert_eq!(d.read(FREE), Some(4096));
}
