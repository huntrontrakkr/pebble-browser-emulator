# Batch compatibility census

The generic runtime is the usable product target. Physical Asterix/Obelix/Getafix work is
paused; this census does not change the hardware fidelity gates or the roadmap.

The census separates **discovery, capture, sealing, and evaluation**. No app-specific
interpretation happens in the capture workers. The evaluator refuses a missing seal,
missing/duplicate terminal cases, changed manifest, or modified sealed artifact. A terminal
record means capture finished, failed, or timed out; it is not a compatibility verdict.

## Commands

Use a fresh output directory for each corpus/run:

```sh
npm run compatibility:corpus -- tmp/census-YYYY-MM-DD
npm run compatibility:benchmark -- tmp/census-calibration
PEBBLE_BATCH_WORKERS=20 \
  PEBBLE_FIRMWARE_DIR=tmp/firmware-releases/v4.37.0 \
  npm run compatibility:capture -- tmp/census-YYYY-MM-DD
# Only after capture has sealed the entire batch:
npm run compatibility:evaluate -- tmp/census-YYYY-MM-DD
```

Prerequisites: Node 24+, installed dependencies, the compiled browser core
`public/wasm/qemu-emery.wasm`, and locally supplied generic 4.37.0 micro/SPI images.
No firmware or third-party PBW is added to git. The existing static application still
requires no backend; these are local development tools.

`PEBBLE_CORPUS_COUNT` defaults to 100 per category (1–100). Discovery takes the official
[Most Loved API collections](https://appstore-api.repebble.com/) with the `hardware=emery`
query, retaining returned order, hearts, metadata, URLs, timestamp, hashes, and download
attempts. This is **public popularity, not measured installs or active usage**. The API
filter does not guarantee that a downloaded PBW contains the corresponding platform.
Missing/incompatible packages stay in the corpus; they are not replaced with easier titles.
Public downloads use six concurrent requests and at most three attempts, with bounded
sizes and redirects restricted to the official API/assets and observed store storage host.

Every title is attempted on qemu_emery, qemu_flint and qemu_gabbro. Platform validation
uses the application's existing PBW parser and binary checks, without relabeling legacy
binaries, patching firmware, or compiling untrusted source on the host.

## Parallel execution

The default worker cap is the minimum of 24, available CPUs minus four, and available
memory after a 4 GiB reserve divided by 2 GiB. Cgroup v2 CPU/memory limits are respected
when present. `PEBBLE_BATCH_WORKERS` overrides the pool size up to available CPUs.
Each case gets a fresh Node process, Wasm instance and QuickJS sandbox. Worker V8 heaps
are limited to 1 GiB; this is not an OS-level RSS limit. Measured RSS is recorded.

The calibration uses the bundled Clock with 1, 8 and the automatically selected worker
count. It records elapsed time, cases/minute and peak RSS without inspecting corpus
compatibility. Choose the measured throughput winner; memory alone does not justify
oversubscribing CPU-bound interpreters. The GPU has no role in the current Wasm interpreter.

On the development machine (24 CPU threads, 94 GiB RAM), Clock calibration measured:

| Workers | Batch elapsed | Cases/minute | Peak RSS per worker |
|---:|---:|---:|---:|
| 1 | 8.26 s | 7.26 | 200 MiB |
| 8 | 9.08 s | 52.88 | 202 MiB |
| 20 | 17.34 s | 69.20 | 201 MiB |

The census selected 20 workers, approximately 9.5 times the single-worker throughput.
These are host capture measurements, not watch FPS or hardware cycle measurements.

The per-case host limit defaults to 300 seconds (`PEBBLE_HOST_TIMEOUT_MS`). The parent
sends SIGTERM and then SIGKILL after two seconds, so a synchronous Wasm stall cannot
block the pool. SIGINT/SIGTERM cancels the batch; an interrupted batch remains unsealed.
There is currently no automatic resume: use a new run directory. Keep failed directories
as evidence rather than overwrite them. Missing shared firmware/core stops setup before
individual cases are scheduled.

## Captured evidence

- Original public catalog responses, immutable corpus identities, packages and hashes.
- Per-case job specification, terminal process status, stderr/stdout, exceptions and phases.
- Full available UART traffic, decoded transport packet boundaries, control messages and
  firmware console, streamed incrementally to disk.
- Firmware-produced GColor8 frames sampled at CPU boundaries, deduplicated by SHA-256,
  with frame counter, virtual time and PC. Up to 5,000 unique frames per case.
- Compressed full core checkpoints at boot, installation and terminal capture. These do
  not serialize the QuickJS VM or host transport and are not whole-system resume points.
- One-second virtual-time samples, scheduler steps, **estimated** CPU cycles, host elapsed
  time, memory, process CPU/resource usage. Executed instructions/hardware cycles are null.
- Bounded 1,000-step instruction/MMIO/exception trace windows once per virtual second,
  with trace ABI and explicit overflow counts. This is not exhaustive instruction tracing.
- Real isolated PebbleKit JS execution, phone events, storage, AppMessages and actual
  ACK/NACK responses, configuration-open/cancel lifecycle, and seeded virtual time/randomness.
- Requested/applied/rejected battery, motion/tap, compass, health, heart-rate, location,
  button, touch and connection inputs, including unsupported routes.

The default scenario lasts 20 virtual seconds (`PEBBLE_SCENARIO_MS`). It sets battery to
69%, changes sensors/battery/location, holds/releases up and down, touches supported boards,
opens/cancels configuration, and disconnects/reconnects. Inputs are identical across cases
except board-specific touch support. Holding buttons may intentionally navigate away from
a watchface; the gallery labels images as the last captured firmware frame.

Deadlines use integer core ticks throughout. The initial census exposed a float
round-trip in the capture loop: at some fractional-millisecond origins, the core reached
its integer deadline but the host's millisecond comparison remained true. All 42 initial
timeouts matched that boundary. Their raw evidence is retained, the loop has a regression
test, and the complete corpus is rerun after the fix. This finding concerns the capture
harness, not a demonstrated browser-runtime fault.

The event stream and console each have a 256 MiB per-case cap with explicit dropped counts.
Trace/frame limits are recorded. A parent kill can lose buffered final state, but already
written raw streams survive; missing observation files remain process errors. There is no
claim to capture events already lost inside hardware FIFOs or intermediate frames produced
within a CPU batch.

## Evaluation and acceptance limits

The [legacy PBW/phone follow-up](compatibility/2026-09-18-legacy/README.md) reruns the
unchanged 200-title corpus and separately captures 17 formerly missing collection PBWs
from official per-app details. Each batch was sealed before its evaluation; combined counts
substitute those 17 recovery rows by the same title/profile IDs. Its 407 completed scenarios
and 149 completing titles are bounded offline smoke results. The sealed reports retain errors
and predate the subsequent explicit rejection of root-level legacy builds on Gabbro.

After all planned terminal records exist, capture writes a SHA-256 inventory and seal.
Evaluation verifies these before reading results, then writes `evaluation/report.json`,
`cases.csv`, `SUMMARY.md`, and a filterable screenshot gallery `index.html`. HTML escapes
all untrusted metadata and logs. Evaluation is repeatable and never changes raw capture.

Results distinguish unavailable downloads, incompatible binaries, rejected packages,
process errors/timeouts, execution stops, observed firmware/companion errors, capture
truncation, and completed scenarios. A completed scenario is **not a correctness pass**.
Error pattern detection cannot identify every possible guest failure. Within-run pixel
comparisons expose frame changes, but have no real-device rendering oracle.

Network access is disabled in the companion sandbox; real errors remain visible rather
than being replaced with fabricated weather/service replies. No settings DOM/save, Android
or iOS companion app, live external services, notification/calendar scenario, complete
browser UI, long-duration behavior or physical timing acceptance is claimed. Those require
separate batches/acceptance gates. Use the census to prioritize coverage gaps after the
whole run, not to certify store-wide compatibility.
