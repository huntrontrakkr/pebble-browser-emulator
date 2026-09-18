use pebble_sifli_board::{FaultKind, mpi::Mpi, startup_io::StartupIo};
const B: u32 = 0x50042000;
fn setup() -> Mpi {
    let mut m = Mpi::default();
    assert!(m.configure(0xef4018, 0x1c, 0));
    m.write(B, 4, 1).unwrap();
    m.write(B + 12, 4, 1).unwrap();
    m
}
fn command(m: &mut Mpi, cmd: u32, address: u32, len: u32, ccr: u32) -> Result<(), FaultKind> {
    m.write(B + 0x14, 4, 1)?;
    m.write(B + 0x1c, 4, address)?;
    m.write(B + 0x24, 4, len.saturating_sub(1))?;
    m.write(B + 0x28, 4, ccr)?;
    m.write(B + 0x18, 4, cmd)
}
fn finish(m: &mut Mpi) {
    m.advance(10000);
    assert_eq!(m.read(B + 0x10, 4), Ok(1));
}
#[test]
fn identity_is_explicit_and_transfer_does_not_complete_by_polling() {
    let mut m = Mpi::default();
    m.write(B, 4, 1).unwrap();
    assert_eq!(
        command(&mut m, 0x9f, 0, 3, 0x40001),
        Err(FaultKind::MissingNorState)
    );
    assert!(!m.configure(0xabcdef, 0, 0));
    assert!(m.configure(0xef4018, 0, 0));
    command(&mut m, 0x9f, 0, 3, 0x40001).unwrap();
    for _ in 0..100 {
        assert_eq!(m.read(B + 0x10, 4), Ok(0x80000000));
    }
    assert_eq!(m.read(B + 4, 4), Err(FaultKind::PeripheralNotReady));
    m.advance(127);
    assert_eq!(m.read(B + 0x10, 4), Ok(0x80000000));
    m.advance(1);
    assert_eq!(m.read(B + 4, 4), Ok(0x1840ef));
    assert_eq!(m.read(B + 4, 4), Err(FaultKind::PeripheralNotReady));
    m.write(B + 0x14, 4, 0).unwrap();
    assert_eq!(m.read(B + 0x10, 4), Ok(1));
    m.write(B + 0x14, 4, 1).unwrap();
    assert_eq!(m.read(B + 0x10, 4), Ok(0));
}
#[test]
fn security_pages_are_required_independent_and_wrap_within_each_page() {
    let mut m = setup();
    assert_eq!(
        command(&mut m, 0x48, 0x1000, 8, 0x50089),
        Err(FaultKind::MissingFlashOtp)
    );
    let bytes = std::array::from_fn(|i| i as u8);
    assert!(m.nor.as_mut().unwrap().supply(1, bytes));
    command(&mut m, 0x48, 0x1000fc, 8, 0x50089).unwrap_err(); // nonexistent security page
    command(&mut m, 0x48, 0x100010fc, 8, 0x50089).unwrap(); // address serialized as 24 bits
    finish(&mut m);
    assert_eq!(m.read(B + 4, 4), Ok(0xfffefdfc));
    assert_eq!(m.read(B + 4, 4), Ok(0x03020100));
    assert_eq!(m.otp_bytes_read, 8);
    assert_eq!(
        command(&mut m, 0x48, 0x2000, 4, 0x50089),
        Err(FaultKind::MissingFlashOtp)
    );
    assert_eq!(
        command(&mut m, 0x48, 0x1000, 4, 0x40089),
        Err(FaultKind::UnsupportedFlashCommand)
    ); // dummy cycles
}
#[test]
fn volatile_status_requires_enable_preserves_otp_locks_and_reset_restores_supplied_status() {
    let mut m = setup();
    m.write(B + 4, 4, 0).unwrap();
    assert_eq!(
        command(&mut m, 0x01, 0, 2, 0x240001),
        Err(FaultKind::UnsupportedFlashCommand)
    );
    command(&mut m, 0x50, 0, 0, 1).unwrap();
    finish(&mut m);
    command(&mut m, 0x01, 0, 2, 0x240001).unwrap();
    finish(&mut m);
    command(&mut m, 0x05, 0, 1, 0x40001).unwrap();
    finish(&mut m);
    assert_eq!(m.read(B + 4, 4), Ok(0));
    command(&mut m, 0x66, 0, 0, 1).unwrap();
    finish(&mut m);
    command(&mut m, 0x99, 0, 0, 1).unwrap();
    finish(&mut m);
    assert_eq!(
        command(&mut m, 0x05, 0, 1, 0x40001),
        Err(FaultKind::PeripheralNotReady)
    );
    m.nor.as_mut().unwrap().advance(1440);
    command(&mut m, 0x05, 0, 1, 0x40001).unwrap();
    finish(&mut m);
    assert_eq!(m.read(B + 4, 4), Ok(0x1c));
    assert_eq!(
        command(&mut m, 0x99, 0, 0, 1),
        Err(FaultKind::UnsupportedFlashCommand)
    );
}
#[test]
fn abort_reset_gating_and_invalid_modes_do_not_manufacture_data() {
    let mut io = StartupIo::default();
    assert!(io.mpi.configure(0xef4018, 0, 0));
    io.write(B, 4, 1).unwrap();
    command(&mut io.mpi, 0x9f, 0, 3, 0x40001).unwrap();
    io.write(0x5000001c, 4, 4).unwrap();
    io.advance(10000);
    assert_eq!(io.read(B + 4, 4), Err(FaultKind::PeripheralNotReady));
    io.write(0x50000014, 4, 4).unwrap();
    assert_eq!(io.read(B + 0x10, 4), Ok(0x80000000));
    io.write(B, 4, 0x80000001).unwrap();
    assert_eq!(io.read(B + 0x10, 4), Ok(0));
    assert_eq!(io.read(B + 4, 4), Err(FaultKind::PeripheralNotReady));
    command(&mut io.mpi, 0x9f, 0, 3, 0x40001).unwrap();
    io.write(0x50000004, 4, 4).unwrap();
    io.advance(10000);
    io.write(0x50000004, 4, 0).unwrap();
    assert_eq!(io.read(B + 0x10, 4), Ok(0));
    assert!(io.mpi.nor.is_some());
    assert_eq!(io.mpi.commands_completed, 0);
    assert!(io.write(B, 4, 0x21).is_err()); // DMA
    assert!(io.write(B + 0x2c, 4, 0x05).is_err()); // command chaining
    assert_eq!(io.read(B + 0x28, 1), Err(FaultKind::InvalidWidth));
}
#[test]
fn main_array_reads_only_supplied_bytes_and_program_erase_remain_explicit() {
    let mut m = setup();
    m.set_slot(vec![0x69, 0x42, 0x12, 0x34]);
    command(&mut m, 0x03, 0x20000, 4, 0x40089).unwrap();
    finish(&mut m);
    assert_eq!(m.read(B + 4, 4), Ok(0x34124269));
    assert_eq!(
        command(&mut m, 0x03, 0x20004, 4, 0x40089),
        Err(FaultKind::MissingQspi2)
    );
    assert_eq!(
        command(&mut m, 0x20, 0x20000, 0, 0x89),
        Err(FaultKind::UnsupportedFlashCommand)
    );
    assert_eq!(
        command(&mut m, 0x02, 0x20000, 1, 0x240089),
        Err(FaultKind::UnsupportedFlashCommand)
    );
    assert_eq!(
        command(&mut m, 0x48, 0x1000, 65, 0x50089),
        Err(FaultKind::PeripheralNotReady)
    );
}
