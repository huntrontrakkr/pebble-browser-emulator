# Time 2 and Round 2 Hardware Fidelity Plan

## Summary and constraints

This plan supplements [the approved roadmap](docs/ROADMAP.md); it does not replace it.
Prioritize current-generation **Time 2 / Obelix**, followed by **Round 2 / Getafix**,
sharing a SiFli implementation where appropriate. Preserve existing diagnostic and generic
QEMU profiles, saved projects, and preview links.

No physical watches are assumed available. Development can proceed against published
documentation, source and independent software references. Physical validation remains an
explicit, incomplete gate until measurements exist.

The target is faithful firmware-visible behavior and progressively calibrated timing.
Do not advertise universal cycle accuracy, arbitrary firmware compatibility or measured
battery life. The application remains browser-only, with an optional resource cache service.
Android/APK emulation, older physical boards and hosting changes are outside this work.

## Plan 1 — Reference evidence and measurement infrastructure

**Purpose:** Establish what each comparison proves before changing the emulator.

- Inventory current CPU, frame, sensor, protocol and startup-checkpoint tests. Record which
  establish internal consistency, independent QEMU agreement or physical behavior.
- Create a versioned evidence manifest containing board/revision, firmware and app hashes,
  reference implementation/version, scenario, seed, initial state, capture method and results.
- Record capability status as **verified, modeled, unverified or unsupported**, with the
  reference target attached to every verified claim.
- Extend reference runners to execute identical scripted inputs against Rust/Wasm and pinned
  native QEMU. Capture registers at checkpoints, interrupts, selected MMIO, packets and frames.
- Develop small test applications for timer ordering, input latency, sensor delivery,
  drawing, communication and sleep/wake. Preserve source and exact build identity.
- Prepare physical capture using ordinary app logs and visual recordings first. Document
  where debug firmware, electrical access or instrumentation would be required.
- Distinguish stock-firmware from instrumented-firmware measurements. App-level logs do not
  establish exact CPU pipeline behavior.

**Acceptance:** A scenario reproduces with matching identity and seed, exports a reviewable
report, and identifies its first observable divergence. Missing physical measurements remain
unavailable rather than being replaced by synthetic evidence.

## Plan 2 — Timing correctness and the known app stall

**Purpose:** Resolve the demonstrated compatibility problem and establish a dependable clock.

- Reproduce Kablooey! with identical PBW and firmware in Rust/Wasm and native QEMU, retaining
  default-clock and instruction-count comparisons.
- Add bounded, opt-in tracing for instruction progress, interrupts, timers, sensor production,
  UART queues, audio activity and callback-overflow logs.
- Find the earliest divergence and reduce it to a regression scenario. Investigate execution
  budgets, interrupt semantics, peripheral backpressure and sensor rates independently.
- Fix behavior supported by reference evidence. Never compensate by modifying guest firmware,
  suppressing events or arbitrarily increasing guest speed.
- Separate executed instructions, estimated CPU cycles, virtual time and host time in reports.
- Extend the scheduler with deterministic deadline ordering and explicit clock conversions.
  Sleeping execution advances to the next eligible event; rendering and Worker yields cannot
  alter guest event order.
- Document stable ordering for simultaneous events. Preserve fractional conversion state
  across pause, reset and snapshots.

**Acceptance:** Kablooey! responds through ten virtual minutes of scripted gameplay and twenty
alternating installs with Clock, without overflow, reset or transfer timeout. Relevant behavior
agrees with the independent reference. WFI/WFE, interrupt masking, simultaneous deadlines,
clock conversion and pause/resume regressions pass. Unresolved CPU/audio dependencies block
this gate explicitly.

## Plan 3 — Physical SiFli board execution

**Purpose:** Execute unchanged production firmware in distinct physical-board profiles.

- Introduce a shared Rust SiFli SoC implementation with separate Obelix and Getafix descriptors.
  Share the instruction engine where justified; do not reuse generic QEMU peripherals as
  physical devices.
- Separate product, SDK platform, board revision and CPU configuration identities. Preserve
  generic profile IDs.
- Inventory flash layout, required ROM/controller assets and initialization dependencies
  using pinned source, linker scripts, vendor documentation and provenance records.
- Select the first revision per board with a complete, reviewable firmware/source/dependency
  set. Record it before implementation; if none qualifies, report missing dependencies.
- Implement documented reset state, memory aliases, executable flash, RAM, clocks, interrupts,
  timers, RTC, DMA and necessary interprocessor communication.
- Parameterize CPU identity/features. Differentially test decoding, register access widths,
  faults, nested exceptions, priority grouping, stack limits, privilege, MPU and FP contexts.
- Report unsupported MMIO/instructions with address, PC, width and board identity. Model
  documented reserved-register behavior explicitly.
- Extend bundles for physical assets and an explicit boot-entry contract. First support a
  documented post-bootloader state with unchanged payload bytes.
- Subsequently implement bootloader execution, slots, recovery, watchdogs and updates. Add ROM
  and controller execution only when dependencies and usage terms are established.

**Acceptance:** Each board independently boots a pinned production payload, presents firmware
output, installs an app, handles input and exchanges messages. Post-bootloader and cold-boot
execution have separate records. Never replace missing controller behavior with invented replies.

## Plan 4 — Peripherals, virtual phone, display and power

**Purpose:** Exercise firmware drivers and services through configurable scenarios.

- Give each board an evidence-backed inventory. Do not infer installed sensors from another
  product or generic emulator capabilities.
- Retain logical QEMU inputs. Physical scenarios use actual modeled registers, buses, sampling
  schedules, FIFOs and interrupts.
- Supply deterministic constant, step, pulse, periodic, seeded-noise and recorded-trace inputs,
  with explicit units and timestamps.
- Cover accelerometer, gyro, compass, heart-rate data, touch, buttons and microphone only where
  supported by the selected board. GPS remains a phone service.
- Configure range, quantization, sampling, latency, overflow, disconnect and device errors.
  Noise parameters remain assumptions until calibrated.
- Model supported audio/haptics queueing, completion and backpressure; inspect firmware output.
- Extend phone scenarios for settings save/cancel, storage, notifications, calendar, location,
  transfers, retries and reconnects.
- Separate phone protocol testing from Bluetooth controller/link testing. Inject deterministic
  loss, delay and disconnects at explicitly identified boundaries.
- Drive physical display updates and illumination from device state. Preserve raw framebuffer
  comparisons independently of optical rendering.
- Model PMIC, charging and sleep-state behavior. Separate manual battery percentage from energy
  estimates.
- Retain assumed optics; prepare per-panel calibration, controlled lighting/angle captures and
  held-out comparisons when hardware becomes available.

**Acceptance:** Supported devices have normal, boundary and failure scenarios; unavailable
devices are visibly unavailable. Physical firmware drivers observe modeled registers and IRQs.
Sensor, phone, display and power claims identify evidence and calibration limits.

## Plan 5 — Continuous validation, replay and performance

**Purpose:** Prevent fidelity regressions while keeping browser execution practical.

- Add a versioned scenario/trace format identifying firmware, board, app, core, seed and inputs.
- Extend active snapshots to watch/phone state, queues, clocks, randomness and pending transport.
  Reject incompatible snapshots transactionally.
- Record external network responses for deterministic replay; never silently issue live requests.
- Exercise boot, install/reinstall, configuration, sensor bursts, notification dismissal, low
  battery, charging, reconnects, sleep/wake and recovery.
- Require exact deterministic state/frame agreement at named checkpoints. Set timing tolerances
  from reference uncertainty before fitting; report distributions and outliers.
- Run fast synthetic tests in normal CI and longer compatibility jobs separately. Missing
  firmware/hardware prerequisites are **not run**, never passed.
- Benchmark guest throughput, startup, input latency, rendering and memory independently using
  ten-minute sustained workloads with browser/device identity.
- Optimize measured bottlenecks. Compare decoding caches/translations with the interpreter,
  including interrupts, MMIO, executable-memory writes and snapshot restore.
- Measure Pixel 9-class hardware when available; desktop/mobile-viewport tests do not qualify.
- Keep physical profiles experimental until their individual gates pass. Preserve QEMU defaults.

**Acceptance:** Releases report exact compatibility identities, evidence status, divergences
and performance. Existing QEMU Rust, Wasm ABI, browser, offline and reference gates remain green.

## Interfaces and delivery sequence

Extend the Worker/Wasm boundary with board identity, capability/evidence status, bounded trace
controls and explicit time metrics. Version saved-state/message changes; retain generic bundles.

1. Reference manifests and reusable scenario capture.
2. Kablooey timing diagnosis, corrective tests and scheduler changes.
3. Shared SiFli foundation and Time 2 production boot.
4. Time 2 peripherals/phone integration, then Round 2 board-specific implementation.
5. Compatibility gates, replay and measured optimization throughout.
6. Physical calibration and hardware verification when watches become available.

Deliver bounded, tested changes. Keep [STATUS](docs/STATUS.md) accurate and unresolved gates
in the approved roadmap. Software milestones can complete without watches. **Physical fidelity
cannot be marked verified without physical evidence.**

## Execution checkpoint — physical system initialization

Obelix PVT and Getafix DVT2 execute unchanged 4.37.0 reset code, initialize SRAM,
configure the MPU/caches and reach PebbleOS `main` in Rust/Wasm. Both pass actual
Chromium, Firefox and WebKit Worker checks. Architectural register access, MPU checks,
functional cache visibility and minimal documented boot registers now have regressions.

Plan 3 remains incomplete. The early HXT48 switch and DWT delay loops now execute with
explicit estimated timing. LCPU reset/halt, EFUSE reads and PMUC trim latches are modeled;
separate synthetic fixtures verify the unchanged calibration data path. Real factory inputs
remain absent, and the next synthetic-fixture boundary is MPI2 NOR initialization.
Remaining oscillator/power/clock sequencing, LCPU/ROM, physical calibration,
device controllers, full boot, display, installation and phone exchange still
need implementation and independent acceptance. Initial hardware state and cache replacement
remain explicit assumptions. [Evidence and reproduction](docs/HARDWARE_FIDELITY.md#physical-reset-execution).
