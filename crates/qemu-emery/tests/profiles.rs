use emulator_qemu::{
    boot_profile, profile::BoardProfile, spike_boot_profile, spike_frame_format,
    spike_frame_height, spike_frame_len, spike_frame_round, spike_frame_stride, spike_frame_width,
    spike_guest_frame_format, spike_guest_frame_len, spike_guest_frame_stride, spike_profile,
    spike_restart, spike_upload,
};
use rp2350_emu::core::CoreBus;
fn code(msp: u32) -> Vec<u8> {
    let mut b = vec![0; 0x44];
    b[..4].copy_from_slice(&msp.to_le_bytes());
    b[4..8].copy_from_slice(&0x41u32.to_le_bytes());
    b[0x40..].copy_from_slice(&[0xfe, 0xe7, 0, 0]);
    b
}
#[test]
fn profile_registers_memory_and_cpuid_match_reference() {
    for p in [
        BoardProfile::FLINT,
        BoardProfile::EMERY,
        BoardProfile::GABBRO,
    ] {
        let (mut c, mut b) = boot_profile(code(0x20000000 + p.ram_bytes as u32), p);
        assert_eq!(b.ram.len(), p.ram_bytes);
        assert_eq!(b.presented_frame.len(), p.width * p.height);
        assert_eq!(c.ppb.read32(0xe000ed00), p.cpuid);
        for (offset, value) in [
            (0, p.id),
            (4, p.features()),
            (8, p.width as u32),
            (12, p.height as u32),
            (16, p.guest_bpp),
        ] {
            assert_eq!(b.read32(0x40007000 + offset, 0), value);
        }
        assert_eq!(b.read32(0x40008014, 0), p.round as u32);
        assert_eq!(b.devices.read(0x40011000).is_some(), p.touch);
        assert_eq!(b.devices.read(0x40012000).is_some(), p.audio);
        b.write8(0x20000000 + p.ram_bytes as u32 - 1, 0x5a, 0);
        assert_eq!(b.read8(0x20000000 + p.ram_bytes as u32 - 1, 0), 0x5a);
        assert!(b.failed.is_none());
        b.read8(0x20000000 + p.ram_bytes as u32, 0);
        assert!(b.failed.is_some());
    }
}
#[test]
fn monochrome_presentation_obeys_lsb_first_padding_and_completed_updates() {
    let (_, mut b) = boot_profile(code(0x20040000), BoardProfile::FLINT);
    b.frame[0] = 0x81;
    b.frame[17] = 0x80;
    b.frame[18] = 255;
    b.frame[19] = 255;
    b.frame[20] = 2;
    assert!(b.presented_frame.iter().all(|&v| v == 0));
    b.write32(0x40008000, 3, 0);
    assert_eq!(b.presented_frame[0], 255);
    assert_eq!(b.presented_frame[1], 0xc0);
    assert_eq!(b.presented_frame[7], 255);
    assert_eq!(b.presented_frame[143], 255);
    assert_eq!(b.presented_frame[144], 0xc0);
    assert_eq!(b.presented_frame[145], 255);
    b.frame[0] = 0;
    assert_eq!(b.presented_frame[0], 255);
    b.write32(0x40008000, 3, 0);
    assert_eq!(b.presented_frame[0], 0xc0);
}
#[test]
fn color_presentation_preserves_full_gabbro_image_without_masking_guest_bytes() {
    let (_, mut b) = boot_profile(code(0x20080000), BoardProfile::GABBRO);
    for (i, v) in b.frame[..67600].iter_mut().enumerate() {
        *v = (i % 256) as u8;
    }
    b.write32(0x40008000, 3, 0);
    assert_eq!(&b.presented_frame, &b.frame[..67600]);
}
fn upload(msp: u32) -> u32 {
    let c = code(msp);
    let ptr = spike_upload((c.len() + 32 * 1024 * 1024) as u32);
    assert!(!ptr.is_null());
    unsafe { std::slice::from_raw_parts_mut(ptr, c.len()).copy_from_slice(&c) };
    c.len() as u32
}
#[test]
fn abi_reports_profiles_and_restart_preserves_profile() {
    for p in [
        BoardProfile::FLINT,
        BoardProfile::EMERY,
        BoardProfile::GABBRO,
    ] {
        let n = upload(0x20000000 + p.ram_bytes as u32);
        assert_eq!(spike_boot_profile(p.id, n, 32 * 1024 * 1024), 1);
        for restart in [false, true] {
            if restart {
                assert_eq!(spike_restart(), 1);
            }
            assert_eq!(spike_profile(), p.id);
            assert_eq!(spike_frame_width(), p.width as u32);
            assert_eq!(spike_frame_height(), p.height as u32);
            assert_eq!(spike_frame_len(), p.frame_len() as u32);
            assert_eq!(spike_frame_format(), 8);
            assert_eq!(spike_frame_stride(), p.width as u32);
            assert_eq!(spike_frame_round(), p.round as u32);
            assert_eq!(spike_guest_frame_len(), p.guest_frame_len() as u32);
            assert_eq!(spike_guest_frame_stride(), p.guest_stride() as u32);
            assert_eq!(spike_guest_frame_format(), p.guest_bpp);
        }
    }
}
#[test]
fn abi_rejects_unknown_profile_and_out_of_profile_stack() {
    let n = upload(0x20080000);
    assert_eq!(spike_boot_profile(0, n, 32 * 1024 * 1024), 0);
    assert_eq!(spike_boot_profile(1, n, 32 * 1024 * 1024), 0);
    let n = upload(0x20040000);
    assert_eq!(spike_boot_profile(1, n, 32 * 1024 * 1024), 1);
}
