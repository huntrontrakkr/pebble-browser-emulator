# libpebble3 browser spike: findings

Upstream `coredevices/mobileapp` 1.13.0.2, `libpebble3` compiled for `wasmJs` in the
Phone spike workflow. Nothing here ships; the spike measures the gap. Round numbers are
the workflow's commits on this branch.

## Result so far

In Chromium, the application's QEMU worker and a libpebble3 phone worker run the whole
flow against the released firmware (round 41). The QEMU worker runs `qemu_emery` 4.37.0,
and the phone worker (`src/app/libpebble.worker.ts`) is upstream's LibPebble. They are
linked by the QEMU worker's `phone-link` port. The page reported these steps:

| After | Step |
|---|---|
| 17.4 s | Firmware booted |
| +0.2 s | Phone worker started (SQLite Wasm, QuickJS and the libpebble3 bundle loaded from URLs) |
| +1.0 s | Connected and negotiated; the watch reports its running app |
| +3.3 s | Clock installed through libpebble3 (BlobDB, AppFetch, PutBytes) and running |
| +65 ms | Clock's settings round trip: its PebbleKit JS sends the AppMessage, the firmware ACKs, Clock's callback logs it |

The firmware and libpebble3 answer every step themselves. Negotiation covers the watch
version (v4.37.0, 9399f56), factory data, the phone's app version (the firmware logs
`plf=0x2`, which is Android), time, the running app, BlobDB version and app order. The
same flow also runs in Node (`e2e.mjs`).

The linked library is 2.57 MB (774 KB gzipped) of Wasm as of round 30. Since round 42,
Preview's Phone tab loads the phone worker in builds that publish the library (6.1 MB
with SQLite Wasm); other builds say it is not included.

| Round | Change | Browser compile |
|---|---|---|
| 3 | Browser target; non-browser libraries set aside | 850 errors in 67 files, ~80% storage |
| 4–5 | Probe Maven | Room 2.8.x: JVM/native only. Room 3 (`androidx.room3`, stable 3.0.3) and `sqlite-web` 2.7.1: wasmJs and js |
| 6–12 | Storage moved to Room 3 on every target | Room's browser processor: 2 errors. Without it: 103 errors in 20 files |
| 13–25 | Room 2 kept; browser-only Room 2 shim | Shim and all generated database code compile; 99 errors in 20 files remain, all upstream platform gaps |
| 26 | Platform `runBlocking` / `Dispatchers.IO` (import-line change) | 31 errors: kmp-io buffers and Okio file access only; the PebbleKit JS package compiles |
| 27 | kmp-io's buffers built for the browser; Okio `SYSTEM` / `openZip` import swap | 1 error: a `kotlinx.datetime.Instant` / `kotlin.time.Instant` mismatch |
| 28 | That file moved to `kotlin.time.Instant` | Resolution complete; ~50 platform declarations missing |
| 29 | Browser platform layer from upstream's desktop layer | 0 errors; production library links |
| 30 | Browser entry point, platform module, serial transport | Links with LibPebble kept: 2.57 MB Wasm, 774 KB gzipped |
| 31 | First run: imports listed | One skiko import (`skikoApi`, from Compose's `ImageBitmap`) |
| 32 | The library's npm dependencies (js-joda, ws) installed | Starts, connects and begins negotiation |
| 33 | Host glue and the QEMU worker's `phone-link`, with v4.37.0 firmware | Negotiation completes; watch connected |
| 34–36 | In-memory kotlinx-io files for the browser; `phoneInstall` | kotlinxioweb builds, links and starts |
| 37 | End-to-end install of Clock | Installed and launched; the check read the wrong status field |
| 38 | `phoneRunningApp` from libpebble3's own state | Clock reported running; PebbleKit JS has no runner |
| 39 | PebbleKit JS runner on QuickJS | Clock's configuration round trip: AppMessage sent, watch ACK reaches Clock's callback |
| 40 | Phone worker; browser run in Chromium | Bundling stopped on `node:module` / `node:net` imports |
| 41 | Node's own modules left external | The whole flow runs in Chromium |
| 42–43 | Published into the site; Phone tab section | Preview detects the build (`coredevices/mobileapp 1.13.0.2`) |
| 44 | XMLHttpRequest over the page's phone network; WebSocket | The pipeline runs; the probe's own base URL was not substituted |
| 45 | Synchronous XHR; watch platforms; Preview driven through its controls | Probe 11/11 in Chromium; libpebble3 installs Clock and JustTheTime on all three profiles; the settings screen was not built |

## What the patch does (`patch.mjs`, `build.sh`)

Applied to a fresh checkout of the tag; a pattern that no longer matches stops the patch
instead of passing silently.

- Browser target: `wasmJs` for libpebble3 and blobannotations; bundled SQLite and kmp-io
  kept off the browser.
- Storage (default, `PHONE_SPIKE_ROOM=2`): the room2web module, dependency substitution
  for the browser target, libpebble3's in-memory database builder in a browser-only
  source set, and the generated code reused from upstream's own targets.
- `PHONE_SPIKE_ROOM=3`: the rounds 6–12 rewrite to Room 3 on every target.

## Browser platform layer (rounds 27–29)

- **kmp-io**: upstream uses only its byte buffers, `BitSet` and byte-array extensions,
  four plain-Kotlin files that `kmpio-web` compiles from kmp-io's released 0.3.0 sources
  (Apache-2.0). kmp-io stays in common code; only the browser target resolves it to
  kmpio-web.
- **Okio**: the two `DiskUtil` files import libpebble3's own `FileSystem.SYSTEM` and
  `openZip`, which delegate to Okio on Android, desktop and iOS. In the browser, files
  live in Okio's in-memory `FakeFileSystem`, and `openZip` extracts an archive into
  another one, inflating with fflate (already shipped by the emulator). Zip64 and
  encrypted entries are rejected.
- **Platform declarations**: upstream's desktop (JVM) layer, 464 lines and mostly stubs,
  is copied from the checkout, so it tracks upstream. The browser supplies its own
  `DataBuffer` (pure Kotlin, `java.nio.ByteBuffer` behaviour), bundled-app lookups
  (none), and paths for the locker cache, temporary files, firmware downloads and
  developer-connection installs.

## Browser entry point (rounds 30–32)

`browser/BrowserPhone.kt` exports `phoneStart`, `phoneAttachSerial`,
`phoneSerialFromWatch`, `phoneConnectWatch` and `phoneStatus`. `phoneStart` does what
`LibPebble.create` does, with two changes made after upstream's bindings load and before
anything reads them. First, settings live in memory: the library's browser default is
`localStorage`, which would persist and does not exist in a worker. Second, a watch at a
socket address is reached through `WatchSerialTransport`, upstream's QEMU transport with
the emulator's serial channel in place of a TCP socket. It keeps the same framing code,
the CommSession-open frame and SPP frames. It skips only Kable's central setup, which is
iOS-only.

- **Platform module**: upstream's Android and iOS modules have this same shape. The phone
  identifies as Android and declares only the shared protocol capabilities. Calendar,
  call log, contacts, music, location and notification listeners report nothing and no
  permission, as an Android phone without those permissions does. Actions fail with
  `Unsupported`. Nothing invents data; each becomes a simulation input behind its own
  gate.
- **Replaced desktop stubs**: the startup path reached four `TODO()`s. The BLE scanner
  finds nothing (the direct link needs no Bluetooth), the time-change broadcast never
  fires, and PebbleKit JS `localStorage` is in memory.
- **No account**: no locker, no firmware-update service, no uploads, and no developer
  token or transcription.
- **Bundle dependencies**: `@js-joda/core` and `ws` (npm, from the distribution's
  `package.json`) and one skiko import. The first run stands in for skiko with a function
  that throws when called, and startup never called it. Before the bundle ships, either
  skiko's runtime ships with it or the browser build leaves out the image paths that use
  it.

Still open: `LazyLock` needs review. Synchronous XHR is resolved in round 45. File access is resolved in
rounds 34–36 and PebbleKit JS in round 39. The page host must publish `globalThis.sqlite3` and
`globalThis.fflate` before `phoneStart`.

## Host glue (round 33)

- **QEMU worker `phone-link`** takes a MessagePort. While it is attached, UART port 1
  (Pebble Protocol) goes raw to the port, and bytes from the port join the same FIFO
  writer as hardware controls. The built-in transport neither reads the port nor
  writes to it, and its commands (install, AppMessage, packets, weather, battery,
  connection, demo data) are refused. The watch has one phone at a time, and
  startup checkpoints are not taken while linked.
- **`src/app/libpebble-host.ts`** publishes SQLite Wasm and fflate, checks the module's
  exports, starts the phone and carries bytes both ways without reading them. It
  counts bytes that no connection read as dropped instead of discarding them silently.
  Unit tests use a stand-in phone; `e2e.mjs` runs the real one.
- **Pacing**: the run uses Preview's real-time pacing. libpebble3's timeouts are
  wall-clock, and a worker running flat out in Node services messages only every few
  seconds.
- **Hardware revision**: `qemu_emery` 4.37.0 reports hardware revision 245, which
  libpebble3 1.13.0.2 does not list, so the platform reads as unknown. libpebble3 then
  uses its own `WatchConfig.unknownWatchTypePlatform`, which defaults to Emery: right
  for `qemu_emery`. For `qemu_flint` and `qemu_gabbro`, the host sets that upstream
  option per profile (round 45). No patch is needed.

## The phone as a browser worker (rounds 40–41)

- **`src/app/libpebble.worker.ts`** takes `init` with where the libpebble3 build, SQLite's
  WebAssembly build and the QuickJS binary are served. It also takes `link` (the QEMU
  worker's `phone-link` port), `install`, `configure`, `configuration-closed` and
  `status`. It reports `running-app` changes and apps' PebbleKit JS console output.
  SQLite and the library come from URLs, so the application's build does not bundle
  them until the phone ships.
- **Browser bundle** (`browser/bundle.mjs`): esbuild, as the application's build uses,
  builds the QEMU and phone workers and the harness page. It also turns the Kotlin
  distribution into one browser module. Its npm imports (js-joda) are bundled. `ws`
  (Node's WebSocket; ktor uses the page's in a browser) is an empty module, and skiko
  is throwing stand-ins. Node's own modules (`node:module`, `node:net`), which the
  runtime imports only under Node, stay as imports, so a browser reaching one fails
  there.
- **Harness** (`browser/harness.mjs`, `browser/run.mjs`): boots the firmware, starts
  and links the phone, installs Clock and runs its settings round trip. Chromium runs it
  through Playwright in the spike workflow.

## Network for apps' PebbleKit JS (rounds 44–45)

- **Same network as the built-in phone.** Upstream's own `XMLHttpRequest` and
  `XMLHTTPRequestManager` run unchanged. Only the transport under ktor changes:
  `HostHttpEngine` hands each request to the page's phone network
  (`src/app/libpebble-network.ts`). That network uses the built-in phone's layer
  (`phone-network.ts`, `phone-websocket.ts`), so the session's **Network access**
  setting, limits, CORS and optional relay apply to both phones. It is off by default,
  and "test responses" apply to the built-in phone only. Nothing is answered locally:
  a request the browser refuses reaches the app as an `error` event. Preview reads the
  setting on **Connect**.
- **WebSocket**: apps get upstream's iOS `WebSocket.js`, unchanged. Under it,
  `BrowserWebSocketManager` ports upstream's iOS `WebSocketManager`, which delivers the
  same `_onOpen`, `_onMessage`, `_onError` and `_onClose` calls, from the phone's
  coroutines.
- **Synchronous XHR**: upstream calls `runBlocking`. The browser version counts blocking
  calls. Inside one, the engine asks the host to block on the worker's own synchronous
  request, with the same setting, limits, CORS and relay, and ktor runs inline, so
  `send()` returns after the network answers. As on iOS, upstream's manager then
  delivers the response as events just after `send()` returns.
- **Base64**: upstream's binary paths call `Uint8Array.fromBase64` and `toBase64`
  (ECMAScript 2026), which this QuickJS release lacks. The engine installs standard
  versions (`BASE64_BUILTINS`, unit-tested) only where they are missing.
- **Probe** (`browser/network-probe.js`, `probe-server.mjs`): the browser run installs
  Clock's watch binary with a test PebbleKit JS in place of Clock's own, with the
  network on. The probe calls the run's server through another origin (`localhost`
  instead of `127.0.0.1`), so CORS applies. In Chromium, **11 of 11** checks passed:
  text with a request header, an exposed response header, a UTF-8 POST body, `json`,
  256 exact bytes as `arraybuffer`, a 404 delivered as a response, refusal of a host
  without CORS, abort, synchronous XHR, and a WebSocket with a subprotocol, text and
  binary both ways and a 4001 close. A refused upgrade was reported as `error` then
  `close` 1006. The probe then sent its summary to the watch.
- **Not covered**: binary request bodies. Upstream's bridge passes text, and a typed
  array reaches its manager as a JSON object, which it drops. The `timeout` property
  (unimplemented upstream), and HTTP interception, also absent on iOS.

## Watch platforms (round 45)

The QEMU firmware reports a hardware revision that libpebble3 1.13.0.2 does not list.
`phoneSetUnknownWatchPlatform` sets upstream's own `WatchConfig.unknownWatchTypePlatform`
to the emulated profile ('emery', 'flint', 'gabbro'), and Preview passes its profile on
**Connect**. In CI, libpebble3 installed Clock and the JustTheTime store watchface on
`qemu_emery`, `qemu_flint` and `qemu_gabbro`, and each watch reported the app running.

## In Preview (rounds 42–43)

- **Publishing** (`publish.mjs`): writes `public/libpebble3/`, which holds the bundled
  library and its Wasm, SQLite's WebAssembly build, upstream's licence, a `NOTICE.md` with
  the upstream, Room and kotlinx-io versions, and a `manifest.json` naming the release
  tag and commit. That is 6.1 MB. The directory is ignored by git. A build without it
  still writes `manifest.json` (`{"included": false}`, from
  `scripts/write-upstream-phone-manifest.mjs`), so Preview never requests a missing file.
- **Phone tab** (`src/app/upstream-phone.ts`, "Upstream phone app (experimental)"): reads
  the manifest and shows the build or "Not included in this build". **Connect** takes the
  built-in phone off the watch link and hands the QEMU worker's `phone-link` port to the
  phone worker. After that:
  - **Install … through it** sideloads the last opened package through libpebble3.
  - **App configuration** opens the page that the running app's PebbleKit JS returns, in
    the same sandboxed settings frame as the built-in phone. The page's return data goes
    back to the app as `pebblejs://close#…`; a cancellation delivers nothing, as upstream's
    app does.
  - **Disconnect**, a reset or a new session hands the link back.

  While it is connected, the built-in install path is refused, so one watch never has
  two phones.
- **Check** (`browser/preview-check.mjs`, CI): publishes, builds the site, serves
  `dist/client`, and opens the developer tools' Phone tab. It then reads the section:
  `{"status":"Not connected","build":"coredevices/mobileapp 1.13.0.2"}`. The worker
  chunk is 41 kB, and the library loads only on **Connect**. The main site build does
  not publish libpebble3. Whether it should (6.1 MB plus a ~5 minute upstream
  compile in CI) is still undecided. Connect, install and configuration from Preview's
  own buttons are exercised by the harness flow, not yet through the Preview UI.

## PebbleKit JS (round 39)

Upstream runs PebbleKit JS in a WebView on Android and in a bare JavaScriptCore engine on
iOS. The browser follows iOS: `BrowserJsRunner` is its runner with QuickJS in place of
JavaScriptCore.

- **Engine**: `src/app/libpebble-pkjs.ts` gives each running app its own QuickJS
  runtime. It is isolated from the page and from other apps, with memory and stack
  limits and a deadline per evaluation, so runaway app code is interrupted. It is the
  QuickJS build the emulator's phone worker already ships.
- **Upstream's code**: the runner loads upstream's standard library (base64,
  XMLHttpRequest), timer shim, `startup.js` and the app's JS. Upstream's interfaces sit
  behind one native dispatcher, as on iOS, and calls cross as JSON. The Pebble, private
  and geolocation dispatch tables are upstream's iOS files, taken unchanged from the
  checkout.
- **Browser versions**: timers run on the phone's coroutines, `localStorage` uses the
  session's in-memory settings, and `sendAppMessageString` does not block. Upstream
  blocks until the watch's transaction ID is assigned, which a browser thread cannot
  do. The browser version returns a local ID at once and later delivers the watch's own
  ACK or NACK under it; `startup.js` uses the ID only to match them.
- **Configuration**: `phoneRequestConfiguration` and `phoneConfigurationClosed` do what
  the phone app's settings button and `pebblejs://close` deep-link handler do.
- **Not yet**: intercepted HTTP responses (also unsupported on iOS), and reporting
  unhandled promise rejections, which QuickJS does not surface. XMLHttpRequest and
  WebSocket arrived in rounds 44–45.

## Files in the browser (rounds 34–36)

kotlinx-io's wasm build reaches files, paths and the OS only through Node's `fs`, `path`
and `os` modules, imported only under Node. In a page, every `kotlinx.io.files` call
fails, including constructing a `Path`. Upstream uses it in 20 files, among them the
public `sideloadApp(Path)`, the locker cache and firmware updates.

- **kotlinxio-web** compiles the pinned kotlinx-io release's own sources (0.9.1,
  Apache-2.0). An in-memory POSIX file tree replaces the Node backend, with the released
  backend's errors, directory creation and listing. It builds with kotlinx-io's own
  language settings and keeps the published module name, so libraries compiled against
  kotlinx-io (ktor among them) link unchanged. Only the browser target resolves
  kotlinx-io-core to it; `patch.mjs` refuses sources whose version differs from
  upstream's pin.
- **Okio**: the browser `FileSystem.SYSTEM` is now a view of the same tree, so the zip
  reader, PBW reader and locker cache share one set of files. Random access and symlinks
  report themselves unsupported.
- The browser phone is an Android phone, so paths and line endings are POSIX whatever
  the host OS.

## Blocking calls and the PebbleKit JS bridge (round 26)

Shared code blocks in 12 places with `runBlocking`: the PebbleKit JS bridge (tokens,
notifications, pins, URL opens, the AppMessage transaction ID), known-watch and
vibe-pattern database reads, a synchronous-XHR path and `LazyLock`'s wait loop. It also
names `Dispatchers.IO`, which the browser lacks.

- Shared code imports libpebble3's own `runBlocking` and `Dispatchers.IO`
  (`util/PlatformBlocking.kt`): an import-line change in 14 files. Android, desktop and
  iOS delegate to kotlinx.coroutines unchanged. In the browser, `runBlocking` runs its
  block immediately and requires it to finish without suspending; a block that would
  wait fails instead of deadlocking. `Dispatchers.IO` is `Unconfined` there, so the
  in-memory database, whose SQLite runs synchronously in the same thread, completes
  inline.
- The emulator already runs PebbleKit JS in QuickJS's synchronous build inside the
  phone worker. With the Kotlin phone in that worker too, the app's calls into upstream's
  `PKJSInterface` are same-thread calls. Tokens (database reads), notifications and pins
  (database writes; watch sync is separate) and URL opens then work as upstream wrote
  them. Only `sendAppMessageString` waits on other work (the AppMessage service assigns
  the transaction ID), so the browser overrides it: it returns a local ID and maps the
  ACK/NACK back to it, which is all `startup.js` uses the ID for. Synchronous XHR and
  `LazyLock` need the same review before they run in the browser.

Compile-level only: none of this has run in a browser yet.

## Room 2 in the browser (rounds 13–25)

Upstream keeps the Room 2.8.4 it ships, unchanged, on Android, desktop and iOS. Only the
browser build differs, and its database code compiles as released:

- **room2-web** compiles Room 2.8.4's released sources (room-common, room-runtime,
  room-paging) and androidx.sqlite 2.6.2's, the blocking API Room 2.8.4 was built
  against (2.7 moved it out of common code). Room's shared JVM/native runtime keeps its
  own shared source set. Browser versions replace Room's ten native platform files:
  single-thread atomics, thread-local and locks, a no-op file lock, and near-verbatim
  copies of Room, the database-constructor lookup and SQLiteException.
- **BundledSQLiteDriver** for the browser runs the official SQLite WebAssembly build
  in memory, synchronously on the calling thread, under Room's blocking API. It is the
  driver upstream already names. Nothing reaches browser storage.
- **Dependency substitution**: upstream's dependencies are untouched; only the browser
  target's configurations resolve Room and androidx.sqlite to room2web.
- **Generated code from upstream's own targets** (build.sh): Kotlin's common-code pass
  only sees libraries that support every target, so with the browser target it cannot
  see Room 2 and blobdbgen skips six entities. Room 2's processor, run on the browser
  target, reads Kotlin/Wasm's internal `Any._hashCode` as a column of every entity. Both
  passes therefore run once on upstream's Android and desktop targets, and the browser
  build reuses the ten blobdbgen entities and Room's 54 generated files for the desktop
  target, which uses the same multiplatform runtime (javax's `@Generated` marker and its
  import removed).

Round 25: no remaining error is in the shim or the generated database code; the two in
`Database.kt` are its `Dispatchers.IO` references. The Room 3 rewrite
(rounds 6–12) remains available with `PHONE_SPIKE_ROOM=3` for comparison.

## Scope that follows from the purpose

The phone only has to prove watchfaces work with the latest app release, and its state is
thrown away after each session. Storage therefore needs an in-memory SQLite database, not
browser persistence, schema migrations or a data format. The order of work follows what a
watchface developer exercises: installing through the real stack, the PebbleKit JS bridge
and configuration pages, then notifications, weather and timeline as inputs.

## Maintenance

Regex rewrites were the fastest way to measure the gap and are not a product
foundation. With the Room 2 shim, storage needs no upstream edits: room2web is rebuilt
from the sources jars of whatever Room version upstream pins, and the browser runs that
same version. The remaining platform changes should be real commits, either contributed
upstream (a browser target) or kept as a small patch series rebased on each tag, with
browser adapters in a browser-only source set upstream never edits. The approved
versioning rule still applies: a tag the adapters no longer build is reported, not
offered.
