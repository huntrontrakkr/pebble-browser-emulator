# Fidelity evidence and timing investigation

The implementation plan is [in the repository root](../HARDWARE_FIDELITY_PLAN.md).
This document describes the delivered foundation, not completion of physical emulation.
The [recorded run evidence](evidence/fidelity-foundation.json) includes the observer comparison
and the unresolved Kablooey failure alongside its native reference result.

## Evidence inventory

| Existing check                                             | Reference                                                    | What it establishes                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `verify-reference.py`                                      | Independent Unicorn ARM execution                            | Diagnostic registers, executed instruction count and framebuffer for one program                       |
| Focused Rust CPU tests                                     | Synthetic architectural vectors, some independently compared | The covered instruction/exception cases, not full CPU conformance                                      |
| `verify-sensor-reference.mjs` and sensor integration tests | Pinned native Pebble QEMU                                    | Selected application logs and exact final frames on three generic boards                               |
| `verify-app-reference.mjs`                                 | Native Pebble QEMU                                           | Launch, touch capture and subsequent Clock installation; host-clock pacing                             |
| Startup checkpoint builder                                 | Same core, independent instance                              | Complete state and continuation consistency, not independent hardware accuracy                         |
| `verify-fidelity-run.mjs`                                  | Same compiled Rust/Wasm core                                 | Repeatable cold-boot/app scenarios, complete state hashes, bounded trace and explicit first divergence |
| Optical numerical tests                                    | Independent formula for assumed materials                    | Numerical approximation error, not measured panel response                                             |
| Physical watches                                           | Not available                                                | Not run; no physical timing or power validation                                                        |

Do not flatten these into a single "verified hardware" flag. Status and reference target
are separate. A matching internal comparison is still internal consistency.

## Reproduction

Supply firmware locally; these commands neither download nor modify it:

```sh
npm run build:wasm
PEBBLE_FIRMWARE_DIR=/path/to/firmware npm run fidelity:capture

PEBBLE_FIRMWARE_DIR=/path/to/firmware \
PEBBLE_APP_PBW=/path/to/kablooey.pbw \
PEBBLE_TRACE_DIR=tmp/fidelity-kablooey npm run fidelity:capture

npm run fidelity:compare -- reference/run.json candidate/run.json 0
```

The default scenario cold-boots generic Emery 4.37.0, fixes the RTC, installs Clock,
waits one virtual second, presses/releases a supported touchscreen, runs to ten virtual
seconds after install, captures a 1,000-step diagnostic window, then installs Clock and
the selected app again. No QuickJS companion runs in this focused core test. Launch
and a changed frame alone do not establish gameplay correctness.

`PEBBLE_PROFILE` selects an implemented generic board. `PEBBLE_SCENARIO_MS` permits
1,000–600,000 ms; `PEBBLE_SWITCHES` permits 0–20 replacement pairs. A longer run still
needs scenario-specific behavioral assertions before satisfying the plan's gameplay gate.
`PEBBLE_HOST_TIMEOUT_MS` bounds execution (default 180 seconds, maximum one hour).
SIGINT/SIGTERM cancel at the next bounded execution quantum. `PEBBLE_TRACE=0` executes
the same diagnostic steps without observation, allowing an exact observer-effect comparison.
`PEBBLE_MMIO_PROBE_MS=100` additionally aggregates register accesses during the first
100 virtual milliseconds of each interaction phase and throughout the initial app
install. `PEBBLE_MMIO_PROBE_EACH_SAMPLE=1` repeats the bounded probe for every one-second
sample. The optional `mmio-probe.json` includes address, read/write direction, count,
first/last PC, value and time, and dropped-event count. It contains no raw firmware bytes.
A lost trace event fails the run rather than being treated as complete evidence.

Reports include exact input hashes, board/revision, firmware tag, core hash, scenario
hash, initial RTC and a seed (reserved for future generated inputs; this scenario has
none). Named observations contain full guest-state/frame hashes, PC and xPSR. Separate
metrics report scheduler steps, virtual microseconds, estimated CPU costs and host time.
Executed instructions and physical cycles are **null**, not inferred from step counts.
The runner also writes `workload.json`: bounded one-second virtual-time samples during
interaction, including the pre-touch and touch-held intervals. Samples distinguish
scheduler steps, interpreter cost estimate, virtual elapsed time, host elapsed time
and completed frames. They do not claim retired instruction counts or physical cycles.

Exit codes: 0 for a completed scenario/matching comparison, 1 for failure or mismatch,
2 for missing capture inputs. Missing prerequisites create a separate `not-run` report.
Failed runs retain their reason, completed observations and a final diagnostic window
where execution remains possible. These reports contain no firmware binaries.

Comparisons reject different board/revision, firmware, app, scenario, seed or initial
state. They compare exact digital checkpoint values and report the first difference.
Timing is compared only when an explicit tolerance is supplied and both captures have
virtual timestamps. Empty/partial captures, duplicate checkpoints, capture loss and
missing prerequisites cannot pass. Reference metadata is provenance supplied by the
capture author, not cryptographic certification of a physical watch.

Native QEMU's pinned generic RTC uses host wall time, while its monotonic tick register
uses virtual time. The Rust RTC is intentionally coupled to the session's virtual clock.
The existing native app runner also schedules interactions with host waits. Its reports
must not be passed off as an identical deterministic timing scenario. A controlled native
virtual-clock adapter and comparison of selected firmware observables remain pending.

The [Kablooey workload capture](evidence/kablooey-workload.json) shows that the game is
already using about 56.5 million estimated CPU cycles per virtual second before touch,
then consumes essentially the full modeled 64 million per second afterward while updating
at 11–12 frames per virtual second. Clock's median idle cost is about 0.45 million
estimated cycles per virtual second. Kablooey still times out on the next install.
Sampling leaves every earlier state/frame hash and virtual timestamp unchanged. This
narrows the timing investigation but does not justify changing the generic clock.
An [MMIO probe](evidence/kablooey-mmio.json) then observed seven audio-register writes
while Kablooey installed, where Clock made none. The old generic model omitted the
speaker's initial refill IRQ and FIFO behavior documented in pinned Pebble QEMU.
No audio DATA writes or reads appeared in the sampled ten-second interaction, but that
could result from the missing interrupt. The complete probed and unprobed checkpoints
matched. This identifies a model gap, not the cause of the later BlobDB timeout.
The generic speaker now models the pinned QEMU FIFO, initial/threshold refill IRQs,
10 ms virtual drain and null-sink rate budget. It uses IRQ 10 and stores the FIFO and
deadlines in checkpoint format v2; older generic checkpoints are rejected and prepared
states must be rebuilt against the new Wasm hash. A separate
[native-QEMU differential smoke](evidence/audio-initial-irq-reference.json) proves the
initial status byte and IRQ 10 delivery with identical synthetic Thumb programs in
native QEMU and Rust/Wasm. FIFO consumption and timer pacing remain source-backed
**modeled** behavior, not yet native-trace matched or browser sound output. Reproduce
the narrow reference gate with `PEBBLE_QEMU=/path/to/qemu-pebble npm run
fidelity:audio-reference`; no Pebble firmware is required.
In the [repeated Kablooey scenario](evidence/kablooey-audio-model.json), the unchanged
firmware now writes audio samples, but reports a full system task queue and resets at
7.102 virtual seconds. The prior full run then timed out on a subsequent install; the
current runner stops at the first fatal firmware log. The audio omission was real, but
its repair does not meet the Kablooey acceptance gate. The first native virtual-time divergence
and CPU/peripheral timing remain under investigation.

## Trace ABI v1

Tracing is disabled by default. `spike_trace_configure(flags, capacity)` enables MMIO
(bit 0), exception-number transitions (bit 1), and scheduler steps (bit 2). Capacity is
at most 32,768 records; zero flags/capacity disables and clears tracing. Invalid settings
leave the prior configuration intact. The ring retains the latest events and counts drops.

`spike_trace_export()` returns bytes and `spike_trace_ptr()` exposes an immutable copy
until the next export/configuration/boot/restore/reset. Copy it before another Wasm call
can grow memory. `spike_trace_dropped()` reports lost records. Records have ten u32 words:
kind, virtual ticks low/high, originating PC, address/next PC, value/xPSR, width,
IRQ level mask, estimated CPU cost low/high. MMIO records have no sampled CPU cost or IRQ
mask; the decoder returns null for those fields. Types 1/2 are reads/writes, 3 is an
exception-number change, 4 is a scheduler step. These are not retired-instruction records.

Generic peripheral word accesses and the instruction engine's existing PPB tracing hooks
are observed without rereading registers. Trace data is outside guest state/checkpoints
and is cleared on restore. The guest-state checkpoint format has not changed. Comparing
complete snapshots with tracing enabled/disabled tests that the observer has no guest effect.
This first trace format does not include every RAM access, IRQ edge, analog event or
undocumented physical-controller operation.

## Scheduler correction

The Worker previously applied demo signals before explicit scenario signals within a
CPU quantum, but reversed those sources at its end. Thus a simultaneous default could
overwrite a scenario depending on where a batch ended. Both boundaries now use the same
merge: chronological order, then demo, scenario, gesture for equal timestamps, retaining
order within each source. Wrist gestures suppress only demo acceleration while active,
including their final sample. Tests compare combined and split delivery.

This fixes host input ordering. It does not change CPU instruction costs or claim to fix
the Kablooey firmware stall.

## Physical board investigation

Pinned PebbleOS source: `9399f564fb5035057a9174025d2c6c625e942285` (v4.37.0).
Its SiFli SDK submodule is `bfee83c7adc0b19c2923f1788238def50f0a9dce`.
Candidate revisions are Obelix PVT and Getafix DVT2, for which slot-0 payloads are published.
They are candidates, not accepted boot configurations. Required ROM/controller state,
initial clock state, flash resources and component provenance still need completion.

A read-only [slot image audit](evidence/sifli-image-audit.json) now checks both official
4.37.0 ELF/raw pairs. All eleven load segments per board match the raw image at their
recorded physical flash addresses. The slot origin is `0x12020000`; the HCPU vector
is at `0x12021000`. Obelix PVT starts with SP `0x20034d40` and Thumb reset vector
`0x12046bb9`; Getafix DVT2 has SP `0x2002ec60` and reset vector `0x12040ec1`.
Both ELF headers advertise entry `0x120256f8`, which must not replace the vector.
The separate RAM initializer and zero-fill segments show why copying the raw image
straight into a generic QEMU board cannot boot it. This establishes layout consistency
only; it does not establish the post-bootloader machine state or execute firmware.

The read-only audit also recognizes the exact 4.37.0 reset prologue on each candidate
board. Both reset handlers set MSP/PSP limits, copy two ELF initializer ranges from
QSPI2 to SRAM, clear only the contiguous kernel BSS range, then call `SystemInit` and
`main` (symbol names from the published ELFs). Entry at the reset vector must let the
firmware perform those copies; a future post-initialization entry would need a different,
explicitly evidenced SRAM state. The uninitialized stack sections and the bootloader's
clock, cache, security and controller setup remain unknown. [Exact ranges and asset
identities](evidence/sifli-reset-startup.json) are recorded without adding either
firmware image to the repository.

Reproduce with locally supplied release assets (nothing is added to site resources):

```sh
npm run firmware:audit-physical -- obelix_pvt /path/to/firmware_obelix_pvt_v4.37.0_slot0.elf /path/to/firmware_obelix_pvt_v4.37.0_slot0.bin
npm run firmware:audit-physical -- getafix_dvt2 /path/to/firmware_getafix_dvt2_v4.37.0_slot0.elf /path/to/firmware_getafix_dvt2_v4.37.0_slot0.bin
```

The tool rejects segment, vector and raw-byte inconsistencies; its `loadable:false`
result is deliberate. Neither downloaded payload nor debug ELF is committed or copied
into the public build.

The separate `pebble-sifli-board` Rust crate now maps a caller-supplied slot-0 image
at its QSPI2 address and provides 512 KiB of HCPU SRAM for Obelix PVT and Getafix
DVT2. Its memory constructor does not create a CPU or boot state. ROM, other flash regions, LCPU state,
unknown MMIO and unmapped accesses return a structured fault containing revision,
PC, address, width and operation. Flash writes fault, and writes crossing a region
boundary do not partially commit. Fresh SRAM bytes also fault on read until an explicit
write initializes them; the constructor does not invent a post-bootloader RAM image.
This strict address-space contract backs the bounded reset probe below; it is not a
complete physical-board profile. The
constructor itself does not authenticate input; the caller must retain the exact
asset identity and separate ELF/raw audit.

### Physical reset execution

The separate `sifli-probe.wasm` module executes unchanged slot-0 reset instructions
using the shared Cortex-M33 instruction engine and the strict physical address space.
It does not reuse generic Pebble MMIO. A reviewed engine hook lets this board route
PPB/SIO accesses through its strict bus; other profiles retain their existing behavior.
Unknown accesses latch the first fault and stop. Reports retain the registers before
the failed instruction; no faulted instruction counts as completed. Coprocessor
instructions are explicitly unsupported. Executable SRAM writes invalidate decoding.

Entry contract `assumed-secure-reset-probe-v2`: Secure privileged Thumb Thread mode,
vector-derived MSP/PC, no active interrupts, explicit reset values for the supported
architectural registers, fresh backup-domain POR and unknown SRAM until written. This
is an assumption, not a captured physical bootloader handoff. Reset clears kernel BSS
and copies both initializers through actual instructions. Both production 4.37.0 images
now also complete `SystemInit` and reach `main`:

| Checkpoint | Obelix PVT | Getafix DVT2 |
|---|---:|---:|
| Enter `SystemInit` (completed instructions) | 328,883 | 313,880 |
| Enter `main` (completed instructions) | 331,741 | 316,738 |
| Copied SRAM bytes checked | 40,208 | 39,736 |
| Cleared BSS bytes checked | 175,142 | 150,797 |

The architectural subset models VTOR, CPACR, SHCSR, selected CCR controls and twelve
ARMv8-M MPU regions with MAIR and aliases. Access checks cover privilege, read-only
regions, execute-never, boundary crossing, overlapping matches, and the privileged
background map. Unsupported attributes and registers fail explicitly. Fault delivery
still terminates this diagnostic; complete architectural exception handling and the
STAR-MC1 implementation-specific coprocessors remain open.

The functional caches have the published HCPU geometry: 32 KiB/two-way I-cache and
16 KiB/four-way D-cache, with 32-byte lines. Instruction and data views are separate;
writeback, write-through, clean/invalidate by address or set/way, and dirty eviction
operate on actual bytes. Unknown SRAM stays unknown, including untouched bytes in a
cache line. Firmware must clean data and invalidate instructions to make modified
cacheable code visible. The integrated CPU test exercises that path through the guest
cache-maintenance register. The engine's decoded-op cache is disabled for this board,
so it cannot hide stale physical I-cache contents. Generic boards keep their original
fetch/cache behavior.

Cache replacement is deterministic round-robin; CCSIDR allocation/policy flags describe
the functional model. Neither is a measured silicon result. Only the memory attributes
used by this startup plus normal write-back `0xff` are accepted; unsupported encodings
stop explicitly. There is no calibrated bus/cache/oscillator timing or energy model.

The first minimal SoC register subset implements documented RTC backup-register POR
and storage, RCC pinmux enable/set/clear, initial clock selection and PA21 pad control.
The early boot clock model additionally implements HRC/HXT selection, HCLK division and
HXT request/readiness. Readiness depends on elapsed nominal 48MHz reference ticks, not
poll count. HRC is assumed ready at application entry; HXT starts requested with an assumed
48,000-tick settling delay. DWT CYCCNT/CPI counters use estimated engine costs with trace
enable, secure counter gating and wrapping. Only the assumed reset-disabled SysTick state
is readable; configuring an unimplemented timer/trace/DLL still faults.

Both unchanged images now execute the crystal switch, LCPU power-domain wake request and
230us/30us HAL delays. The documented LP_ACTIVE POR bit is power-domain status, not a
fabricated controller reply or proof of LCPU execution. Both images now execute the LCPU
reset/halt sequence under an explicit active-domain entry assumption. CPUWAIT remains
asserted after reset; releasing it requires missing LCPU execution state.

EFUSE transfers require caller-supplied bank data. Its timing/status, RCC gating and reset
behavior are modeled; absent data produces `MissingFactoryCalibration`. Separate synthetic
bank/identity fixtures verify the unchanged HAL's 32-byte copy and PMUC trim writes. The
next dependency under those fixtures is MPI2 TIMR (`0x50042084`) in NOR initialization.
These are not measured factory calibration or a complete `BSP_System_Config` result.
See the [factory-data interface and limits](SIFLI_FACTORY_DATA.md) and
[physical measurements](PHYSICAL_MEASUREMENTS.md). A successful calibration-transfer test
is not a successful watch boot, frame, app install or phone connection.

```sh
npm run build:wasm
npm run fidelity:physical-reset -- obelix_pvt /path/to/slot0.elf /path/to/slot0.bin report.json
npm run fidelity:physical-reset -- getafix_dvt2 /path/to/slot0.elf /path/to/slot0.bin report.json
node scripts/verify-sifli-browser.mjs /path/to/local/images report.json
```

The runner audits ELF/raw identity, caps each phase at 10 million instructions and
compares every initializer/BSS byte plus the `main` MPU/cache configuration derived
from pinned source, then checks the early clock/delay checkpoint, LCPU reset and separate synthetic calibration transfer/trim tests. Missing inputs exit 2;
a failed comparison or exhausted boundary search exits 1. Wasm ABI 4 runs
at most 100,000 steps per call so Workers can yield or terminate. The module has no
host imports. After loading and before executing, `sifli_configure_hxt(ticks)` accepts a
nominal 48MHz startup delay (`0xffffffff` injects failure); it rejects changes after execution.
Reports keep `estimatedCoreCycles`, reference ticks and measured instruction counts separate.
It is built with the static app but is not a working preview profile.
No production firmware is modified or published.

Actual Chromium, Firefox and WebKit Workers reproduce reset, main and early clock checkpoints, LCPU reset, synthetic calibration and the first
hardware boundary. [Browser record](evidence/sifli-browser-reset.json),
[Time 2 execution](evidence/obelix-reset-execution.json),
[Round 2 execution](evidence/getafix-reset-execution.json),
[source identities and assumptions](evidence/sifli-system-model-sources.json).
These are model/source consistency checks, not independent silicon validation.

Source declarations distinguish the boards:

- Obelix: LSM6DSO IMU, MMC5603NJ compass, NPM1300 PMIC, AW86225 haptics,
  CST816 touch, microphone, HRM and audio declarations.
- Getafix: LIS2DW12 accelerometer, MMC5603NJ compass, NPM1300 PMIC, CST816 touch,
  microphone and AW9364E illumination. The haptic driver differs by revision; DVT2 uses
  AW86225. A shared display-driver type is not proof of identical panel optics.

These declarations are evidence for inventory work, not verified sensor implementations.
The SDK's HCPU and LCPU have distinct memory maps and ROM dependencies. Its top-level
Apache-2.0 license does not automatically establish provenance of every binary component.
PebbleOS also selects separate nonfree fuel-gauge, touch-firmware and HR algorithm components.
No physical firmware or vendor blob was added to the static site's assets by this work.

Primary sources:

- [Obelix declarations](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/src/fw/board/boards/board_obelix.h)
- [Getafix declarations](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/src/fw/board/boards/board_getafix.h)
- [SiFli memory map](https://github.com/coredevices/SiFli-SDK/blob/bfee83c7adc0b19c2923f1788238def50f0a9dce/drivers/cmsis/sf32lb52x/mem_map.h)
- [Conditional binary dependencies](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/third_party/nonfree/CMakeLists.txt)
- [Official 4.37.0 release assets](https://github.com/coredevices/PebbleOS/releases/tag/v4.37.0)
- [Generic native RTC](https://github.com/coredevices/qemu/blob/v10.1.5-pebble17/hw/misc/pebble_rtc.c)

## Remaining gates

The five-stage plan is **not complete**. Native deterministic scenario replay, broader
CPU conformance, Kablooey's root cause, physical SiFli execution, physical sensor/controller
models, full active phone snapshots and calibrated optics/power remain open. No watch is
available for physical measurements. The existing generic runtime remains the default.
