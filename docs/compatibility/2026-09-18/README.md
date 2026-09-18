# Generic emulator census — 2026-09-18

The complete batch was recorded and sealed before evaluation. It uses this project's
unchanged browser Rust/Wasm core, generic 4.37.0 firmware, installer/transport and real
sandboxed PebbleKit JS companion. It is a headless execution census, not an Angular UI,
settings-page DOM, or physical-hardware acceptance test.

The corpus contains the official store's 100 Most Loved apps and 100 Most Loved watchfaces,
queried with `hardware=emery`. [The public API](https://appstore-api.repebble.com/) exposes
hearts, not active usage. The exact returned ranking, URLs, hashes and download records
are retained in [manifest.json](manifest.json). Missing packages and older-platform binaries
were retained rather than replaced with easier entries.

## Results

| Titles | Selected | Installed on ≥1 profile | Completed scenario on ≥1 profile |
|---|---:|---:|---:|
| Apps | 100 | 28 | 20 |
| Watchfaces | 100 | 34 | 17 |
| Total | 200 | 62 | 37 |

Of 200 titles, 183 had downloadable PBWs. Of those, 121 lacked a binary accepted by any
of the three current generic profiles. The other 17 store records had no PBW download URL.
All 118 cases with accepted native binaries installed; 77 completed the scenario and
41 stopped with companion JavaScript errors. **Completion is a bounded smoke result,
not proof of correct behavior, visuals, or complete functionality.**

| Profile cases | Emery | Flint | Gabbro | Total |
|---|---:|---:|---:|---:|
| Scenario completed | 37 | 18 | 22 | 77 |
| Companion execution stopped | 25 | 7 | 9 | 41 |
| No compatible binary | 121 | 158 | 152 | 431 |
| No download URL | 17 | 17 | 17 | 51 |
| Total | 200 | 200 | 200 | 600 |

No host timeout or core bus-fault outcome occurred in the corrected run. There were 118
within-run frame comparisons and zero reported trace overflows. These are generic-runtime
observations; there is no hardware reference oracle for this corpus.

## Findings and next priorities

1. **Older-platform PBW compatibility is the largest coverage gap:** 121 downloaded titles
   cannot be admitted by the current native-platform checks. Investigate documented firmware
   compatibility/loading paths and legitimate rebuild availability before promising broader
   store support. This does not authorize relabeling binaries or patching guest firmware.
2. **Configuration cancellation is the largest observed companion error group:** 23 of 41
   stopped profile cases threw while handling the canceled configuration response. Establish
   expected PebbleKit cancellation semantics and compare the existing phone implementation
   with those expectations before assigning blame to the app or changing responses.
3. **Other companion coverage:** six cases require unavailable WebSocket support; four fail
   during initialization on an undefined value, four stop after an earlier phone execution
   error, and four have other companion errors. These are grouped observations, not
   independently established root causes. Offline network policy can also limit functionality.
4. **Separate browser and live-service acceptance:** test actual settings loading/saving,
   networking/CORS, Android/iOS companion dependencies and the preview UI in dedicated batches.
   None is certified by the current headless offline scenario.

## Harness correction discovered after the first full batch

The initial complete 600-case capture had 42 host timeouts. Only after sealing and evaluating
that batch did aggregate timing analysis identify the same float/integer boundary in all 42:
the core reached its integer deadline while the host's millisecond comparison still indicated
remaining work. The harness could loop without advancing virtual time.

The fix uses `originTicks + durationMs * 64000` and compares integer ticks directly. A
regression test reproduces three observed boundary values. The existing fidelity-capture
script had the same loop pattern and was corrected as well. No browser or core behavior
was changed.

The complete, identical corpus was then captured again. All 42 timeouts disappeared:
31 now completed and 11 reached companion errors later in the scenario. All 46 originally
completed cases still completed, with identical final framebuffer hashes. Original raw
records and their seal remain preserved. [comparison.json](comparison.json) records these
aggregate transitions and frame comparisons.

## Performance and evidence

- 20 isolated emulator processes on 24 CPU threads / 94 GiB RAM.
- Corrected batch: **223.37 seconds** (3m43s), compared with 959.44 seconds before the
  harness fix. This is capture throughput improvement, not a browser FPS claim.
- 161 case records/minute, including fast unavailable/incompatible cases; not 161 full app
  executions/minute.
- About 18.8 CPU cores used on average from summed recorded process CPU time; peak individual
  worker RSS about 216 MiB. The Wasm interpreter does not use the GPU.
- **1,201,299,444 bytes** of sealed raw artifacts, plus derived evaluation/gallery files.
- 20 virtual seconds per executable scenario; deterministic epoch/seed, battery initially
  69%, sensor/button/touch/location/link inputs and configuration-open/cancel events.
- Event/console caps, sampled trace windows, unsupported sensor routes and missing captures
  remain explicit. No fabricated network or device responses were supplied.
- Validation: 402 JavaScript/Wasm tests passed, nine existing optional skips; includes
  bounded parallelism, seal integrity, evaluator gating/escaping, forced termination of a
  stalled worker and clock-boundary regressions. The existing fidelity runner's Clock smoke
  is also checked separately.

[report.json](report.json) contains every evaluated case and failure group;
[cases.csv](cases.csv) is the sortable case table. [evidence.json](evidence.json) identifies
firmware/core, capture sources, corpus and raw-seal hashes.

Raw files and the screenshot gallery remain local in the ignored directory
`tmp/compatibility-census-2026-09-18-ticks/`; open `evaluation/index.html` there.
The original batch is in `tmp/compatibility-census-2026-09-18-v2/`.
Firmware and store PBWs are not redistributed in git. See the
[runner documentation](../../COMPATIBILITY_CENSUS.md) for reproduction and limitations.
