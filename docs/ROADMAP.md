# Pebble Browser Emulator — approved roadmap

## Goal and agreed decisions

A public browser-only Pebble development environment, Angular interface, actual Rust/Wasm
hardware core, functional virtual phone, packet inspection, and local browser compilation.
Target the current Core Devices Pebble Time 2. Validate fidelity progressively against the
owner's physical Time 2. Standard Pebble repositories come first; arbitrary legacy build
environments and real Bluetooth connections come later.

The public project is `huntrontrakkr/pebble-browser-emulator`. Host only static assets.
CI may build the website/toolchains but must never compile visitors' projects remotely.

## 1. Rust firmware boot — IN PROGRESS

- [x] Initialize Git, Angular, Rust workspace, versioned Worker/Wasm boundary, and tests.
- [x] Run an actual Thumb diagnostic and inspect its framebuffer/registers.
- [ ] Pin an unchanged qemu_emery firmware build and independent native QEMU reference.
- [ ] Implement required Armv8-M instructions, exceptions, NVIC, privilege, MPU, stack
      limits, and FPU. Compare against independent execution, not only internal unit tests.
- [ ] Implement qemu_emery's memory map, clocks, UART, flash, timers, RTC, buttons, and display.
- [ ] Match firmware boot logs, screenshots, and scripted interactions against QEMU.

Exit: real qemu_emery firmware boots in the Rust browser core. Keep this explicitly labeled
emulator firmware; it does not establish production Time 2 compatibility.

## 2. Public repository to running watchface

- [ ] GitHub REST tree + raw content import, pinned to a commit; local folder/archive import.
- [ ] Standard package.json/appinfo.json layouts; optional pebble-browser.yaml for supported
      SDK/root/target/source settings. Detect unsupported custom scripts.
- [ ] Pinned ARM Clang/LLD Wasm, SDK 4.33.1 Emery assets, exact resources/FreeType fonts,
      metadata/relocations, dependency integrity, PKJS bundling, and real PBW packaging.
- [ ] Honor target declarations and lockfiles; never substitute another platform library.
- [ ] Full independent demo with resource/font, battery/connection, settings, and AppMessage.
- [ ] Install via real virtual-phone transfers and retain ELF/debug metadata.
- [ ] Cache source/toolchains and demonstrate offline rebuild after first setup.

Exit: a fresh browser imports the public demo, compiles a PBW locally, installs it through
the phone protocol, and runs it in firmware. No application backend or proxy.

## 3. Virtual phone and inspection

- [ ] Pairing/connection lifecycle, transfers/checksums/retries, app services, notifications,
      settings, time, storage, location, timeline/BlobDB, and isolated PebbleKit JS execution.
- [ ] Raw/decoded packet capture with layer/direction/virtual time; filters, breakpoints,
      fault injection, export/import, and deterministic replay.
- [ ] Profile-appropriate battery/charging, sensors, audio/haptics, buttons/touch/backlight.
- [ ] CORS-permitted live PKJS network calls and fixture/replay responses otherwise.
- [ ] Versioned sessions/snapshots including clocks, randomness, and all external inputs.

Exit: reproducible app/configuration/notification/sensor/low-battery/disconnect scenarios.
Separate modeled analog behavior from verified logical behavior.

## 4. Production Time 2 fidelity

- [ ] Implement Obelix/SiFli memory/CPU, reset/clocks, XIP/flash, DMA, IRQ, timers, RTC,
      PMIC, JDI display, touch, sensors, audio, and haptics.
- [ ] Execute byte-identical production-target payload from an explicitly documented
      post-bootloader state. Then implement bootloader/slots/recovery/watchdog/update behavior.
- [ ] Validate silicon ROM dependencies and implement verified cold-boot behavior.
- [ ] Model HCPU/LCPU/controller interactions, then actual LCPU execution where dependencies
      and their usage terms are established.
- [ ] Compare selected firmware revisions with the owner's Time 2 and publish evidence.

Exit: each firmware/board combination passes its documented hardware comparisons. Unknown
firmware is not implicitly supported. Track vendor component constraints; upload alone is
not evidence that usage/redistribution terms are satisfied.

## 5. Release, speed, and physical connections

- [ ] Public static release of the first useful firmware/app workflow.
- [ ] Current desktop Chrome/Edge/Firefox/Safari verification; cancellable builds, quotas,
      responsive UI, no-backend request audit, static deployment portability.
- [ ] Browser-to-real-watch adapters for measured browser/firmware combinations.
- [ ] Profile slow paths; verify block caching/Wasm translation against the interpreter.

Do not equate exact guest behavior with physical RF/chemistry replication. Classify each
capability as verified, modeled, unverified, or unsupported. Full firmware/repository breadth
is a compatibility program, not an unconditional claim.
