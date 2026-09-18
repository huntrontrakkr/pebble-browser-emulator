# Prepared firmware startup

The browser can start from a clean, already-booted generic Pebble machine, then apply its
current synthetic inputs and install the selected app. Preparation runs the actual shipped
Rust/Wasm core with unchanged, reviewed official firmware. The result is an ordinary static
asset. No running server or per-visitor virtual machine is involved.

## Identity and behavior

Every checkpoint is identified by board profile, Wasm SHA-256, original micro-flash SHA-256
and original SPI-flash SHA-256. A changed firmware, core or profile cannot reuse the old
state. The static manifest and compressed artifact have exact size/hash checks; local
copies are verified before decoding. A missing, corrupt, incompatible or slow download
falls back to normal boot. **Preferences → Watch startup → Use prepared startup state**
can be disabled to exercise a complete boot on the next preview session.

Capture happens at an instruction boundary after the real firmware emits its ready log,
before phone writes, synthetic inputs, calendar/notification setup or watchface installation.
The prepared snapshot contains no visitor data, settings, accounts, tokens or live phone
session. Restore sets the RTC to current time, then uses the normal phone/demo/install path.
Reset retains the existing restart semantics and current session flash.

Supported imported emulator firmware can create a clean startup cache after its first normal
boot. One compressed checkpoint per board is stored on the device. A shared published state
is accepted only when all identity fields match. Full active phone/watch session snapshots,
arbitrary physical firmware compatibility and deterministic external networking remain open.

## State format

- Versioned gzip container (`.pbcp`) with a bounded JSON header and explicit binary machine
  data. The opaque extension avoids HTTP stacks automatically expanding `.gz` bodies.
- CPU registers, PPB/NVIC/MPU/FPU, exclusive/event/interrupt/security state and atomic latches.
  Floating-point bits, including NaN payloads, are preserved.
- Original code, RAM, changed SPI flash, draw and presented framebuffers, timers, RTC,
  UART queues, touch/audio registers and board scheduler state.
- Host QEMU/SPP packet fragments, inbox and sequence position. An active phone transfer
  cannot be mistaken for a clean startup transport.
- No raw struct layout, pointers, native host clocks or derived decoded-instruction cache.
  Exhaustive struct destructuring requires new core/device fields to be explicitly reviewed.
- Uniform 256-byte memory blocks use a fill byte; all other bytes are retained exactly.
  Allocation and container sizes are bounded. Invalid restoration is transactional.

This format is separate from `diagnostic-v1`. The core ABI exports save/pointer/clear/restore
operations; browser code keeps generated buffers short lived. Generated Wasm and checkpoint
files remain ignored. The local CPU addition is reviewable in
[its patch](evidence/startup-checkpoint-cpu.patch) and the vendor change log.

## Build and comparisons

```sh
npm run build:wasm
npm run build:checkpoints
```

`npm run build:web` includes preparation automatically. For each profile the builder boots
actual 4.37.0 firmware, captures its state, restores into another instance, and compares every
serialized machine byte. It then advances both instances through three checkpoints, including
battery/button inputs, comparing complete state, UART output and displayed frames each time.
Any mismatch fails the build before the manifest is replaced. Outputs are in
`public/checkpoints`; measurements are in `tmp/startup-checkpoints/preparation.json`.

The compressed states are approximately 1.1 MiB (Flint) and 1.5 MiB (Emery/Gabbro). Local
Node measurements show roughly 7–8 seconds of cold boot CPU work versus 14–32 ms to restore.
That restore measurement excludes core loading, firmware/checkpoint downloads, decompression,
phone initialization and app installation. It is not a Pixel 9 measurement or steady-state
frame-rate claim. The live mobile-viewport browser gate checks the actual complete preview.
Recorded scheduler steps include sleep advancement; they are neither calibrated hardware
cycles nor a count of executed guest instructions.

These comparisons establish checkpoint equivalence to the same emulator's cold execution.
They do not prove new hardware fidelity. Existing independent native QEMU frame gates and
CPU/reference tests remain applicable, and physical-watch timing remains uncalibrated.
The current build also matches all three frozen native sensor frames exactly; see the
[combined build/browser/reference acceptance record](evidence/optional-resources-startup.json).

## Upstream release checks

```sh
npm run firmware:check
npm run firmware:check -- --validate
```

The checker enumerates bounded official release pages, distinguishes normal QEMU assets
from SDK-shell/physical images, and selects the latest complete stable numeric release.
`PEBBLE_FIRMWARE_TAG=v4.37.0` requests an exact tag directly, including releases beyond the
catalog page limit. Validation checks published sizes/hashes, boots all three boards and
runs the same state/input/UART/frame comparisons. Candidate firmware/checkpoints stay in
`tmp/firmware-releases`; the build refuses candidate output outside `tmp`.

`.github/workflows/firmware-releases.yml` runs daily and on manual dispatch. It uploads only
catalog/validation reports, never unreviewed firmware. Automatic default promotion is
deliberately gated: a new release still needs source/license review and independent reference
evidence before updating the bundled firmware inventory, corresponding notices, and default
version. Successful internal continuation alone does not approve redistribution or establish
physical firmware compatibility. No hosting or visitor project compilation is part of this job.
