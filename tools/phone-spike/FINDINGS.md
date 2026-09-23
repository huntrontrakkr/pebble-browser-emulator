# libpebble3 browser spike: findings

Upstream `coredevices/mobileapp` 1.13.0.2, `libpebble3` compiled for `wasmJs` in the
Phone spike workflow. Nothing here ships; the spike measures the gap. Round numbers are
the workflow's commits on this branch.

## Result so far

Every dependency resolves for the browser, and storage, the one deep blocker in round 3,
now compiles for the browser with the Room 2 upstream ships. What remains is upstream's
own platform code. No bundle size yet: the browser compile does not finish.

| Round | Change | Browser compile |
|---|---|---|
| 3 | Browser target; non-browser libraries set aside | 850 errors in 67 files, ~80% storage |
| 4–5 | Probe Maven | Room 2.8.x: JVM/native only. Room 3 (`androidx.room3`, stable 3.0.3) and `sqlite-web` 2.7.1: wasmJs and js |
| 6–12 | Storage moved to Room 3 on every target | Room's browser processor: 2 errors. Without it: 103 errors in 20 files |
| 13–25 | Room 2 kept; browser-only Room 2 shim | Shim and all generated database code compile; 99 errors in 20 files remain, all upstream platform gaps |
| 26 | Platform `runBlocking` / `Dispatchers.IO` (import-line change) | 31 errors: kmp-io buffers and Okio file access only; the PebbleKit JS package compiles |

## What the patch does (`patch.mjs`, `build.sh`)

Applied to a fresh checkout of the tag; a pattern that no longer matches stops the patch
instead of passing silently.

- Browser target: `wasmJs` for libpebble3 and blobannotations; bundled SQLite and kmp-io
  kept off the browser.
- Storage (default, `PHONE_SPIKE_ROOM=2`): the room2web module, dependency substitution
  for the browser target, libpebble3's in-memory database builder in a browser-only
  source set, and the generated code reused from upstream's own targets.
- `PHONE_SPIKE_ROOM=3`: the rounds 6–12 rewrite to Room 3 on every target.

## Remaining gaps (round 26: 31 errors)

- kmp-io buffers (`ByteBuffer`, `getShortAt`, `BitSet`) in BLE scan records, MTU, pairing
  and the protocol runner, ~25 errors.
- Okio `FileSystem.SYSTEM` / `openZip` for PBW and PBZ files, 6 errors; needs a browser
  file system.

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
