# libpebble3 browser spike: findings

Upstream `coredevices/mobileapp` 1.13.0.2, `libpebble3` compiled for `wasmJs` in the
Phone spike workflow. Nothing here ships; the spike measures the gap. Round numbers are
the workflow's commits on this branch.

## Result so far

Every dependency resolves for the browser. Storage, the one deep blocker in round 3,
now has a browser path. No bundle size yet: the browser compile does not finish.

| Round | Change | Browser compile |
|---|---|---|
| 3 | Browser target; non-browser libraries set aside | 850 errors in 67 files, ~80% storage |
| 4–5 | Probe Maven | Room 2.8.x: JVM/native only. Room 3 (`androidx.room3`, stable 3.0.3) and `sqlite-web` 2.7.1: wasmJs and js |
| 6–12 | Storage moved to Room 3 on every target | Room's browser processor: 2 errors. Without it: 103 errors in 20 files, none from renamed Room APIs |

## What the patch does (`patch.mjs`)

Mechanical, applied to a fresh checkout of the tag:

- Room 2 to Room 3: catalog coordinates, Gradle plugin and its `room3` extension, the
  `androidx.room3` package in sources and in blobdbgen's generated code, and
  `TypeConverter(s)` renamed `ColumnTypeConverter(s)`.
- Browser target: `wasmJs` for libpebble3 and blobannotations, Room's processor for the
  browser, the `sqlite-web` driver; bundled SQLite and kmp-io kept off the browser.

A pattern that no longer matches stops the patch instead of passing silently.

## Remaining gaps (round 12)

Room 3 API changes, small:

- `ContactDao` returns a `PagingSource` from a non-suspend function. Room 3 needs the
  paging `DaoReturnTypeConverter` registered and suspend DAO functions off Android.
- `Migration.migrate` is a suspend function in Room 3 (`MIGRATION_39_40`).

Platform gaps, which are code changes rather than renames:

- `runBlocking` (18) and `Dispatchers.IO` (23), with their follow-on errors. The largest
  group is the PebbleKit JS bridge (`js/PKJSInterface.kt`, 27 errors): JavaScript calls
  such as account and watch tokens block for a suspend result. A browser cannot block,
  so the bridge needs asynchronous calls or values prepared in advance. This is the one
  design question the spike has found.
- kmp-io buffers (`ByteBuffer`, `getShortAt`, `BitSet`) in BLE scan records, MTU and the
  protocol runner, ~20 errors.
- Okio `FileSystem.SYSTEM` / `openZip` for PBW and PBZ files, ~6 errors; needs a browser
  file system.
- `BundledSQLiteDriver` in `getRoomDatabase`; the browser uses the `sqlite-web` driver
  through a platform database builder.

## Scope that follows from the purpose

The phone only has to prove watchfaces work with the latest app release, and its state is
thrown away after each session. Storage therefore needs an in-memory SQLite database, not
browser persistence, schema migrations or a data format. The order of work follows what a
watchface developer exercises: installing through the real stack, the PebbleKit JS bridge
and configuration pages, then notifications, weather and timeline as inputs.

## Maintenance

Regex rewrites were the fastest way to measure the gap and are not a product
foundation. Renames can stay automated. Platform changes should be real commits, either
contributed upstream (a Room 3 migration plus a browser target) or kept as a small patch
series rebased on each tag, with browser adapters in a browser-only source set upstream
never edits. The approved versioning rule still applies: a tag the adapters no longer
build is reported, not offered. Running Room 3 while upstream ships Room 2.8.4 is a
storage-library difference from the native app and must be stated as such.
