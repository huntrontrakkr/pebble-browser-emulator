# Pebble Browser Emulator — approved roadmap

## Goal and agreed decisions

A public browser-only Pebble development environment, Angular interface, actual Rust/Wasm
hardware core, functional virtual phone, packet inspection, and local browser compilation.
Current priority: current Pebble Time 2, Pebble 2 Duo and Pebble Round 2. Older watches are
explicitly deferred while their platform/board abstractions remain separate. Both stock
physical firmware and emulator releases remain required. Validate fidelity progressively
against independent references and physical watches. A full browser build sandbox for custom
scripts is required; large downloads and slower builds are accepted. Companion phone services
are required; Android OS/APK emulation is outside this plan. Desktop browsers come first.

The public project is `huntrontrakkr/pebble-browser-emulator`. Host only static assets.
CI may build the website/toolchains but must never compile visitors' projects remotely.

## 1. Rust firmware boot — IN PROGRESS

- [x] Initialize Git, Angular, Rust workspace, versioned Worker/Wasm boundary, and tests.
- [x] Run an actual Thumb diagnostic and inspect its framebuffer/registers.
- [x] Pin unchanged qemu_emery 4.37.0 / 4.36.0 firmware and an independent native QEMU reference.
- [ ] Implement required Armv8-M instructions, exceptions, NVIC, privilege, MPU, stack
      limits, and FPU. Compare against independent execution, not only internal unit tests.
- [x] Implement the generic memory map, UART, flash, virtual timers, RTC, buttons, and committed display updates.
- [ ] Validate remaining peripherals and architectural edge cases; calibrate timing.
- [x] Implement distinct Flint/Emery/Gabbro generic board profiles and verify all display bytes against native QEMU.
- [ ] **Deferred:** implement legacy Tintin/Snowy/Spalding/Silk/Robert boards and establish firmware gates for each.
- [ ] Extend matching to long-running interactions, additional apps, and firmware revisions.

Exit: real qemu_emery firmware boots in the Rust browser core. Keep this explicitly labeled
emulator firmware; it does not establish production Time 2 compatibility.

## 2. Public repository to running watchface

- [x] GitHub REST tree + raw content import, pinned to a commit, and local ZIP import.
- [x] Local folder import.
- [x] Standard package.json native profiles for all seven SDK platforms; reject unsupported custom build scripts.
- [x] Legacy SDK 3 appinfo.json layouts.
- [x] Versioned `.pebble-browser.yml` for isolated Linux/Wasm builds.
- [x] Run real Python and Linux ARM GCC inside a browser-compatible WASI VM; bound memory/files, cancel the Worker and return artifacts.
- [ ] Complete full SDK/Waf/PBW, custom font, C++/assembly, native dependency and legacy build acceptance in the Linux backend.
- [x] Pinned ARM Clang/LLD Wasm, local SDK 4.33.1 subset, exact app metadata/relocations,
      empty resource pack, system fonts, single-file PKJS, and real PBW packaging.
- [x] PNG/PBI/raw resources, aliases and platform variants, JS module bundling, locked JS dependencies.
- [x] Compile, package, install and execute background workers.
- [ ] Custom FreeType fonts, SVG/vector resources, native C packages and library resources.
- [x] Honor target declarations and supported npm lockfiles; never substitute another platform library.
- [x] Adaptive seven-platform demo with raw resource, system fonts, battery/connection, JS modules, location/weather and AppMessage.
- [ ] Custom-font and embedded configuration-page demo.
- [x] Install and reinstall via real BlobDB/AppFetch/PutBytes and retain ELF build output.
- [x] Cache source/SDK locally in IndexedDB and verified toolchain assets in Cache Storage.
- [ ] Verify offline rebuild and offline application reload.

Exit: a fresh browser imports the public demo, compiles a PBW locally, installs it through
the phone protocol, and runs it in firmware. No application backend or proxy.

## 3. Virtual phone and inspection

Implemented: isolated QuickJS, app storage, virtual timers, geolocation, actual AppMessage
ACK/NACK, packet capture/filter/export, and manual packet injection. Full service coverage
and reproducible sessions remain open.

- [ ] Pairing/connection lifecycle, transfers/checksums/retries, app services, notifications,
      settings, time, storage, location, timeline/BlobDB, and isolated PebbleKit JS execution.
- [ ] Raw/decoded packet capture with layer/direction/virtual time; filters, breakpoints,
      fault injection, export/import, and deterministic replay.
- [x] Inject battery/charging, RTC, buttons, logical Bluetooth connection, and phone location.
- [x] Deterministic accelerometer/tap/touch/health inputs, health settings, raw HR, seeded scenarios and CSV; compare app output against native QEMU.
- [x] Inspect actual vibration output; retain explicit unavailable compass behavior.
- [x] Couple phone timers to acknowledged watch-clock quanta and pause both.
- [ ] Complete consumption, physical sensor controllers, microphone/audio, and hardware-controlled optics.
- [x] CORS-permitted text/JSON XHR/fetch and deterministic response fixtures.
- [x] Configuration request/return events, explicit metadata and test identities.
- [ ] Embedded configuration WebView, automatic return interception and network replay.
- [ ] Versioned sessions/snapshots including clocks, randomness, and all external inputs.

Exit: reproducible app/configuration/notification/sensor/low-battery/disconnect scenarios.
Separate modeled analog behavior from verified logical behavior.

## 4. Physical-watch fidelity across the family

- [ ] Implement Asterix/nRF52840 and legacy STM32 board families, preserving model/revision distinctions.
- [ ] Implement Obelix/Getafix SiFli memory/CPU, reset/clocks, XIP/flash, DMA, IRQ, timers, RTC,
      PMIC, JDI display, touch, sensors, audio, and haptics.
- [ ] Execute byte-identical production-target payload from an explicitly documented
      post-bootloader state. Then implement bootloader/slots/recovery/watchdog/update behavior.
- [ ] Validate silicon ROM dependencies and implement verified cold-boot behavior.
- [ ] Model HCPU/LCPU/controller interactions, then actual LCPU execution where dependencies
      and their usage terms are established.
- [x] Add raw/PBF frame capture, byte/hash comparison, difference display and report export.
- [x] Verify all three generic sensor-test frames against native QEMU.
- [ ] Compare selected firmware revisions with the owner's Time 2 and publish evidence.

Exit: each firmware/board combination passes its documented hardware comparisons. Unknown
firmware is not implicitly supported. Track vendor component constraints; upload alone is
not evidence that usage/redistribution terms are satisfied.

## 5. Release, speed, and physical connections

Implemented: clean utility interface, light/dark themes, exact pixels, adjustable reflective
approximation, and rotatable official Time 2 CAD with the live screen.

- [x] Public static release of the first useful firmware/app workflow.
- [x] Preview workspace, prepared Clock PBWs, one-time cached firmware setup, and commit-pinned GitHub preview links.
- [x] Lazy developer panels, bounded screen updates, paced previews and reduced firmware startup allocations.
- [ ] A redistributable default firmware image for zero-setup public previews; actual phone benchmarks and CPU throughput optimization.
- [x] Chromium/Firefox/Linux WebKit sensor workflow, exact frame export and local-request audit.
- [ ] Actual desktop Chrome/Edge/Firefox/Safari release matrix, accessibility, offline reload
      and full build workflows; static deployment portability.
- [ ] Browser-to-real-watch adapters for measured browser/firmware combinations.
- [ ] Profile slow paths; verify block caching/Wasm translation against the interpreter.

Do not equate exact guest behavior with physical RF/chemistry replication. Classify each
capability as verified, modeled, unverified, or unsupported. Full firmware/repository breadth
is a compatibility program, not an unconditional claim.
