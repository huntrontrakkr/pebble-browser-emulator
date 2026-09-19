# Local changes from crates.io rp2350-emu 0.2.6

The upstream source is retained under MIT OR Apache-2.0. Both license texts are included.
This package is used through its CortexM33/CoreBus interface, not its RP2350 board model.

`src/core/execute_thumb32.rs`: add Armv8-M LDA/STL and LDAEX/STLEX byte/halfword/word decoding
before the doubleword-memory fallback. Without it, PebbleOS's LDREXH/STLEXH atomic loop never
completed because the status register remained unchanged. Single-core bus operations are
synchronous; existing exclusive monitor rules are preserved. This is a correctness patch,
not evidence of complete memory/security/timing fidelity.

See `../../docs/evidence/armv8-acquire-release.patch` and
`../../crates/qemu-emery/tests/armv8_acquire_release.rs`. LLVM-generated encoding vectors are
included under `docs/evidence`. The generic board supplies its own SysTick scheduler because
upstream's exact-zero one-cycle decrement failed to pend the interrupt; that change is in
the adapter, not this vendored dependency.

Optional upstream integration-test declarations were removed from Cargo.toml because their
RP2350 firmware fixtures are not distributed here. Source fixture-independent unit tests
remain upstream code but are not part of the parent workspace's test selection.

Additional CPU corrections, each covered by independent synthetic instruction fixtures:

- `core/execute.rs`: correct CPSIE/CPSID I/F bit selection. Reversed selectors set
  FAULTMASK when firmware requested PRIMASK and prevented correct WFI wakeups.
- `core/mod.rs`: honor byte reads/writes to NVIC and SCB priority registers. CMSIS writes
  PendSV/SysTick priorities with STRB; dropping them allowed scheduling inside BASEPRI
  critical sections, causing observed timer and app-transfer lost wakes.
- `core/execute_thumb32.rs`: commit POP.W/LDR-PC base writeback before EXC_RETURN unstacking,
  including MSP-to-PSP returns. The previous order read or overwrote the wrong stack.
- `core/execute_thumb32.rs`: synchronize live r13 before MRS MSP/PSP reads so ordinary
  stack instructions do not leave the active bank stale.
- `core/exceptions.rs`: pack ITSTATE into the architectural split xPSR bit fields. Tests
  compare the saved frame with an independent bit vector and restore an independently
  authored frame, rather than relying on a self-consistent round trip.

The board adapter additionally wakes WFE for consumed events and preempting exceptions,
advances virtual timers while asleep, and models SEVONPEND transitions. Its tests cover
masked and disabled interrupts, event consumption, NMI, MSP/PSP exception returns, and
priority-register byte lanes. These corrections do not establish full Cortex-M fidelity;
see `docs/STATUS.md` for the remaining compatibility limits.

`bus/ppb.rs`: make the CPUID identification value configurable by the embedding board while
retaining the upstream default. Generic Pebble profiles supply the official QEMU Cortex-M4
or Cortex-M33 identity. This does not enforce the complete architecture-specific instruction
availability or implement physical-watch CPU timing. Profile ABI tests cover the values.

`core/checkpoint.rs` and its `core/mod.rs` declaration add an original explicit portable
state codec for prepared firmware startup. It enumerates CPU registers, PPB/FPU/interrupt,
exclusive/event/security state and shared atomics, preserving float bit patterns. Exhaustive
field destructuring forces added fields to be reviewed. The decoded-op cache is regenerated;
no raw Rust memory layout or pointers are persisted. Decoding has an allocation budget and
rejects invalid scalar values. No instruction execution code is changed by this addition.
See `docs/evidence/startup-checkpoint-cpu.patch`, the adapter's checkpoint tests, and
`docs/STARTUP_CHECKPOINTS.md` for complete-state/continuation comparisons and their limits.

`core/bus_trait.rs` and `core/mod.rs`: add an opt-out for internal PPB/SIO
data-access interception. The physical SiFli reset probe disables it so unknown
architectural and RP2350-specific registers reach the strict board bus and stop
execution. The default is enabled, preserving existing generic profiles. All
three access widths and both read/write directions are covered in
`crates/sifli-board/tests/execution.rs`; the separate probe rejects coprocessor
instructions before execution. See `docs/evidence/sifli-strict-bus.patch`.

`core/bus_trait.rs` and `core/decode.rs`: add separate `fetch16` and an opt-out
for decoded-instruction caching. Defaults preserve the existing generic runtime.
The SiFli adapter supplies its own instruction-cache view and disables the engine
cache so CPU instruction fetch observes firmware cache-maintenance operations.
An integrated CPU regression modifies executable SRAM, observes stale instructions,
invalidates I-cache through guest MMIO, and observes the new instruction. See
`docs/evidence/sifli-fetch-cache.patch`. No guest firmware is patched.

`core/mod.rs`, `core/decode.rs`, `core/exceptions.rs`, `core/execute_fpu.rs`,
`core/checkpoint.rs` and `bus/ppb.rs`: enforce the MPU for the generic Pebble profiles,
with precise faults. PMSAv7 (Cortex-M4 CPUID) and PMSAv8 region permissions apply to
instruction fetches, data accesses, exception stacking and unstacking, and lazy FP
preservation; MPU_TYPE and MPU_RNR follow the profile. A denied data access abandons
the executing instruction: registers, SP and writeback bases, IT state, the exclusive
monitor and loaded S registers are restored, later accesses of that instruction are
suppressed, and MMFAR holds the first denied address. Stacking stops at the first denied
store and reports MSTKERR as a derived exception, taken first only when it outranks the
original exception and otherwise pended through SHCSR. Unstacking reads the whole frame
with the returning mode's privilege before changing state; a denied read reports
MUNSTKERR and tail-chains to the derived fault. Lazy FP preservation reports MLSPERR.
Vector reads and privileged PPB data accesses use the default memory map, FAULTMASK
bypasses regions like NMI/HardFault when HFNMIENA is clear, and a synchronous MemManage
that cannot preempt escalates to HardFault. SHCSR pending bits for MemManage, BusFault,
UsageFault and SVCall take part in exception arbitration and tail-chaining. See
`docs/evidence/mpu-enforcement.patch` and `crates/qemu-emery/tests/mpu_precise_faults.rs`.
Unchanged 4.37.0 firmware boots byte-identically on all three profiles. Not modelled:
unprivileged SCS accesses as BusFault, PMSAv8 overlapping-region faults, default-map
execute-never regions, FPCCR.USER/MMRDY for lazy preservation, a derived HardFault
pending behind NMI, and precise abandonment for BusFault and UsageFault.

`bus/ppb.rs`, `core/mod.rs`, `core/checkpoint.rs`: memoize MPU permission lookups. `Ppb`
owns six front lanes, one per (access kind, privileged) pair, ahead of a 128-entry
direct-mapped table of 32-byte blocks. Region permissions are constant across a 32-byte
block — PMSAv8 regions are 32-byte granular, and a PMSAv7 region is at least 32 bytes with
subregions no smaller than that — so a block never spans a permission boundary. Every MPU
register write calls `Ppb::mpu_changed()`, which discards the cache, so a lookup carries no
validity check; a writer that sets a region directly must call it. The cache is derived
state and is not checkpointed. Debug builds re-scan the regions behind every hit and assert
the answers match. Firmware boots stay byte-identical; see
`docs/evidence/mpu-cache-throughput.json`.
