# Legacy PBW and companion follow-up — 2026-09-18

Binary XHR (ArrayBuffer and Blob), a bounded browser HTTP bridge, timeline-token callbacks,
window event listeners, AppMessage object methods, and guest callback error containment address
the measured phone gaps. Legacy PBW builds can be selected unchanged on the three generic
firmware profiles where the firmware accepts them. The store now hydrates collection entries
whose release is missing through the official app-detail endpoint; direct store links accept
supported legacy builds. A legacy selection is labeled in the UI. No binary headers, firmware,
CPU behavior, or guest scripts are patched.

The identical [original 200-title corpus](../2026-09-18/manifest.json) ran for 20 virtual
seconds on all three generic profiles with 20 parallel isolated processes. A second 17-title
batch used official per-app metadata and PBWs for collection entries that had no release URL.
Both complete batches were **captured and sealed before evaluation**. The main capture retained
5.45 GB of raw evidence; the recovery batch retained 401 MB. [Hashes, source inventories,
run times, and combined counts](summary.json) identify the evidence. Original and recovery
[full reports](original-report.json) ([recovery](recovered-report.json)) and case tables
([original](original-cases.csv), [recovery](recovered-cases.csv)) keep the two runs separate.
Raw event streams, UART, bounded instruction/MMIO traces, checkpoints, and frame bytes are
local in the ignored `tmp/compatibility-census-2026-09-18-{legacy,recovered}/` directories.
The [recovery manifest](recovered-manifest.json) records each official detail URL and PBW hash;
PBWs and firmware are not redistributed.

| Outcome across 600 cases                  | Before | Combined capture |
| ----------------------------------------- | -----: | ---------------: |
| Scenario completed without recorded error |     94 |              407 |
| Companion error observed                  |      — |              126 |
| Firmware error observed                   |      — |                8 |
| Execution stopped                         |     24 |               51 |
| No compatible binary                      |    431 |                2 |
| Host timeout or execution budget          |      0 |                6 |
| Download unavailable                      |     51 |                0 |

**199/200 titles installed on at least one profile; 149/200 completed the bounded scenario
without recorded errors.** All 94 previously completed cases still completed with identical
final frame hashes. Emery completed 148 scenarios, Flint 139, and Gabbro 120. This is offline
smoke coverage on generic emulator firmware, not proof of accurate display, full features,
live services, configuration pages, physical hardware behavior, or long-duration stability.
The main capture took 22m01s with 20 workers while a separate three-worker recovery batch
ran; elapsed times are host throughput, not watch performance.

The principal remaining companion cluster is 96 cases where an app parses the documented
empty configuration-cancel response as JSON and throws. The new phone VM records that error
and can handle later events; the evaluator still marks it as an error. No settings are invented.
There are also unsupported app payloads, service-dependent callbacks, and real firmware faults.
Among 40 Gabbro launch-response timeouts, 39 used root-level legacy PBWs; one firmware log
explicitly reports an unsupported SDK version. After this capture, the package selector was
tightened to reject root-level builds on Gabbro immediately. The sealed table deliberately
retains the observed timeouts; no post-change census result is inferred from it. Native and
other supported legacy builds remain selectable on Gabbro. The last title without any
successful install is Ventoo; all three profiles timed out awaiting its launch response.

Actual Chromium, Firefox and WebKit Worker/QuickJS checks pass live binary HTTP/XHR and
WebSocket round trips ([browser record](phone-browser.json)). The store-detail hydration and direct legacy link paths have unit
tests, as do package validation and rejection. A separate [live Chromium record](browser-evidence.json)
shows the archived Modern face in Most Loved, its detail hydration, original PBW download,
and a ready 200×228 Time 2 frame with no page errors. Reproduce it with
`node scripts/verify-legacy-store-browser.mjs` while the web app serves on port 4201.
Real store URLs still depend on upstream
availability, browser CORS, or the optional public-resource relay. See [phone contracts](../../PHONE.md),
[census method](../../COMPATIBILITY_CENSUS.md), and [project status](../../STATUS.md).

The evidence supports wider **install and short-run coverage**, not universal app
compatibility. Settings DOM/save, live third-party services, source compilation across SDK
versions, physical reference frames, and the remaining firmware/phone failures have separate
acceptance gates.
