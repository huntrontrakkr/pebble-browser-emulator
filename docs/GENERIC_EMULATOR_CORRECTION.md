# Generic emulator fault correction

The browser boundary previously compared the return from `spike_run_until` with the
positive JavaScript number `4294967295`. A WebAssembly `i32` result with those bits is
reported to JavaScript as `-1`, so the comparison never detected Rust's `u32::MAX`
failure sentinel. A terminal access could therefore keep receiving CPU calls, decrement
the JavaScript step total, and consume the host indefinitely.

All JavaScript run callers now normalize that ABI value before testing it. Fault
addresses, registers and status words shown by the Worker are normalized to unsigned
32-bit values as well. The same conversion is used by startup, fidelity, audio and batch
tools so a passing tool cannot rely on the old comparison.

The CPU already turns a synchronous invalid memory access into a precise guest
BusFault or escalated HardFault. The generic board retained its diagnostic latch after
the CPU accepted that exception, causing the Worker to stop the whole emulator before
PebbleOS could run its fault handler. The latch now clears only through the CPU's
`clear_bus_fault` acknowledgement. Direct adapter faults remain observable, and unknown
accesses are not converted into successful reads.

## Measured result

The same sealed 11-title, 33-profile targeted batch was run before and after the fixes
with 11 workers and a 20-second virtual scenario. Wall time fell from 413,342 ms to
74,715 ms, a 5.53× throughput improvement. The final run had no host timeout:

- 11 scenarios completed.
- 12 cases completed the scenario while PebbleOS recorded an app/firmware error.
- 5 cases completed with a companion error.
- 4 installs stopped at the endpoint `0x34` timeout.
- 1 package had no compatible binary.

The completion totals are unchanged. The speedup comes from eliminating repeated work
after a fault rather than skipping guest time or changing firmware.

The fixed scenario was also applied to the unchanged packages and 4.37.0 images under
native Pebble QEMU 10.1.5-pebble17. Eleven of the twelve Rust-core app faults matched the
native app UUID and program counter. Sports on Gabbro faulted only in the Rust run; the
native runner uses host-timed inputs and does not provide deterministic instruction-time
replay, so that case remains an open scheduling/fidelity difference. Ventoo on all three
profiles and Arena3D on Flint reached the same endpoint `0x34` install timeout natively.

These comparisons establish correct guest fault delivery and remove a browser stall.
They do not establish cycle accuracy, physical hardware timing, or universal app
compatibility. The compact identities and measurements are recorded in
[`evidence/generic-emulator-correction.json`](evidence/generic-emulator-correction.json).
