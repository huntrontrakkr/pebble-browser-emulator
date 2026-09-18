use emulator_qemu::{board_step, boot_profile, checkpoint, profile::BoardProfile};
use std::sync::atomic::Ordering;

fn machine(profile: BoardProfile) -> (rp2350_emu::CortexM33, emulator_qemu::PebbleBus) {
    let mut code = vec![0; 4 * 1024 * 1024];
    code[..4].copy_from_slice(&(0x2000_0000 + profile.ram_bytes as u32).to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    // add r0,#1; b .-2; real guest instructions, no snapshot-specific execution path.
    code[0x100..0x104].copy_from_slice(&[0x01, 0x30, 0xfd, 0xe7]);
    boot_profile(code, profile)
}

#[test]
fn checkpoints_preserve_complete_board_and_instruction_continuation() {
    for profile in [
        BoardProfile::FLINT,
        BoardProfile::EMERY,
        BoardProfile::GABBRO,
    ] {
        let (mut cpu, mut bus) = machine(profile);
        for _ in 0..47 {
            board_step(&mut cpu, &mut bus);
        }
        cpu.regs.s[3] = f32::from_bits(0x7fa12345); // retain NaN payload bits
        cpu.ppb.nvic_ispr[1].store(1 << 4, Ordering::Release);
        cpu.ppb.nvic_ipr[4] = 0xa0204080;
        bus.ram[901] = 73;
        bus.flash[8193] = 69;
        bus.presented_frame[13] = 0xff;
        bus.frame[17] = 0x37;
        bus.devices.uart[1].rx.extend([1, 2, 3]);
        bus.devices.uart[2].tx.extend([4, 5, 6]);
        let bytes = checkpoint::encode(&cpu, &bus);
        assert!(
            bytes.len() < 400000,
            "erased SPI blocks must not be copied into the checkpoint"
        );
        let (mut resumed_cpu, mut resumed_bus) = checkpoint::decode(&bytes, profile).unwrap();
        assert_eq!(checkpoint::encode(&resumed_cpu, &resumed_bus), bytes);
        for _ in 0..113 {
            board_step(&mut cpu, &mut bus);
            board_step(&mut resumed_cpu, &mut resumed_bus);
        }
        assert_eq!(
            checkpoint::encode(&resumed_cpu, &resumed_bus),
            checkpoint::encode(&cpu, &bus)
        );
        assert_eq!(resumed_cpu.regs.s[3].to_bits(), 0x7fa12345);
    }
}

#[test]
fn checkpoints_reject_wrong_board_truncation_and_extra_bytes() {
    let (cpu, bus) = machine(BoardProfile::EMERY);
    let bytes = checkpoint::encode(&cpu, &bus);
    assert!(checkpoint::decode(&bytes, BoardProfile::GABBRO).is_err());
    for size in [0, 8, 100, bytes.len() - 1] {
        assert!(checkpoint::decode(&bytes[..size], BoardProfile::EMERY).is_err());
    }
    let mut extra = bytes.clone();
    extra.push(0);
    assert!(checkpoint::decode(&extra, BoardProfile::EMERY).is_err());
    let mut invalid = bytes;
    invalid[0] ^= 1;
    assert!(checkpoint::decode(&invalid, BoardProfile::EMERY).is_err());
}

#[test]
fn wfi_timer_and_pending_interrupt_continue_from_the_same_boundary() {
    let (mut cpu, mut bus) = machine(BoardProfile::EMERY);
    cpu.ppb.syst_csr = 7;
    cpu.ppb.syst_rvr = 1000;
    cpu.ppb.syst_cvr = 50;
    cpu.halt();
    board_step(&mut cpu, &mut bus);
    assert!(
        bus.devices.ticks > cpu.cycles(),
        "sleep uses the board clock"
    );
    let bytes = checkpoint::encode(&cpu, &bus);
    let (mut resumed_cpu, mut resumed_bus) =
        checkpoint::decode(&bytes, BoardProfile::EMERY).unwrap();
    for _ in 0..25 {
        board_step(&mut cpu, &mut bus);
        board_step(&mut resumed_cpu, &mut resumed_bus);
    }
    assert_eq!(
        checkpoint::encode(&resumed_cpu, &resumed_bus),
        checkpoint::encode(&cpu, &bus)
    );
}
