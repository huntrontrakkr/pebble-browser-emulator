//! Original portable checkpoint codec for the Pebble browser adapter.
//! No raw struct memory, pointers, padding, host clocks or decoded-op cache are persisted.
//! Field destructuring is exhaustive so added CPU/PPB fields require an explicit decision.
use super::{CoreCounters, CortexM33, Fault, PerCoreSio, Registers};
use crate::{bus::ppb::Ppb, sio::Interp, threaded::CoreAtomics};
use picoem_common::Divider;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};

pub type Result<T> = std::result::Result<T, &'static str>;
pub struct Reader<'a> {
    pub remaining: &'a [u8],
    budget: usize,
}
impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8], budget: usize) -> Self {
        Self {
            remaining: bytes,
            budget,
        }
    }
    pub fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        if length > self.remaining.len() {
            return Err("Truncated checkpoint");
        }
        let (value, rest) = self.remaining.split_at(length);
        self.remaining = rest;
        Ok(value)
    }
    fn allocate(&mut self, length: usize) -> Result<()> {
        self.budget = self
            .budget
            .checked_sub(length)
            .ok_or("Checkpoint allocation limit")?;
        Ok(())
    }
}
pub trait StateValue: Sized {
    fn encode(&self, out: &mut Vec<u8>);
    fn decode(input: &mut Reader<'_>) -> Result<Self>;
}
macro_rules! integer {
    ($($ty:ty),+) => {$(impl StateValue for $ty {
        fn encode(&self, out: &mut Vec<u8>) { out.extend_from_slice(&self.to_le_bytes()); }
        fn decode(input: &mut Reader<'_>) -> Result<Self> { Ok(Self::from_le_bytes(input.take(size_of::<Self>())?.try_into().unwrap())) }
    })+};
}
integer!(u8, u32, u64);
impl StateValue for bool {
    fn encode(&self, out: &mut Vec<u8>) {
        (*self as u8).encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        match u8::decode(input)? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("Invalid checkpoint boolean"),
        }
    }
}
impl StateValue for f32 {
    fn encode(&self, out: &mut Vec<u8>) {
        self.to_bits().encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Ok(Self::from_bits(u32::decode(input)?))
    }
}
impl<T: StateValue, const N: usize> StateValue for [T; N] {
    fn encode(&self, out: &mut Vec<u8>) {
        for value in self {
            value.encode(out);
        }
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        let mut values = Vec::with_capacity(N);
        for _ in 0..N {
            values.push(T::decode(input)?);
        }
        values.try_into().map_err(|_| "Invalid array")
    }
}
impl<T: StateValue> StateValue for Option<T> {
    fn encode(&self, out: &mut Vec<u8>) {
        self.is_some().encode(out);
        if let Some(value) = self {
            value.encode(out);
        }
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Ok(if bool::decode(input)? {
            Some(T::decode(input)?)
        } else {
            None
        })
    }
}
impl<A: StateValue, B: StateValue> StateValue for (A, B) {
    fn encode(&self, out: &mut Vec<u8>) {
        self.0.encode(out);
        self.1.encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Ok((A::decode(input)?, B::decode(input)?))
    }
}
impl<A: StateValue, B: StateValue, C: StateValue> StateValue for (A, B, C) {
    fn encode(&self, out: &mut Vec<u8>) {
        self.0.encode(out);
        self.1.encode(out);
        self.2.encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Ok((A::decode(input)?, B::decode(input)?, C::decode(input)?))
    }
}
// Uniform 256-byte blocks store a fill byte; all other blocks retain every original byte.
// This avoids temporary copies of the mostly erased 32 MiB SPI chip on mobile.
impl StateValue for Vec<u8> {
    fn encode(&self, out: &mut Vec<u8>) {
        (self.len() as u32).encode(out);
        for page in self.chunks(256) {
            let uniform = page.iter().all(|b| *b == page[0]);
            uniform.encode(out);
            if uniform {
                page[0].encode(out);
            } else {
                out.extend_from_slice(page);
            }
        }
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        let length = u32::decode(input)? as usize;
        input.allocate(length)?;
        let mut value = vec![0; length];
        for page in value.chunks_mut(256) {
            if bool::decode(input)? {
                page.fill(u8::decode(input)?);
            } else {
                page.copy_from_slice(input.take(page.len())?);
            }
        }
        Ok(value)
    }
}
impl StateValue for VecDeque<u8> {
    fn encode(&self, out: &mut Vec<u8>) {
        self.iter().copied().collect::<Vec<u8>>().encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Ok(Vec::<u8>::decode(input)?.into())
    }
}
macro_rules! atomic {
    ($ty:ty, $inner:ty) => {
        impl StateValue for $ty {
            fn encode(&self, out: &mut Vec<u8>) {
                self.load(Ordering::Acquire).encode(out);
            }
            fn decode(input: &mut Reader<'_>) -> Result<Self> {
                Ok(Self::new(<$inner>::decode(input)?))
            }
        }
    };
}
atomic!(AtomicBool, bool);
atomic!(AtomicU32, u32);
atomic!(AtomicU64, u64);
impl<T: StateValue> StateValue for Arc<T> {
    fn encode(&self, out: &mut Vec<u8>) {
        self.as_ref().encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        Ok(Arc::new(T::decode(input)?))
    }
}
macro_rules! fields {
    ($ty:ty { $($field:ident),+ $(,)? } $(, $skip:ident = $default:expr)?) => {
        impl StateValue for $ty {
            fn encode(&self, out: &mut Vec<u8>) {
                let Self { $($field,)+ $($skip: _,)? } = self;
                $($field.encode(out);)+
            }
            fn decode(input: &mut Reader<'_>) -> Result<Self> {
                Ok(Self { $($field: StateValue::decode(input)?,)+ $($skip: $default,)? })
            }
        }
    };
}
fields!(Registers {
    r,
    xpsr,
    primask,
    basepri,
    faultmask,
    control,
    msp,
    psp,
    msp_ns,
    psp_ns,
    msplim,
    psplim,
    msplim_ns,
    psplim_ns,
    primask_ns,
    basepri_ns,
    faultmask_ns,
    control_ns,
    s,
    fpscr
});
fields!(CoreCounters {
    decode_execute_cycles,
    wfi_cycles,
    wfe_cycles,
    sram_reads,
    sram_writes,
    sio_accesses,
    peripheral_accesses,
    ppb_accesses
});
fields!(Ppb {
    cpuid,
    vtor,
    aircr,
    scr,
    ccr,
    shpr,
    shcsr,
    cfsr,
    hfsr,
    mmfar,
    bfar,
    cpacr,
    icsr,
    fpccr,
    fpcar,
    fpdscr,
    mpu_ctrl,
    mpu_rnr,
    mpu_regions,
    sau_ctrl,
    sau_rnr,
    sau_regions,
    dwt_ctrl,
    dwt_cyccnt_base,
    demcr,
    latest_cycles,
    syst_csr,
    syst_rvr,
    syst_cvr,
    last_systick_cycles,
    nvic_iser,
    nvic_ispr,
    nvic_iabr,
    nvic_ipr
});
fields!(CoreAtomics {
    halted,
    wfe_waiting,
    event_flag,
    irq_pending,
    rcp_salt,
    rcp_salt_valid,
    rcp_count,
    bus_fault,
    bus_fault_addr
});
fields!(Divider {
    dividend,
    divisor,
    quotient,
    remainder,
    signed,
    dirty,
    reads_pending
});
fields!(Interp {
    accum,
    base,
    ctrl_lane
});
fields!(PerCoreSio { divider, interp });
impl StateValue for Fault {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Self::UsageFault => 0u8,
            Self::MemManage => 1,
            Self::Nmi => 2,
        }
        .encode(out);
    }
    fn decode(input: &mut Reader<'_>) -> Result<Self> {
        match u8::decode(input)? {
            0 => Ok(Self::UsageFault),
            1 => Ok(Self::MemManage),
            2 => Ok(Self::Nmi),
            _ => Err("Invalid fault"),
        }
    }
}
fields!(
    CortexM33 {
        regs,
        cycles,
        core_id,
        current_instr_addr,
        it_state,
        pending_fault,
        dcp_halves,
        dcp_status,
        secure,
        atomics,
        ppb,
        exclusive_address,
        did_write_this_quantum,
        sio_local,
        counters,
        bootrom_reboot_hook_pc_s,
        bootrom_reboot_hook_pc_ns,
        bootrom_hook_fired
    },
    decode_cache = CortexM33::new(0, Arc::new(CoreAtomics::default())).decode_cache
);
impl CortexM33 {
    pub fn checkpoint_atomics(&self) -> Arc<CoreAtomics> {
        Arc::clone(&self.atomics)
    }
    pub fn checkpoint_valid(&self) -> bool {
        // The embedding board may publish its own clock (including WFI time)
        // into PPB. That clock need not equal the instruction engine counter.
        self.core_id == 0 && self.sio_local.divider.reads_pending <= 3
    }
}
