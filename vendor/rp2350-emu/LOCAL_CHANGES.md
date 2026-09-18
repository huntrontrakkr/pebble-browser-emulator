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
