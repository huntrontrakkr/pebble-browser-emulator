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
native Pebble QEMU 10.1.5-pebble17. Eleven of the twelve initial Rust-core app faults
matched the native app UUID and program counter. The initial native Sports/Gabbro capture
missed its fault, but three immediate native repeats all produced the same MPU stack-guard
failure: `CFSR=0x82`, `MMFAR=0x10`, and app PC/LR zero. It was therefore not evidence of a
scheduling difference.

The Rust CPU stored MPU registers but did not enforce their permissions on normal data or
instruction accesses. It consequently passed Sports' guard page and reported a later
backing-bus fault. The CPU now applies the profile's PMSAv7 rules on Flint and PMSAv8 rules
on Emery/Gabbro, including privilege, read-only, execute-never, region/subregion bounds,
and the privileged default map. A 20-second follow-up with the unchanged Sports package
now records the native Gabbro result exactly (`CFSR=0x82`, `MMFAR=0x10`, stack overflow,
PC/LR zero); Flint now also takes MemManage at its configured guard instead of BusFault.

The endpoint `0x34` results were also symptoms rather than transfer failures. Ventoo's
current store PBW declares a load size larger than virtual size in every selected binary;
unchanged 4.37.0 firmware rejects it on both engines. PBW inspection now reports the invalid
sizes before transfer. Arena3D does transfer on Flint, then fails an accelerometer memory
allocation and faults at PC `0x7b994`; it completes on Emery and Gabbro. Install waits now
surface firmware launch diagnostics such as the app fault PC or reboot instead of reporting
only the missing running-app event.

These comparisons establish correct guest fault delivery and remove a browser stall.
They do not establish cycle accuracy, physical hardware timing, or universal app
compatibility. The compact identities and measurements are recorded in
[`evidence/generic-emulator-correction.json`](evidence/generic-emulator-correction.json).
