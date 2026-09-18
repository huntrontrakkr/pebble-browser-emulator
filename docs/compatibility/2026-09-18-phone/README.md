# Phone compatibility fixes — 2026-09-18

Three changes address measured failures: documented empty-string configuration cancellation,
phone `navigator.language`/`languages`, and an isolated WebSocket interface backed by real
browser sockets when live networking is enabled. See [phone contracts and primary sources](../../PHONE.md).
No firmware, native binaries or CPU behavior were changed.

The exact previous 200-title corpus was captured again across all three generic profiles,
using 20 parallel processes. All **600 case records were sealed before evaluation**.
The [original manifest](../2026-09-18/manifest.json) is unchanged; hashes and source inventories
are in [evidence.json](evidence.json). Original captures/reports remain preserved.

| Result | Before | After |
|---|---:|---:|
| Distinct titles completing on at least one profile | 37 | 46 |
| Completed profile scenarios | 77 | 94 |
| Companion execution stopped | 41 | 24 |
| No compatible native binary | 431 | 431 |
| No download URL | 51 | 51 |
| Host timeouts / core bus-fault outcomes | 0 | 0 |

All 118 accepted profile binaries still install (62 distinct titles). Completed titles now
include 21 apps and 25 watchfaces. Emery completes 46 cases, Flint 21 and Gabbro 27.
These are 20-second offline smoke scenarios, not full feature or visual-correctness certification.

**18 previously failing cases now complete; one previously completed case now stops.**
Weather parses the documented empty cancellation string as JSON without handling the parse
error. The old null response parsed without that error. The report retains this regression
in observed completion; the runtime does not substitute invented settings to avoid it.
The other 76 previously completed cases still complete with identical final frame hashes.
Weather's last captured frame also matches, but its new capture ends at cancellation after
15 virtual seconds, so that equality does not establish complete-scenario equivalence.
[All transitions and frame comparisons](comparison.json).

## WebSocket evidence

Drunk O' Clock and Modulite 2.0 now complete on all three profiles instead of throwing
`WebSocket is not defined`. Together they make 42 offline connection attempts; each receives
failure, not a fabricated successful connection. Their actual server-dependent features
remain unverified. The companion API is present even when networking is disabled.

Separately, the actual browser Worker and QuickJS VM pass real local WebSocket text/binary
round trips in Chromium, Firefox and WebKit, including subprotocol negotiation, clean close,
offline blocking and socket cleanup on restart. [Browser traces](websocket-browser.json).
Enable **Network access → Browser network (HTTP + WebSocket)** for live connections.
This requires no backend; browser security, endpoint availability and authentication still apply.

## Remaining failures and priorities

- **16 cases:** apps parse canceled configuration as JSON without handling an empty response.
  Test their real settings save flows separately and investigate native exception lifetime
  before changing runtime error containment. Preserve errors; do not fabricate settings.
- **3 cases:** Maptastic requires binary XHR responses. ArrayBuffer/Blob HTTP support is the
  next bounded companion feature to add, with fixtures and actual browser acceptance.
- **4 cases:** other missing companion functions in Watchie-Talkie, Habits, Find My Phone
  and Rain. Establish each native API/service contract before implementing it.
- **1 case:** Get Back To sends an unsupported AppMessage value. Compare SDK serialization
  rules and the actual payload before coercing or rejecting it differently.
- **Largest coverage gap:** 121 downloaded titles lack accepted binaries for every selected
  generic profile. Documented legacy loading compatibility or legitimate source rebuilds are
  needed; relabeling those binaries is not evidence of compatibility. Another 17 titles have
  no PBW download URL in this snapshot.

Capture took **235.41 seconds (3m55s)**, retaining **1,247,436,462 bytes** of raw evidence.
There are 118 within-run frame comparisons and zero recorded trace drops. The added runtime
work and differing completed paths mean this is not a controlled performance comparison.
Raw evidence/gallery: `tmp/compatibility-census-2026-09-18-phone/` (ignored, local).
[Full report](report.json), [case table](cases.csv), [reproduction](../../COMPATIBILITY_CENSUS.md).

Validation: 410 JavaScript/Wasm tests pass, nine optional tests skip; TypeScript and the static
production build pass. Eight new tests cover the added contracts and lifecycle/bounds;
the three-engine real-socket gate is separate. CI includes its Chromium subset.
