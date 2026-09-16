//! CMSIS NVIC_SetPriority/GetPriority use byte lanes, including SHPR.
use emulator_qemu::{board_step, boot};
fn image() -> Vec<u8> {
    let mut code = vec![0; 512];
    code[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    code[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    for n in [14, 15] {
        code[n * 4..n * 4 + 4].copy_from_slice(&0x181u32.to_le_bytes());
    }
    // strb r0,[r1]; ldrb r2,[r1]; adds r4,#1; b .
    for (i, op) in [0x7008u16, 0x780a, 0x3401, 0xe7fe].iter().enumerate() {
        code[0x100 + i * 2..0x102 + i * 2].copy_from_slice(&op.to_le_bytes());
    }
    code[0x180..0x182].copy_from_slice(&0x4770u16.to_le_bytes());
    code
}
#[test]
fn every_nvic_priority_byte_is_writable_and_readable() {
    for lane in 0..52u32 {
        let (mut cpu, mut bus) = boot(image());
        let addr = 0xe000e400 + lane;
        cpu.ppb.write32(addr & !3, 0x60402000);
        let old = cpu.ppb.read32(addr & !3);
        cpu.regs.r[0] = 0xbf;
        cpu.regs.r[1] = addr;
        board_step(&mut cpu, &mut bus);
        board_step(&mut cpu, &mut bus);
        let shift = (addr & 3) * 8;
        assert_eq!(
            cpu.ppb.read32(addr & !3),
            (old & !(0xff << shift)) | (0xa0 << shift),
            "lane {lane}"
        );
        assert_eq!(cpu.regs.r[2], 0xa0, "lane {lane}");
    }
}
#[test]
fn every_system_priority_byte_is_writable_and_readable() {
    for lane in 0..12u32 {
        let (mut cpu, mut bus) = boot(image());
        let addr = 0xe000ed18 + lane;
        cpu.ppb.write32(addr & !3, 0x60402000);
        let old = cpu.ppb.read32(addr & !3);
        cpu.regs.r[0] = 0xff;
        cpu.regs.r[1] = addr;
        board_step(&mut cpu, &mut bus);
        board_step(&mut cpu, &mut bus);
        let shift = (addr & 3) * 8;
        assert_eq!(
            cpu.ppb.read32(addr & !3),
            (old & !(0xff << shift)) | (0xe0 << shift),
            "lane {lane}"
        );
        assert_eq!(cpu.regs.r[2], 0xe0, "lane {lane}");
    }
}
#[test]
fn byte_written_pendsv_priority_obeys_basepri_critical_section() {
    let (mut cpu, mut bus) = boot(image());
    cpu.regs.r[0] = 0xff;
    cpu.regs.r[1] = 0xe000ed22;
    cpu.regs.basepri = 0xbf;
    board_step(&mut cpu, &mut bus);
    cpu.ppb.icsr |= 1 << 28;
    board_step(&mut cpu, &mut bus);
    assert_eq!(
        cpu.regs.ipsr(),
        0,
        "PendSV must not preempt BASEPRI=0xbf when priority is 0xe0"
    );
    assert_eq!(cpu.regs.pc(), 0x104);
    cpu.regs.basepri = 0;
    board_step(&mut cpu, &mut bus);
    assert_eq!(
        cpu.regs.ipsr(),
        14,
        "PendSV must run after leaving critical section"
    );
    assert_eq!(cpu.regs.pc(), 0x180);
}
#[test]
fn byte_written_systick_priority_obeys_basepri_critical_section() {
    let (mut cpu, mut bus) = boot(image());
    cpu.regs.r[0] = 0xff;
    cpu.regs.r[1] = 0xe000ed23;
    cpu.regs.basepri = 0xbf;
    board_step(&mut cpu, &mut bus);
    cpu.ppb.pend_systick();
    board_step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.ipsr(), 0);
    assert_eq!(cpu.regs.pc(), 0x104);
    cpu.regs.basepri = 0;
    board_step(&mut cpu, &mut bus);
    assert_eq!(cpu.regs.ipsr(), 15);
}
