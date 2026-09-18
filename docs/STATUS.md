# Compatibility and verification

Current implementation priority is Pebble Time 2, Pebble 2 Duo and Pebble Round 2. Older
watch hardware is deferred; the seven app platforms and distinct board descriptors remain.
Compilation and firmware execution have separate acceptance gates. Three generic emulator
boards run verified firmware; physical-watch firmware remains incomplete.
See the [product and board matrix](PRODUCT_MATRIX.md) for every model, including the distinct
2016 and current Pebble Time 2 generations.

## Time 2 optical prototype

Time 2's 3D preview now offers **Layered (experimental)** and **Standard** display optics.
An offline GPU spectral/polarization calculation produces a 272 KiB response atlas for
the live framebuffer. The browser interpolates angle-dependent reflection and backlight
response, with separate dynamic cover reflections. The static app includes the asset;
no optics server, GPU compute package or machine-learning runtime is required by visitors.
Other watches retain their existing materials. [Model, assumptions and reproduction](OPTICAL_MODEL.md).

The compact table differs from the full assumed model by less than one 8-bit sRGB level
on 4,352 test samples per response path. This is a numerical approximation check, not
physical calibration: layer properties, filter spectra and white-response normalization
are explicitly unmeasured. Firmware, sensor behavior and raw frame comparisons are unchanged.
Physical-watch calibration and Pixel 9 performance remain open acceptance gates.
The actual shader and live Clock comparison pass Chromium, Firefox and WebKit. A paired
desktop SwiftShader benchmark measures about 6% lower isolated render time; this is not
phone FPS or an emulator speedup. [Checks, captures and timing evidence](evidence/time2-optics.json).

## App loading and quick inputs

Preview now offers **Shake wrist**, **Wrist tap**, and direct screen contact on Time 2 and
Round 2. Flat screens accept taps/drags; the 3D view has an explicit touch/rotate toggle
and maps contact through the actual display mesh. Duo has no touchscreen controls.
Shake runs a deterministic 600 ms acceleration sequence on virtual time; its single tap
event reaches the same firmware input path as the developer panel. These are synthetic
inputs, not measured wrist motion. [Controls and limitations](SENSORS.md).

App installation shows transfer progress, stops after a protocol failure, and has a
45-second wall-time inactivity watchdog. Cancellation or a Worker crash releases the
loading state. **Restart preview** loads the selected package into fresh saved/default
firmware, and a failed session is not reused for the next preview. The previous companion
script is stopped before replacement. Browser checks cover the timeout/crash recovery,
actual input delivery, touch release, round clipping and rotated display mapping.

This does **not** resolve every app compatibility failure. Kablooey! 1.0.0 on Emery 4.37.0
can starve firmware services and cause a subsequent BlobDB install timeout. The unchanged
app works under native QEMU's default clock, but also overflows the firmware event queue
under native instruction-count timing. No CPU speed, guest instruction, audio behavior
or firmware patch was changed to mask that failure. The user's originally failing app was
not identified. [Investigation, evidence and next steps](APP_LOADING.md).

## Public downloads and prepared startup

The preview now browses official store watchfaces/apps, loads published PBWs directly, and
shares version/SHA-256-pinned links. Public downloads try the browser first. The optional
download/cache service is disabled until a user configures it; it handles approved public
resources and never executes visitor builds, watch firmware or phone scripts. GitHub release
PBWs and matching normal emulator firmware pairs can use it to overcome download CORS.
Direct store preview, cached reopening, service-assisted firmware download, and operation
after disabling the service have browser gates. [Setup and limits](OPTIONAL_SERVICES.md).

All three current generic boards have prepared boot states generated from unchanged official
4.37.0 firmware using the exact shipped Wasm core. Restore validates board/core/firmware hashes
and falls back to cold boot. Complete machine continuation, UART and frames match the original
cold instance through deterministic button/battery inputs. This is a restore-equivalence gate,
not new physical-fidelity evidence. The saved state precedes phone setup, synthetic inputs,
and app installation. [Format, measurements and checks](STARTUP_CHECKPOINTS.md).

A scheduled/manual GitHub workflow discovers and validates complete stable emulator releases
into temporary artifacts. New defaults require provenance and independent reference review;
the checker does not publish unreviewed firmware or change visitors' selected versions.
GitHub Pages publishes successful `main` builds after the production checks and verifies the
deployed files against the tested artifact. The optional service remains unhosted and disabled
by default. The separate Sites deployment is not updated by this workflow. [Hosting](HOSTING.md).
The production gate passes 87 Rust tests and 374 JavaScript/Wasm tests (nine optional fixture
tests skipped in that command), plus live service/store, Chromium/WebKit offline, real Clay
configuration and model regressions. Separate sensor runs match every frozen native QEMU
frame byte on all three profiles. [Hashes, measurements and browser scope](evidence/optional-resources-startup.json).

## Demo settings and watch controls

Preview defaults now set battery to **69%**, seed two fictional notifications and two
calendar entries, and supply configurable synthetic motion, health, phone location and
Time 2 raw heart rate. The Simulated inputs dialog persists local preferences. Firmware BlobDB
acknowledgments confirm sample insertion, notification status updates and owned-record
cleanup on all three current profiles. Watchface installation waits for this setup.
The controls sit beside the screen and follow the watch in 3D; all three current products
have their own official, checksummed CAD model. [Behavior, protocol and limits](DEMO.md).
[Browser, firmware and cache acceptance records](evidence/demo-workflow.json).
The Round 2 live-alert rendering failure is fixed: our demo encoder omitted the standard
Dismiss action. Controlled native QEMU comparisons isolate that omission; adding the action
restores the message without changing firmware. Chromium, Firefox and WebKit match every
visible notification pixel below the status clock. [Root cause and scope](NOTIFICATION_RCA.md).

## Preview and phone usability

Watch selection now automatically reopens the active example/project/PBW on the selected
profile instead of pausing on the old watch. 3D switching retains one WebGL renderer,
cancels obsolete geometry Workers and disposes inactive GPU buffers. Checksummed official
CAD is simplified off the UI thread with a bounded error metric and cached on the device;
Time 2 and 2 Duo use 83% and 88% fewer triangles, while the smaller Round 2 uses 32% fewer.
Repeated screen frames skip texture uploads. A reflective LCD/clearcoat material, separate
backlight emission, studio/daylight/warm-room environments and light direction controls
improve the optical preview. They are uncalibrated approximations; firmware pixels and the
Rust core remain unchanged. [Scope, root cause, measurements and browser checks](MODEL_RENDERING.md).

Local HTML/Clay settings now return within their sandboxed document, removing an HTTP
callback that could strand Save on a browser error page if the connection dropped. The
compiled companion, PKJS and firmware acknowledgment path remain intact. The Clock save
gate disconnects networking before Save and checks the actual ACK and changed framebuffer
on Chromium, Firefox and WebKit. JustTheTime's original Clay form passes on all three
current watch profiles in Chromium. A separate fresh-development startup failure is also
fixed: the firmware loader handles Fetch's automatic HTTP gzip decoding while preserving
exact-size and official SHA-256 checks. [Investigation and scope](CONFIGURATION_SAVE.md),
[352 unit passes and browser evidence](evidence/configuration-save.json).

The preview now groups the screen, physical watch controls, connection/battery state and
App configuration in one surface. The example, PBW picker and GitHub disclosure share one
opening panel. Mobile configuration uses a native full-screen dialog; desktop keeps it
beside the watch. Theme, installation, offline downloads and explicit updates are in
Preferences. The last opened PBW is saved locally for reopening. Firmware execution and
the source-ported companion protocols are unchanged by this presentation work.

The production build includes a PWA manifest, safe-area icons and a checksummed service-worker
inventory. Offline downloads are selected per watch and include the actual default firmware,
Clock example and companion settings module. Updates wait for approval while a tab is open,
preserve selected offline watches, and reject activation while another watch tab is open.
The service-worker behavior has tests for cancellation, corrupt assets, quota errors and
failed updates. The complete CI artifact now builds the companion as well as the Rust core.
See [installation, offline scope and verification](PWA.md). Offline compilation and physical
mobile installation/performance remain separate release gates.
The production PWA gate passes Chromium with network-offline emulation and WebKit with
the static server disconnected. Preview and companion regression checks pass Chromium,
Firefox and WebKit; the original store watchface, synthetic inputs and 3D controls pass
on all three current profiles. The unchanged QEMU Wasm hash, 350 passing unit tests
(9 optional fixture tests skipped), browser scope and results are recorded in
[UI/PWA evidence](evidence/ui-pwa.json). [Desktop](evidence/preview-desktop.png) and
[mobile](evidence/preview-mobile.png) captures show the revised layout.

The first actual companion source port now runs the upstream settings Scaffold/header and
unchanged Kotlin URL interceptor in a separately loaded Kotlin/Wasm module. **App configuration**
opens beside the watch; Clock includes a real configurable HTML page and native settings
receiver. Save/Cancel/Back, actual firmware ACKs and frame changes, persistence/reload,
sandbox isolation and the actual Clay form have dedicated browser gates. This remains a
bounded settings port: native accounts, library/store, database, BLE and libpebble3 services
are not ported. External pages must honor `return_to`; universal custom-scheme interception
is not possible. [Scope, source, limits and evidence](COMPANION_PORT.md).

The original **JustTheTime** store PBW also passes the live HTTPS workflow on all three
current profiles in Chromium at a mobile viewport: its bundled Clay 1.0.8 form saves a
background change, actual firmware acknowledges it, the framebuffer changes, saved settings
reopen, and native Back cancels without another AppMessage. No watchface-specific runtime
changes or mocked responses are used. This is one real store fixture, not a universal
compatibility or physical-phone performance claim. [Reproduce and try it](STORE_WATCHFACE_TEST.md)
and [acceptance record](evidence/store-watchface-browser.json).

The first workspace now offers **Try example**, **Open watchface .pbw**, and GitHub project
previews. It starts no Workers until needed. Clock is an actual precompiled native watchface;
its installation uses the same firmware protocol as developer builds. Official 4.37.0
emulator images now load automatically from the static site on first use, with exact-size
and published SHA-256 checks. A saved/imported pair overrides this default. Original
firmware bytes remain unchanged; Time 2's compressed pair downloads about 1.52 MB.
The bundled loader, cancel/restart and cache reuse pass Chromium, Firefox and Linux WebKit.
An actual 4.36.0 import overrides the 4.37.0 default and survives reload; a failed download
can be retried. [Default firmware browser evidence](evidence/default-firmware-browser.json).
Prepared projects use a checksummed `pebble-preview.json`; source-only projects retain the
existing SDK and compiler acceptance limits. [Link contract and setup](PREVIEWS.md).

Screen snapshots are coalesced independently of guest execution, clock-barrier messages no
longer update Angular on every quantum, and preview mode paces the virtual clock. Developer
panels load on demand; the optional 3D renderer stops when inactive. Startup reuses the flash
upload allocation: measured Emery Wasm linear memory fell from 104.5 to 40.375 MiB. These
changes reduce host work without establishing a physical-phone FPS claim or calibrated cycles.
The new core still matches all three frozen native sensor frames exactly.
The preview/cached-reload workflow passes Chromium, Firefox and Linux WebKit at a mobile
viewport, including WebKit's IndexedDB fallback. [Memory, frame and browser records](evidence/preview-performance.json).
An actual public GitHub preview also passes both routes: downloading its commit-pinned
prepared package, and importing Clock source, opening the real SDK, compiling with the
browser Wasm compiler and automatically installing. [GitHub workflow record](evidence/github-preview-workflow.json).

The interrupt-delivery loop now visits asserted lines in the same order without scanning all
32 lines per step. Paired Node tests measured **19% higher core throughput** across the three
current profiles; actual Chromium, Firefox and WebKit Workers also improved. Every deterministic
trace matched the original core, Wasm linear memory was unchanged, and the native sensor frames,
phone settings, shared-clock and original store-watchface gates passed. This is desktop core
throughput, not a measured Pixel 9 or UI FPS improvement. The external Dream-RSI harness is
connected as local development tooling with frozen tests and firmware; its first six discovery
attempts yielded no retained memory change. [Method, results and reproduction](OPTIMIZATION.md)
and [raw evidence](evidence/optimization.json).

Routine phone/watch clock synchronization now travels directly between Workers, with an
ordered UI fallback for packets and timed inputs. Storage snapshots occur after mutations;
unchanged frames omit pixel transfers, rendering reuses its pixel buffer, and diagnostic
observers publish in batches. Three paired Chromium runs measured **97.7% fewer main-thread
clock-message crossings** and no periodic redraws of an unchanged Clock screen. The isolated
phone clock/output loop improved 2.6–6.0× depending on stored payload. The core Wasm remains
byte-identical to the previous version; this is not a whole-emulator or physical-phone FPS
claim. [Method and limits](BROWSER_PERFORMANCE.md) and [raw evidence](evidence/browser-performance.json).

| Capability                 | Verified scope                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firmware execution         | Unchanged official `qemu_flint`, `qemu_emery`, `qemu_gabbro` PebbleOS 4.37.0; Emery 4.36.0 also passes the installation/input workflow.                                                                                                                  |
| Physical and older watches | Firmware package inspection; physical Asterix/Obelix/Getafix and legacy Tintin/Snowy/Spalding/Silk/Robert execution remain unimplemented.                                                                                                                |
| GitHub source              | Public repositories, commit-pinned downloads, branches/subfolders, local ZIP and folder import; unsupported build behavior reports an error.                                                                                                             |
| Linux build sandbox        | Local container2wasm WASI image, custom YAML/shell commands, imported dependencies, quotas, cancellation and artifact export. Python + actual ARM GCC object generation verified; full SDK/Waf PBW gate remains open.                                    |
| Native C builds            | SDK 4.33.1 headers/libraries/defines/limits for Aplite, Basalt, Chalk, Diorite, Emery, Flint and Gabbro; modern and legacy SDK 3 metadata.                                                                                                               |
| Resources                  | PNG/PBI/bitmap/raw resources, selected platform variants, aliases, generated IDs, resource packs and menu icons. Custom font/SVG generation is pending.                                                                                                  |
| JavaScript builds          | Local CommonJS/ES modules/JSON, SDK message keys, integrity-checked npm v2/v3 lockfiles, published Pebble JS `dist.zip` packages.                                                                                                                        |
| Installation               | Actual BlobDB/AppFetch/PutBytes transfers, CRC commits, native app-running events, main binary/resources/background worker.                                                                                                                              |
| Background workers         | Compiled/packaged worker matches SDK metadata; firmware starts it and emits its expected log.                                                                                                                                                            |
| Virtual phone              | Isolated QuickJS, geolocation, time/timers, app storage, actual AppMessage ACK/NACK, watch context, XHR/fetch test responses or browser CORS.                                                                                                            |
| Configuration              | Source-ported upstream Kotlin/Compose settings, sandboxed HTML/Clay pages, automatic correlated returns, app-scoped persistence. Remote pages require `return_to` and browser embedding support; explicit new-tab fallback.                              |
| Inputs and inspection      | Accelerometer, tap, touch, health metrics/raw heart rate, health preferences, compass channel, seeded scenarios/CSV; battery/buttons/time/link; phone location/errors; actual haptic output events and protocol inspection.                              |
| Firmware identity          | Exact release tags from public GitHub sources; checksummed, board-specific bundle imports. A file being accepted does not imply firmware compatibility.                                                                                                  |
| Frame comparison           | PBF/raw reference import, full canonical pixel/hash comparison, difference map and JSON report. Sensor-test frames match native QEMU on all three profiles.                                                                                              |
| Display                    | 144×168 monochrome, 200×228 color, 260×260 round color; committed guest frames; exact color conversion. Reflective optics remain an approximation.                                                                                                       |
| 3D model                   | Simplified official current Time 2, 2 Duo and Round 2 CAD with live native-resolution screens, reflective materials and selectable lighting. Optical response remains uncalibrated. |
| State                      | Watch restart preserves modified SPI flash and RTC. Matching pristine startup checkpoints restore the full generic machine and host transport. Phone timers follow watch time with acknowledged 10 ms quanta. Active phone/watch session snapshots and complete session replay remain pending. |

## New acceptance gates

- `examples/sensor-test` builds with the actual Wasm compiler on Flint, Emery and Gabbro.
  In unchanged 4.37.0 firmware, app callbacks receive acceleration, taps, health steps and
  touch where present. Emery also returns the injected **raw** heart rate. Complete frames
  match native QEMU exactly on all three profiles. [Hashes and scope](evidence/sensor-service-gate.json).
- Compass input packets do not enable a missing firmware service: all three reference builds
  report `CompassStatusUnavailable`. Health values require activity tracking to be enabled
  through actual preference/BlobDB exchanges; both watch and native oracle enforce this.
- The actual firmware Worker and actual QuickJS Worker exchange and acknowledge an AppMessage
  generated by a phone timer under their shared clock. Withholding a clock acknowledgment
  stops the watch at its boundary. Pause stops both clocks. This does not make real HTTP
  response timing deterministic; use response fixtures for repeatable scenarios.
- A real Linux/Wasm guest runs Python and unmodified Linux ARM GCC 12.2.0, returning a 732-byte
  ARM EABI5 object through the virtual filesystem. [Record and provenance](evidence/linux-build-gate.json).
  Chromium also passes local folder/YAML import, persistence of the 145 MB image across reload,
  actual Linux Python execution, artifact/record downloads and cancellation, with no external
  requests. Full SDK/Waf/PBW builds in this backend, custom font generation, Python 2 and arbitrary
  dependencies still need acceptance coverage. The existing fast compiler remains usable.

## Independent evidence

- All three **shipped Rust/Wasm** profiles match frozen native QEMU frame checkpoints exactly:
  Flint 24,192 presentation bytes (3,360 packed guest bytes), Emery 45,600 bytes and Gabbro
  67,600 bytes. [Core/input frame hashes](evidence/three-profile-oracle.json).
- The new adaptive `examples/platform-watchface` builds on all seven targets using the actual
  Wasm ARM compiler, esbuild Wasm, platform SDK libraries, a raw resource and array message keys.
  [Build hashes](evidence/seven-platform-builds.json). The actual compiler Worker reproduces the
  Flint PBW byte-for-byte, and its packaged QuickJS script turns a weather fixture into the
  correct key-10000 message. [Worker proof](evidence/compiler-worker-platform-demo.json).
- That same example installs and accepts a real key-10000 AppMessage on Flint, Emery and
  Gabbro. Its complete Flint/Gabbro frames also match native QEMU exactly, with battery/time
  and text `23C | 40.71, -74.00` aligned. This comparison injects the message explicitly;
  phone networking is tested separately. [Evidence](evidence/platform-demo-gate.json).
- A real compiled background worker is transferred with PutBytes type 7, launched using
  `app_worker_launch`, and logs `Browser worker running`; the foreground app continues to
  acknowledge messages without CPU/bus faults. [Acceptance](evidence/background-worker-acceptance.json).
- PNG/PBI/resource serialization is compared with independently generated official SDK
  outputs across 31 original image fixtures, including Adam7, transparency, significant-bit
  handling, legal bit depths, platform formats and resource deduplication. Message-key
  fixtures come from the actual SDK allocation function, including named blocks starting at 10000.
- Actual QuickJS tests cover network fixtures, XHR/fetch events, body limits, cancellation,
  configuration, storage and ownership of outstanding AppMessages. Worker tests cover
  replacement/reset races. The published Clay 1.0.4 JS artifact bundles and executes through
  configuration request, returned settings, storage and an outbound AppMessage. The new browser
  contract gate also renders the actual Clay page and saves through the compiled Kotlin interceptor.
- The separate diagnostic continues to match Unicorn 2.1.4 for 228,004 instructions and all
  45,600 framebuffer bytes.

These are defined functional checkpoints, not exhaustive firmware or cycle accuracy. Tests
use Node Worker/Web API harnesses and shipped Wasm. The actual static browser workflow also
passes in Chromium 153.0.8010.12, Firefox 155.0 and Linux WebKit 26.6: unchanged Emery firmware,
PBW installation, sensor input, exact frame comparison and PBF export, with no page errors or
external requests. [Browser record](evidence/browser-workflow.json),
[reproduction](BROWSER_TESTING.md). Actual Edge on Windows, Safari on macOS, assistive technology
and optical comparisons remain unverified.

## Run the optional firmware gate

Provide official matching micro/SPI images and a PBW built for the selected platform:

```sh
PEBBLE_REAL_WORKER=1 \
PEBBLE_PROFILE=qemu_flint \
PEBBLE_FIRMWARE_DIR=/path/to/official/assets \
PEBBLE_PBW=/path/to/flint/watchface.pbw \
node --test tests/worker.integration.test.mjs
```

Use `qemu_emery` or `qemu_gabbro` for the other boards. Files are named
`<profile>_v4.37.0_{micro,spi}_flash.bin`. Set `PEBBLE_FIRMWARE_VERSION=4.36.0` for the verified
older Emery version. The standard gate's sample status message uses key 0; the responsive
example's native rendering evidence separately uses its SDK-assigned key 10000.

`PEBBLE_REFERENCE_FRAME=1` selects the original Emery reference demo's exact frame check;
it requires the deterministic PBW hash recorded in `evidence/firmware-acceptance.json`.
`PEBBLE_TRACE_DIR` saves optional protocol traces. Ordinary tests need neither firmware nor SDK.
[Profile/oracle reproduction](evidence/multiplatform-acceptance.md),
[compiler scope and provenance](BROWSER_COMPILER.md), [phone contract](PHONE.md).

## Remaining requirements

1. Implement current physical Asterix/Obelix/Getafix board families, ROM/bootloader/controller
   dependencies and firmware revisions individually. Older boards are deferred. Sharing app dimensions or platform flags is insufficient.
2. Complete architectural exclusions and instruction/exception/MPU/FPU/security verification.
   Flint currently uses the shared engine with Cortex-M4 identification and board properties;
   it does not yet reject every M33-only instruction. Timing and energy are not calibrated.
3. Complete the Linux SDK/Waf/PBW gate, custom fonts, SVG/vector resources, native package
   libraries, additional SDK versions and remaining app types. Arbitrary GitHub projects are not yet universal.
4. Complete microphone/audio, physical sensor controllers (including raw optical/gyro/light/
   temperature paths where actually present), notifications/timeline, full replay/snapshots,
   and remaining native companion services. Logical Bluetooth packets are supported;
   physical radio behavior and universal browser-to-watch Bluetooth are not.
5. Measure actual watches and complete browser interaction/optical comparisons. No battery
   chemistry, RF or screen-material accuracy is inferred from a successful app or boot test.

The three default 4.37.0 emulator pairs are bundled with source, component and license
records; see [firmware provenance](evidence/default-firmware-provenance.json). Other
firmware and SDK binaries remain local imports. The catalog currently
browses Core Devices PebbleOS releases; it is not a complete historical firmware archive.
Release downloads without browser CORS support use download-and-open, with available
catalog SHA-256 checks verified locally. No proxy or server compiler is substituted.
