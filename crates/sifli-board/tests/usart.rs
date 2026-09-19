//! USART1 register subset. Layout and bit positions follow `USART_TypeDef` and
//! the `USART_ISR_*` definitions in the pinned SiFli SDK
//! (`drivers/cmsis/Include/usart.h`, commit bfee83c7); the base address comes
//! from `drivers/cmsis/sf32lb52x/register.h`. Transmission is modeled as
//! instantaneous, so these check register behavior and byte capture, not
//! timing.
use pebble_sifli_board::{
    FaultKind, Revision,
    execution::{ResetProbe, Stop},
    startup_io::StartupIo,
    usart::Usart1,
};

const BASE: u32 = 0x5008_4000;
const CR1: u32 = BASE;
const BRR: u32 = BASE + 0x0c;
const ISR: u32 = BASE + 0x1c;
const ICR: u32 = BASE + 0x20;
const RDR: u32 = BASE + 0x24;
const TDR: u32 = BASE + 0x28;
const RQR: u32 = BASE + 0x18;

const UE_TE: u32 = (1 << 0) | (1 << 3);
const ISR_TC: u32 = 1 << 6;
const ISR_TXE: u32 = 1 << 7;

#[test]
fn control_and_baud_registers_round_trip_and_report_the_transmitter() {
    let mut u = Usart1::default();
    assert!(!u.transmitter_enabled());
    assert!(Usart1::owns(BASE) && Usart1::owns(BASE + 0x38));
    assert!(!Usart1::owns(BASE - 4) && !Usart1::owns(BASE + 0x3c));

    u.write(CR1, UE_TE).unwrap();
    u.write(BRR, 48).unwrap();
    assert!(u.transmitter_enabled());
    assert_eq!(u.read(CR1), Ok(UE_TE));
    assert_eq!(u.baud_divisor(), 48);
    assert_eq!(u.configurations, 1);
    // Re-enabling an already enabled transmitter is not a new configuration.
    u.write(CR1, UE_TE).unwrap();
    assert_eq!(u.configurations, 1);
}

#[test]
fn the_transmitter_always_reports_ready_and_never_reports_received_data() {
    let u = Usart1::default();
    assert_eq!(u.read(ISR), Ok(ISR_TXE | ISR_TC));
    // No receive path is modeled, so these report rather than inventing a byte.
    for address in [RDR, BASE + 0x30, BASE + 0x34] {
        assert_eq!(u.read(address), Err(FaultKind::UnmodeledMmio));
    }
    // Write-only registers do not answer reads either.
    assert_eq!(u.read(RQR), Err(FaultKind::UnmodeledMmio));
    assert_eq!(u.read(ICR), Err(FaultKind::UnmodeledMmio));
}

#[test]
fn transmitted_bytes_are_captured_only_while_the_transmitter_is_enabled() {
    let mut u = Usart1::default();
    // A byte written with the transmitter off has no modeled behavior.
    assert_eq!(u.write(TDR, b'x' as u32), Err(FaultKind::UnmodeledMmio));
    assert_eq!(u.bytes_transmitted, 0);

    u.write(CR1, UE_TE).unwrap();
    for byte in b"hi" {
        u.write(TDR, u32::from(*byte)).unwrap();
    }
    assert_eq!(u.transmitted(), b"hi");
    assert_eq!(u.bytes_transmitted, 2);
    // Acknowledging a flag this model reports is accepted; other bits are not.
    assert_eq!(u.write(ICR, ISR_TC), Ok(()));
    assert_eq!(u.write(ICR, 1 << 3), Err(FaultKind::UnmodeledMmio));
    // ISR is read-only.
    assert_eq!(u.write(ISR, 0), Err(FaultKind::UnmodeledMmio));
}

#[test]
fn startup_io_routes_usart_accesses_and_rejects_partial_widths() {
    let mut io = StartupIo::default();
    io.write(CR1, 4, UE_TE).unwrap();
    assert_eq!(io.read(ISR, 4), Ok(ISR_TXE | ISR_TC));
    io.write(TDR, 4, b'A' as u32).unwrap();
    assert_eq!(io.usart1.transmitted(), b"A");
    assert_eq!(io.read(CR1, 2), Err(FaultKind::InvalidWidth));
}

// --- Guest execution -------------------------------------------------------

const CODE_ADDRESS: u32 = 0x1202_1100;
const POOL_OFFSET: u32 = 0x1180;
const POOL_ADDRESS: u32 = 0x1202_1180;

#[derive(Default)]
struct Program {
    words: Vec<u16>,
    pool: Vec<u32>,
}

impl Program {
    fn ldr_literal(&mut self, rt: u16, value: u32) {
        let index = match self.pool.iter().position(|v| *v == value) {
            Some(i) => i as u32,
            None => {
                self.pool.push(value);
                self.pool.len() as u32 - 1
            }
        };
        let pc = CODE_ADDRESS + 2 * self.words.len() as u32 + 4;
        let delta = (POOL_ADDRESS + 4 * index) - (pc & !3);
        assert!(delta.is_multiple_of(4) && delta / 4 < 256);
        self.words.push(0x4800 | (rt << 8) | (delta / 4) as u16);
    }

    fn push(&mut self, word: u16) {
        self.words.push(word);
    }

    fn halt(&self) -> u32 {
        CODE_ADDRESS + 2 * self.words.len() as u32 - 2
    }

    fn image(&self) -> Vec<u8> {
        let mut image = vec![0xff; 0x1200];
        image[0x1000..0x1004].copy_from_slice(&0x2008_0000u32.to_le_bytes());
        image[0x1004..0x1008].copy_from_slice(&(CODE_ADDRESS | 1).to_le_bytes());
        for (i, word) in self.words.iter().enumerate() {
            let at = 0x1100 + i * 2;
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

#[test]
fn guest_code_enables_the_transmitter_and_its_bytes_are_captured() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        let mut p = Program::default();
        p.ldr_literal(0, CR1);
        p.ldr_literal(1, UE_TE);
        p.push(0x6001); // str r1, [r0]
        p.ldr_literal(2, TDR);
        p.ldr_literal(3, u32::from(b'P'));
        p.push(0x6013); // str r3, [r2]
        p.ldr_literal(4, ISR);
        p.push(0x6825); // ldr r5, [r4]
        p.push(0xe7fe); // b .
        let mut probe = ResetProbe::new(revision, p.image()).unwrap();

        probe.run(100, Some(p.halt()));

        assert_eq!(probe.stop(), None, "{revision:?}: sequence completed");
        let io = probe.startup_io();
        assert!(io.usart1.transmitter_enabled(), "{revision:?}");
        assert_eq!(io.usart1.transmitted(), b"P", "{revision:?}");
        assert_eq!(
            probe.registers()[5],
            ISR_TXE | ISR_TC,
            "{revision:?}: guest reads the transmitter ready"
        );
    }
}

#[test]
fn a_guest_read_of_the_receive_register_faults_instead_of_inventing_data() {
    for revision in [Revision::ObelixPvt, Revision::GetafixDvt2] {
        let mut p = Program::default();
        p.ldr_literal(0, CR1);
        p.ldr_literal(1, UE_TE);
        p.push(0x6001); // str r1, [r0]
        p.ldr_literal(2, RDR);
        p.push(0x6813); // ldr r3, [r2]
        p.push(0xe7fe); // b .
        let mut probe = ResetProbe::new(revision, p.image()).unwrap();

        probe.run(100, Some(p.halt()));

        match probe.stop() {
            Some(Stop::Access(fault)) => {
                assert_eq!(fault.kind, FaultKind::UnmodeledMmio, "{revision:?}");
                assert_eq!(fault.address, RDR, "{revision:?}");
            }
            other => panic!("{revision:?}: expected a structured fault, got {other:?}"),
        }
    }
}
