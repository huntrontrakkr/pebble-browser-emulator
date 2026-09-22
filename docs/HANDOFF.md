# Handoff: hardening the phone runtime and the verification suite

Written at `ed07826`. This records what was found, what was changed, what is
believed but unproven, and what is left. It is meant to be picked up cold.

Read `AGENTS.md` first; every constraint below is subordinate to it. In
particular: never manufacture a response, a register value or a frame; the
static application must work with no service; hosting needs a request.

## 1. The finding that should drive the next decisions

The census can now say _why_ companion runs fail. Applied to the sealed
`docs/compatibility/2026-09-18-legacy` capture, the 114 companion failures are:

| cases | class                           |
| ----: | ------------------------------- |
|    89 | `configuration-empty-response`  |
|    11 | `missing-api`                   |
|     7 | `appmessage-rejected`           |
|     3 | `configuration-unsupported-url` |
|     2 | `network-unsupported`           |
|     2 | `script-error`                  |
| **0** | **`network-refused` (CORS)**    |

Across all 600 cases, 187 issued 415 phone network requests and **none**
produced a CORS-shaped error.

**Consequence:** the app relay added in this work would have fixed zero of the
600 cases. It is built, tested and off by default, and it remains the right
answer if a specific API needs it, but it is not the compatibility unlock. The
configuration path is.

**Caveat that must be resolved before acting on the 89.** The census runs a
bounded ~20-second scenario and nothing drives the configuration pages it
opens, so the harness may be cancelling every one of them and manufacturing
this failure. Determine whether real users hit it before investing in it.
`scripts/compatibility/classify.mjs` is where the taxonomy lives; add a class
rather than widening an existing regular expression.

## 2. Verification: the structural problem, now half-fixed

Nineteen of twenty-five `scripts/verify-*.mjs` gates never ran in CI, eighteen
of which needed no configuration. That is why several regressions in this
session reached `main`: the checks that would have caught them existed and were
silent.

`scripts/verify-all.mjs` now serves `dist/client` once and runs every gate it
discovers, so adding a gate file is enough to gate it. Gates needing locally
supplied material report _not run, needs X_ rather than failing.

**Open work here:**

- The first full-suite run against current code had not completed when this was
  written. Expect gates that have not run in months to be red for real reasons.
  Triage them one at a time; do not disable one to get green.
- Running 13 gates serially will lengthen every CI run. If it becomes painful,
  split into a fast set on every push and the remainder on `main` only. Measure
  before optimising.
- `verify-all.mjs` runs gates sequentially. Several are independent and could
  run concurrently, but they share port 4201 and browser state; give each its
  own port before parallelising.

## 3. Kotlin: no test ever runs

- `phone-app/build.gradle.kts` declares no test source set and no
  `kotlin("test")` dependency.
- `phone-app/settings.gradle.kts` has no `include(...)`, so
  `phone-app/upstream/pebble` is **not a Gradle module**. The single test file
  there, `WatchappSettingsUrlNormalizationTest.kt`, is vendored provenance
  evidence and is never compiled.
- `npm run build:phone` invokes `wasmJsBrowserDistribution`, a build task.
  `check` is never called.
- Our own Kotlin is 167 lines across four files, with zero tests.

Next step: add a test source set, port the URL-normalisation test against
`SettingsNavigation.kt`, and run `gradlew check` in CI. Note that with only a
`wasmJs` target, tests run in a browser via Karma; a `nodejs()` test target may
be cheaper. This could not be attempted in the authoring environment because
Gradle needs `dl.google.com`.

## 4. Unreproduced user reports

Reported on a Pixel 9 against the hosted build, not reproduced:

- **Configuration save fails, intermittently.** Not reproducible without the
  Gradle-built companion. The host-side dialog was verified correct at 412×780
  (modal, fixed, full-screen, correct iframe sizing).
- **Text overlaid with other text.** Not reproduced. An automated overlap
  detector produced only false positives (label elements whose rects span their
  `<select>` options). Needs a screenshot from the reporter.
- **Stuck on a loading spinner (Real Weather).** Root cause unknown. Phone
  network failures now appear in the session log with the host and reason,
  which should identify it on the reporter's device.

A share of "it doesn't work" reports may be a stale build. The service worker
now switches to a downloaded version at the next launch when only one emulator
tab is open, so a device is at most one visit behind; with several tabs open it
waits for **Reload all tabs**. Confirm which build a reporter is on (the footer
names the commit) before investigating anything.

## 5. The relay, as built

- `services/resources/app-proxy.mjs` — address-guarded HTTPS relay. Guards at
  connection time via a `lookup` that refuses private, loopback, link-local,
  carrier-grade, benchmarking, documentation, multicast and reserved space,
  including IPv4 addresses embedded in v4-mapped and NAT64 form. Each redirect
  hop is revalidated. GET/HEAD only, no embedded credentials, three request
  headers forwarded and five response headers returned.
- `services/resources/service.mjs` — `/v1/app-fetch`, present only when a
  deployment supplies both a relay and a key of at least 16 characters.
  Separate token budget from downloads. Origin checked before the key.
- `src/app/service-defaults.ts` — a deployment may serve `service-config.json`
  beside the application. Absent or malformed means no service.
- `src/app/phone-network.ts` — retries a refused request through the relay.

**Known limits.** The key reaches browsers; it is a deterrent and a rotation
handle, not authentication. What bounds abuse is the budget, concurrency cap,
1 MiB response limit and 20-second deadline. POST is not relayed, so a
watchface needing one still fails.

**Not yet done:** the Preferences override field, the container image, the CI
deploy job on a repo secret, and documentation in `docs/OPTIONAL_SERVICES.md`.
Decisions already taken: container host, CI deploy on a secret, no domain yet,
key baked into `service-config.json` with a Preferences override.

## 6. Smaller known items

- `src/app/virtual-phone.ts` no longer invents a 0,0 fix; a phone built without
  coordinates reports `POSITION_UNAVAILABLE`. The location switch in simulated
  inputs is now honoured at start and live.
- Manually entered coordinates still apply even when the location switch is
  off, on the reasoning that an explicit action outranks the sample-data
  switch. Revisit if that is wrong.
- `scripts/compatibility/capture-case.mjs` fails `prettier --check`. It
  predates this work and CI runs no prettier step. Formatting it is a one-line
  change nobody has made.
- The `verify-all.mjs` prerequisite table was derived from each gate's refusal
  message. If a gate's message changes, the table silently goes stale; there is
  no test binding them together.

## 6a. Weather: done, and what is still missing

This section used to describe an unsolved problem. It is solved; the detail
moved to [WEATHER.md](WEATHER.md), which carries the record layout, the
capability bits and the pinned references. The short version of how it went:

- The capability gate was real, and answering it was not enough. The firmware
  asks once during a full boot, so a restored startup checkpoint never sees the
  request. The phone now announces itself on every link-up, which
  `session_remote_version.c` accepts unsolicited.
- Advertising `weather_app_support` alone broke boot. The capability word is
  replaced wholesale, so claiming bit 11 and nothing else cleared bit 0,
  `run_state_support`, and `app_run_state.c` moved app state onto the
  deprecated launcher endpoint `0x31`. The installer waits on `0x34`, so every
  launch timed out. Both bits are set now.
- The location list is a second record and it does not live in database 7. It
  is `BlobDBIdWatchAppPrefs` (9), key `weatherApp`; database 7 refuses it with
  `BLOB_DB_INVALID_DATA`. `weather_service` skips a forecast whose key the list
  does not carry, so the two records are only useful together.
- `weather_service.c` under `CONFIG_QEMU` was a red herring. The shipped
  qemu_emery 4.37.0 does not define it, and once the capability arrived the
  warning stopped without any of that mattering.

Still open: the v4 record, which is what the current firmware prefers and what
would fill the seven-day forecast, hourly data and per-day precipitation, wind
and UV that the watch currently draws as `--`. Writing it means claiming bit 24,
`weather_db_v4_support`, and filling every field it defines. Multiple locations
and reverse geocoding are also unimplemented.

The live Open-Meteo fetch has never run against the live service, only against
the vendor's published schema and an injected transport, because this
environment blocks `api.open-meteo.com`. That is the first thing to check from a
machine with open network.

## 7. Environment notes for whoever picks this up

The authoring environment could not: build the Kotlin companion (Gradle needs
`dl.google.com`), reach the deployed site (`github.io` is policy-blocked),
download CI artifacts (blob storage blocked), or reach the app store hosts the
census downloads from. Anything touching those must be verified in CI or on a
machine with open network. Do not take "passes locally" as coverage for them.
