# Compatibility and verification

The scope is the full Pebble watch family. Compilation and firmware execution have separate
compatibility gates: all seven SDK platforms build, while three generic emulator boards run
firmware. Physical-watch firmware and legacy board emulation are still incomplete.
See the [product and board matrix](PRODUCT_MATRIX.md) for every model, including the distinct
2016 and current Pebble Time 2 generations.

| Capability                 | Verified scope                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firmware execution         | Unchanged official `qemu_flint`, `qemu_emery`, `qemu_gabbro` PebbleOS 4.37.0; Emery 4.36.0 also passes the installation/input workflow.                 |
| Physical and older watches | Firmware package inspection; physical Asterix/Obelix/Getafix and legacy Tintin/Snowy/Spalding/Silk/Robert execution remain unimplemented.               |
| GitHub source              | Public repositories, commit-pinned downloads, branches/subfolders, local ZIP; unsupported build behavior reports an error.                              |
| Native C builds            | SDK 4.33.1 headers/libraries/defines/limits for Aplite, Basalt, Chalk, Diorite, Emery, Flint and Gabbro; modern and legacy SDK 3 metadata.              |
| Resources                  | PNG/PBI/bitmap/raw resources, selected platform variants, aliases, generated IDs, resource packs and menu icons. Custom font/SVG generation is pending. |
| JavaScript builds          | Local CommonJS/ES modules/JSON, SDK message keys, integrity-checked npm v2/v3 lockfiles, published Pebble JS `dist.zip` packages.                       |
| Installation               | Actual BlobDB/AppFetch/PutBytes transfers, CRC commits, native app-running events, main binary/resources/background worker.                             |
| Background workers         | Compiled/packaged worker matches SDK metadata; firmware starts it and emits its expected log.                                                           |
| Virtual phone              | Isolated QuickJS, geolocation, time/timers, app storage, actual AppMessage ACK/NACK, watch context, XHR/fetch test responses or browser CORS.           |
| Configuration              | showConfiguration/openURL/webviewclosed events with correlated manual return. Embedded WebView/automatic return navigation is pending.                  |
| Inputs and inspection      | Buttons, battery percentage/charging, clock, logical connection and phone coordinates; CPU registers, packets/filter/export/injection, HTTP events.     |
| Display                    | 144×168 monochrome, 200×228 color, 260×260 round color; committed guest frames; exact color conversion. Reflective optics remain an approximation.      |
| 3D model                   | Official current Time 2 geometry with live screen. Other cases are not substituted or represented as verified models.                                   |
| State                      | Watch restart preserves modified SPI flash and RTC. Full firmware/phone snapshots and deterministic replay remain pending.                              |

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
  configuration request, manual returned settings, storage and an outbound AppMessage.
- The separate diagnostic continues to match Unicorn 2.1.4 for 228,004 instructions and all
  45,600 framebuffer bytes.

These are defined functional checkpoints, not exhaustive firmware or cycle accuracy. Tests
use Node Worker/Web API harnesses and shipped Wasm. Browser visual, accessibility and
Chrome/Edge/Firefox/Safari interaction verification have not been completed.

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

1. Implement legacy and physical board families, ROM/bootloader/controller dependencies and
   firmware revisions individually. Sharing app dimensions or platform flags is insufficient.
2. Complete architectural exclusions and instruction/exception/MPU/FPU/security verification.
   Flint currently uses the shared engine with Cortex-M4 identification and board properties;
   it does not yet reject every M33-only instruction. Timing and energy are not calibrated.
3. Add custom fonts, SVG/vector resources, native package libraries, additional SDK versions,
   custom build recipes and remaining app types. Arbitrary GitHub projects are not yet universal.
4. Implement touch/motion/health/audio/haptics scenarios, notifications/timeline services,
   replay/snapshots, and embedded configuration pages. Logical Bluetooth packets are supported;
   physical radio behavior and universal browser-to-watch Bluetooth are not.
5. Measure actual watches and complete browser interaction/optical comparisons. No battery
   chemistry, RF or screen-material accuracy is inferred from a successful app or boot test.

Official firmware/SDK binaries are local imports, not redistributed. The catalog currently
browses Core Devices PebbleOS releases; it is not a complete historical firmware archive.
Release downloads without browser CORS support use download-and-open, with available
catalog SHA-256 checks verified locally. No proxy or server compiler is substituted.
