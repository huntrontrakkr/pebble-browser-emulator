# Generic Flint/Gabbro implementation and proof

Original adapter extension against root commit `1b87369`; no guest firmware patches and no copied QEMU implementation. The QEMU source was used to identify the public virtual hardware contract.

## Integration

Apply `generic-profiles.patch` at repo root. It adds profile configuration and five tests; changes qemu-emery lib/peripherals and the vendored PPB CPUID register. Keep crate/path naming unchanged for compatibility. The vendor default remains `0x411fd210`; only explicitly selected Pebble profiles override it with the reference QEMU identity.

ABI retains `spike_boot(code_len, flash_len)` as Emery and adds `spike_boot_profile(profile, code_len, flash_len)` with IDs 1 Flint,2 Emery,3 Gabbro. Unknown IDs and out-of-profile initial MSP fail validation. `spike_restart()` preserves the profile. Presentation exports: `spike_profile`, `spike_frame_width`, `spike_frame_height`, `spike_frame_len`, `spike_frame_format` (8), `spike_frame_stride` (width), `spike_frame_round`. Raw debug exports: `spike_guest_frame`, `_len`, `_stride`, `_format`.

All earlier isolated qemu crate tests passed plus five new tests for profile register maps/memory boundaries/CPUID, monochrome bit/row layout and completed-frame latching, Gabbro full-frame preservation, profile queries/restart, and malformed profile/stack. Clippy all targets with warnings denied passed. Wasm32 release compiled.

## End-to-end fixtures

Unchanged official full OS release4.37.0 micro+SPI assets from [Core Devices release](https://github.com/coredevices/PebbleOS/releases/tag/v4.37.0), SHA256 verified against published asset digests:

| Profile | micro SHA256                                                       | SPI SHA256                                                         |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Flint   | `d4c9094ddc750393e61cdab1fbdb5cd8ace5eeb4a149f76c9ee780c10e0bd1ee` | `ff32ba50ba869bc02130910a4f399437e7b2a2708d43f2eb2f0739edcfd7f315` |
| Gabbro  | `c58e3670cd7cd0a80788761d80274c3684a59e17fef28c3c3706280edae1cd2c` | `0e25a15062465a33470be6136c85a9ac39429c8277db30b28f34a02db57273ed` |

Both profiles reached the actual firmware UART Ready message without bus/CFSR/HFSR faults. Flint took192M scheduler steps, Gabbro189M at1M polling granularity; these are emulator scheduler counts, not measured physical CPU cycles. Emery boot regression passed too.

The source demo was compiled using the actual browser Wasm compiler and SDK4.33.1 platform headers/libpebble. PBW SHA256s: Flint `b7f7fe15f4d7c172b2721bc53178e38b5e129fc770282110574715a86fd2c0f7`, Gabbro `49447ce685057938ea16574c4b4f08515add6850399ba801a4d832e7c7d2b9b3`. UUID `7c5f2e40-63c4-4d17-9cd6-8a85f0ced130`.

Both the Rust Wasm candidate and official native QEMU `v10.1.5-pebble17` received identical UART protocol operations: Bluetooth connect; BlobDB/AppFetch/PutBytesCRC install; real app-running event; time1789545600; battery57/discharging; AppMessage key0 `GPS 40.71`. Both guests acknowledged AppMessage `ff01`. Native QEMU then paused and exported raw guest display memory. Rust exported completed presentation and raw guest memory after settled updates.

| Profile | Guest bytes compared | Differing guest bytes | Canonical pixels compared | Differing pixels | Canonical frame SHA256                                             |
| ------- | -------------------: | --------------------: | ------------------------: | ---------------: | ------------------------------------------------------------------ |
| Flint   |                 3360 |                     0 |                     24192 |                0 | `2a0728860441548b52b9a4c74681e7379bb0de01987dffbd4f6806a42cf0f04e` |
| Gabbro  |                67600 |                     0 |                     67600 |                0 | `70cb02c8ad3461308ec1a0ae3227fd50f3c5cc9ca7234505553622e3e8ec804d` |

Flint packed-guest SHA256 is `3d4cc3ab16b1094f0e1cd5c8295d9cc81efa4418ca89b4c879ad84fe96fe2d93`. Exact comparison avoids native backlight dimming by comparing raw pixels. Native Gabbro applies the round mask when presenting; no pixels were omitted from the raw comparison.

The then-current demo hardcodes a GPS text layer below Flint's168px display. The real ACK proves delivery but the GPS string is clipped on **both** implementations. Flint visibly shows08:00,battery57,Connected; Gabbro additionally showsGPS40.71. This fixture proves matching execution, including the demo's own layout limitation. New responsive demo builds need their own new fixture hashes.

## Artifact/reproduction layout

`boot.mjs` loads the Wasm and each release pair and records UART Ready/CPU diagnostics.
`oracle.py` starts the official executable on separate Flint/Gabbro machines with `snapshot=on` SPI disks (downloaded originals stay unchanged).
`acceptance.mjs <flint|gabbro> <wasm|native>` drives identical real installer and phone operations.
`compare.py` compares every byte and creates PNG evidence without image dependencies.
`evidence/` contains boot JSON, per-runtime acceptance JSON, UART protocol traces, raw display bytes, PNGs, native PPMs, and per-profile comparison JSON. Firmware/SDK assets are external local fixtures, never committed or bundled with the site.

Current reproducible local work directory: `/tmp/pebble-multiplatform-spike`. The harnesses record explicit input paths and the native launch arguments in `evidence/oracle-*/process.json`. For clean independent use, set the environment overrides documented by each portable harness or update these fixture paths; never copy downloaded `assets/`, vendored build outputs, or reference GPL implementation files into an evidence-only commit.

### Portable harness overrides

`PROFILE_WORKDIR` selects the fixture/output directory (default directory containing the scripts). `PEBBLE_WASM` selects the built core. `PEBBLE_TRANSPORT_MODULE` selects the JS/TS module exporting `PebbleTransport` (a compiled `.mjs`, or use a Node version supporting type stripping for the source `.ts`). `PEBBLE_PBW_DIR` points to a directory containing `flint/watchface.pbw` and `gabbro/watchface.pbw`; extract those unchanged PBWs into `PROFILE_WORKDIR/apps/<platform>/` first. `PEBBLE_QEMU_DIR` selects the extracted official native QEMU distribution, with executable `bin/qemu-pebble` and optional local dependencies under `deps/usr/lib/x86_64-linux-gnu`.

Place official verified release pairs under `PROFILE_WORKDIR/assets/`. Build the candidate/core, run `boot.mjs flint` and `boot.mjs gabbro`, then `oracle.py`. Wait until each native `evidence/oracle-<platform>/console.bin` contains `Ready for communication.`. Run `acceptance.mjs flint wasm`, `acceptance.mjs flint native`, and the corresponding Gabbro commands, then `compare.py`. Native UART TCP ports are17781/17782; monitor sockets are inside each oracle evidence directory. Each native process is stopped after capture and its PID is recorded in `process.json`; terminate those processes when finished. UART traces include both directions and all install/launch/AppMessage ACKs.

The capture harness does not need to patch firmware, use a backend, or alter downloaded SPI originals. Native QEMU is only the independent development-time oracle; the deployed emulator uses the Rust Wasm path.

## Final integrated core confirmation

Root deployed Wasm SHA256 `6b08d47b8edc9f94d331e0f02448ca5c30f113e81d8168771685568048bea07a` independently reproduced all three frozen oracle hashes, including existing Emery `ff5e62857b3d6e14c4a2d7cbc57a57e64f3f89471c483f09c599c4d3ea3b470b`. See `evidence/root-three-profile-oracle.json`.

A separate compiler worker fixture PBW `f8a9926a01faf7be3a9cf63d0bc0833bbac2982abf2bf16e0d20683b652800ef` contains a1503B foreground app that calls `app_worker_launch()` and a294B worker. The existing installer transferred the worker with PutBytes type7; actual guest execution logged `Browser worker running` on UART2, then the foreground app acknowledged the GPS AppMessage. No bus/CFSR/HFSR faults. `evidence/worker-execution-evidence.json` records input hashes, log offset and console hash. Full worker console/protocol trace live at `/tmp/pebble-worker-launch-check/evidence/wasm-emery/`. This proves execution of this fixture, not universal worker compatibility.
