//! SF32LB52x USART1 register subset reached by HCPU application startup.
//! Layout follows `USART_TypeDef` in the pinned SiFli SDK
//! (`drivers/cmsis/Include/usart.h`, commit bfee83c7) and the base address in
//! `drivers/cmsis/sf32lb52x/register.h`. Transmission is modeled as
//! instantaneous: a byte written to TDR is captured immediately and the
//! transmitter always reports ready. Baud rate, bit timing, the receiver and
//! interrupt delivery are not modeled, so this carries no timing fidelity.
use crate::FaultKind;

const BASE: u32 = 0x5008_4000;

// Register offsets from `USART_TypeDef`.
const CR1: u32 = 0x00;
const CR2: u32 = 0x04;
const CR3: u32 = 0x08;
const BRR: u32 = 0x0c;
const GTPR: u32 = 0x10;
const RTOR: u32 = 0x14;
const RQR: u32 = 0x18;
const ISR: u32 = 0x1c;
const ICR: u32 = 0x20;
const RDR: u32 = 0x24;
const TDR: u32 = 0x28;
const MISCR: u32 = 0x2c;
const DRDR: u32 = 0x30;
const DTDR: u32 = 0x34;
const EXR: u32 = 0x38;

/// CR1.UE — USART enable.
const CR1_UE: u32 = 1 << 0;
/// CR1.TE — transmitter enable.
const CR1_TE: u32 = 1 << 3;

/// ISR.TC — transmission complete, and ISR.TXE — transmit register empty.
const ISR_TC: u32 = 1 << 6;
const ISR_TXE: u32 = 1 << 7;
/// ICR bits the HAL writes to acknowledge flags this model reports.
const ICR_ACCEPTED: u32 = ISR_TC | (1 << 4); // TCCF and IDLECF

/// Bytes kept from TDR. Startup banners are short; a bound keeps a runaway
/// transmitter from growing the probe without limit.
const TX_CAPACITY: usize = 4096;

#[derive(Default)]
pub struct Usart1 {
    cr1: u32,
    cr2: u32,
    cr3: u32,
    brr: u32,
    gtpr: u32,
    rtor: u32,
    miscr: u32,
    exr: u32,
    /// Bytes the guest wrote to TDR, oldest first, bounded by `TX_CAPACITY`.
    tx: Vec<u8>,
    pub bytes_transmitted: u64,
    pub configurations: u64,
}

impl Usart1 {
    pub fn owns(address: u32) -> bool {
        (BASE..=BASE + EXR).contains(&address)
    }

    /// True once the guest has enabled the USART and its transmitter.
    pub fn transmitter_enabled(&self) -> bool {
        self.cr1 & (CR1_UE | CR1_TE) == CR1_UE | CR1_TE
    }

    pub fn baud_divisor(&self) -> u32 {
        self.brr
    }

    /// Bytes written to TDR, oldest first. Truncated at `TX_CAPACITY`; use
    /// `bytes_transmitted` for the count actually written.
    pub fn transmitted(&self) -> &[u8] {
        &self.tx
    }

    pub fn read(&self, address: u32) -> Result<u32, FaultKind> {
        match address - BASE {
            CR1 => Ok(self.cr1),
            CR2 => Ok(self.cr2),
            CR3 => Ok(self.cr3),
            BRR => Ok(self.brr),
            GTPR => Ok(self.gtpr),
            RTOR => Ok(self.rtor),
            MISCR => Ok(self.miscr),
            EXR => Ok(self.exr),
            // The transmitter is always ready because transmission is
            // instantaneous. No receive path is modeled, so RXNE stays clear
            // rather than reporting data this model cannot supply.
            ISR => Ok(ISR_TXE | ISR_TC),
            // RQR and ICR are write-only; RDR, DRDR and DTDR would have to
            // invent received data. Report them instead of answering.
            RQR | ICR | RDR | DRDR | DTDR => Err(FaultKind::UnmodeledMmio),
            _ => Err(FaultKind::UnmodeledMmio),
        }
    }

    pub fn write(&mut self, address: u32, value: u32) -> Result<(), FaultKind> {
        match address - BASE {
            CR1 => {
                let enabling = value & (CR1_UE | CR1_TE) == CR1_UE | CR1_TE;
                if enabling && !self.transmitter_enabled() {
                    self.configurations += 1;
                }
                self.cr1 = value;
            }
            CR2 => self.cr2 = value,
            CR3 => self.cr3 = value,
            BRR => self.brr = value,
            GTPR => self.gtpr = value,
            RTOR => self.rtor = value,
            MISCR => self.miscr = value,
            EXR => self.exr = value,
            TDR => {
                if !self.transmitter_enabled() {
                    // A byte written with the transmitter off would be
                    // discarded by hardware in a way this model has no
                    // reference for.
                    return Err(FaultKind::UnmodeledMmio);
                }
                if self.tx.len() < TX_CAPACITY {
                    self.tx.push(value as u8);
                }
                self.bytes_transmitted += 1;
            }
            // Flags this model reports are cleared by acknowledging them; the
            // rest describe conditions it never raises.
            ICR if value & !ICR_ACCEPTED == 0 => {}
            // ISR is read-only, and the request register's break, mute and
            // flush commands have no modeled effect.
            _ => return Err(FaultKind::UnmodeledMmio),
        }
        Ok(())
    }
}
