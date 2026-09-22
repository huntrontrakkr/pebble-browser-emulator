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
| 13–24 | Room 2 kept; browser-only Room 2 shim | Database layer and shim compile; ~99 errors remain, all upstream platform gaps |

## What the patch does (`patch.mjs`, `build.sh`)

Applied to a fresh checkout of the tag; a pattern that no longer matches stops the patch
instead of passing silently.

- Browser target: `wasmJs` for libpebble3 and blobannotations; bundled SQLite and kmp-io
  kept off the browser.
- Storage (default, `PHONE_SPIKE_ROOM=2`): the room2web module, dependency substitution
  for the browser target, libpebble3's in-memory database builder in a browser-only
  source set, and the generated code reused from upstream's own targets.
- `PHONE_SPIKE_ROOM=3`: the rounds 6–12 rewrite to Room 3 on every target.

## Remaining gaps (round 23)

All in upstream's shared code; none in storage:

- `runBlocking` (18) and `Dispatchers.IO` (23), with follow-on errors. kotlinx.coroutines
  has neither in the browser, and shared code cannot see a browser-only stand-in, so
  these need changes to upstream code. The largest group is the PebbleKit JS bridge
  (`js/PKJSInterface.kt`, 27 errors): JavaScript calls such as account and watch tokens
  block for a suspend result. A browser cannot block, so the bridge needs asynchronous
  calls or values prepared in advance. This is the one design question the spike has
  found.
- kmp-io buffers (`ByteBuffer`, `getShortAt`, `BitSet`) in BLE scan records, MTU and the
  protocol runner, ~20 errors.
- Okio `FileSystem.SYSTEM` / `openZip` for PBW and PBZ files, ~6 errors; needs a browser
  file system.

## Room 2 in the browser (rounds 13–24)

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
  target, which uses the same multiplatform runtime (javax's `@Generated` marker removed).

Round 23: no remaining error is in the database layer or the shim. The Room 3 rewrite
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
