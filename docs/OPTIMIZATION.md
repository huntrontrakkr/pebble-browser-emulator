# Measured optimization with Dream-RSI

The development harness from the local Dream-RSI project can search for faster Rust/Wasm
implementations while keeping the evaluator, firmware and correctness tests fixed. It is
development tooling only. The deployed emulator remains entirely browser-only.

## Retained result: interrupt delivery

On 2026-09-17, the core's per-step scan of 32 possible interrupt lines was replaced with
iteration over the set bits. This preserves the same low-to-high assertion order and all
existing level, pending, active and wake-up logic. The change came from code review during
the experiment, independently of the generated memory candidates.

Measured core throughput relative to the frozen original Wasm:

| Current profile         | Node/V8 | Chromium worker | Firefox worker | WebKit worker |
| ----------------------- | ------: | --------------: | -------------: | ------------: |
| 2 Duo (`qemu_flint`)    |  +19.2% |          +21.9% |         +11.5% |        +32.6% |
| Time 2 (`qemu_emery`)   |  +18.8% |          +21.3% |         +18.2% |        +20.4% |
| Round 2 (`qemu_gabbro`) |  +19.3% |          +25.5% |         +19.1% |        +15.9% |

These are local x86-64 Linux/WSL2 measurements on an i9-12900KF. Node used three alternating
pairs after a warm-up pair; each browser side used one warm-up and three samples, reversing
side order between profiles. The Node aggregate was **1.191×**. Its button phase improved
31–33%; its boot phase improved 13–16%. The same-binary noise control scored 1.007×.
Browser measurements confirm the direction of the improvement, but their block ordering
and short runs make the exact percentages less precise than a longer device experiment.

Every register, virtual-time, fault, frame and UART checkpoint matched the original on all
three profiles in Node and all three browsers. Wasm linear memory did not increase.
The sensor checkpoint frames also matched the existing native-QEMU reference bytes exactly.
The real Clock/phone settings workflow, original JustTheTime store watchface, sensor inputs,
and shared phone/watch clock tests passed. The runtime's presentation limit and virtual-clock
pacing are unchanged. **This is not a measured FPS or Pixel 9 speedup.**

Raw samples, source/firmware hashes, experiment decisions and acceptance results are retained
in [the optimization evidence](evidence/optimization.json). A finite benchmark does not
establish the maximum achievable speed or equivalence for every firmware/app combination.

## First experiment: memory access

`scripts/optimization/research.py prepare` freezes the current Rust workspace, Cargo locks,
the built baseline Wasm, the evaluator and firmware hashes. Candidates can replace only
the memory-access fragment in `crates/qemu-emery/src/lib.rs`. The original instruction
engine, virtual clock, interrupts, peripherals, firmware, app packages and presentation
policy stay outside that fragment.

The initial configuration allows six discovery calls over two cycles and one scheduler
revision, using the external harness's code-generation adapter. Experiments are sequential:
concurrent timing runs would interfere with one another. Candidates and model usage are
retained in the ignored output directory. No candidate is automatically applied or deployed.

The first completed run made six discovery calls and one scheduler revision. One candidate
violated read-only code memory and failed the independent oracle; two failed to compile
because the original adapter and generated source disagreed about the surrounding `impl`
containers. One valid candidate scored 1.009×, within the same-binary noise range, and two
generation calls timed out. **No generated memory candidate was retained.** The adapter now
accepts complete containers and has regression tests for that boundary and helper retention.
The original frozen run is preserved; these fixes apply to subsequent experiments.

Each evaluation requires:

- The complete Rust workspace tests, including an independent byte oracle for bus access
  widths, alignment, partial reads/writes, read-only code, address wrap and fault ordering.
- Exact deterministic traces against the frozen core on all three current firmware
  profiles: registers, virtual ticks, fault state, completed frame pixels and all UART bytes
  at 40 checkpoints per run.
- Paired baseline/candidate timing after warm-up, alternating order over three repetitions.
  A profile or phase median regression over 3%, or increased Wasm linear memory, rejects
  the candidate even if the aggregate score improves.

The score is the geometric mean of per-profile median core speedups. These measurements
time only core execution. A "step" is an emulator scheduler step and may include sleep;
it is not a calibrated hardware cycle or necessarily an executed instruction. Core
throughput, UI frame rate, startup time and physical-phone performance are separate metrics.

The selected source also needs manual review, repeated timing outside discovery,
`npm test` against its built Wasm, native-reference sensor frame checks, and browser
watchface/phone configuration acceptance. Passing a finite suite cannot prove universal
equivalence or a global performance maximum. Scheduler evolution itself is not credited
with a causal benefit without a matched control experiment.

## Run locally

Build the baseline first with `npm run build:wasm`. Supply a Dream-RSI checkout and a
directory containing the six unchanged `qemu_{flint,emery,gabbro}_v4.37.0_{micro,spi}_flash.bin`
images. The normal bundled firmware can be decompressed locally for these inputs.

```sh
python3 scripts/optimization/research.py prepare \
  --harness /path/to/dream-rsi \
  --assets /path/to/firmware \
  --output tmp/optimization/new-search
PYTHONPATH=/path/to/dream-rsi python3 -m dream_rsi run \
  tmp/optimization/new-search/config.json \
  --output tmp/optimization/new-search/run
```

Preparation makes no model calls. Running consumes the configured model usage. The default
model and limits are explicit in the generated config; edit it before starting a new run.
Create `run/CANCEL` to cancel, or use the same run command with `--resume` to recover.
The CLI can stay in the foreground; scheduling recurring runs is a separate operation.
Frozen evaluator files are checked before every evaluation. Do not alter them during a run.

The bridge uses the external project directly and records its source hashes in the
manifest; it does not vendor that project or require it to build/use the emulator.
Copied workspaces and the candidate-source checks are not an adversarial-code sandbox.
Run only trusted local experiments. Generated candidates have no tools and must return
source to the fixed evaluator.

Independent timing commands:

```sh
node scripts/optimization/benchmark.mjs baseline.wasm candidate.wasm /path/to/firmware report.json 5
node scripts/optimization/benchmark-browser.mjs baseline.wasm candidate.wasm /path/to/firmware browser-report.json
```

The browser runner starts and closes a loopback-only static fixture server, executes the
core in actual Web Workers, and checks identical traces. `PEBBLE_BROWSERS` and
`PEBBLE_PROFILES` select engines/profiles. Linux browser libraries may need local setup.
It measures browser execution, not a physical Pixel 9 or full application frame rate.

For acceptance after selecting a candidate, run the existing sensor integration test with
`PEBBLE_TRACE_DIR` on each profile. Compare `<profile>-sensor-checkpoint.bin` with the native
hash in `docs/evidence/sensor-service-gate.json`; this is the state with acceleration
`111, -222, -999`. The separate `-sensors-frame.bin` is captured **after** the later scenario
changes acceleration to `321, 123, -1000` and must not be compared with that earlier reference.
Use `PEBBLE_WASM` to run the same firmware harness against a specific baseline or candidate.
The shared-clock test can use the verified Emery sensor-test PBW as `PEBBLE_PBW`; it accepts
the timer-driven AppMessage while the test verifies the actual firmware ACK and clock barrier.
