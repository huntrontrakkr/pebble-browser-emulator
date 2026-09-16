# Reference inventory (2026-09-16)

- [Production PT2 board](https://github.com/zephyrproject-rtos/zephyr/blob/main/boards/coredevices/pt2/doc/index.rst):
  SiFli SF32LB52JUD6, Obelix board. Emery is the app platform, not a unique physical board.
- [Current QEMU profiles](https://github.com/coredevices/PebbleOS/blob/main/docs/development/qemu.md)
  and [generic map](https://github.com/coredevices/qemu/blob/pebble-10.1/include/hw/arm/pebble_generic.h).
  Generic qemu_emery is M33/64 MHz, code at 0, SRAM at 0x20000000, XIP at 0x10000000,
  framebuffer at 0x50000000; reset startup uses MSPLIM/PSPLIM immediately.
- [Existing browser emulator](https://github.com/ericmigi/pebble-qemu-wasm): useful technical
  reference, not proof of production Obelix fidelity. appbuild has unresolved separate
  licensing/provenance; do not copy it or its binaries without resolving that.
- [MIT libpebble2](https://github.com/pebble/libpebble2/tree/23e2eb92cfc084e6f9e8c718711ac994ef606d18):
  raw packet framing and independent Ping vectors. Source license: MIT, Copyright 2015
  Pebble Technology. Our implementation is original; tests use protocol facts.
- [Current mobile companion](https://github.com/coredevices/mobileapp): GPL-3.0, Android/JVM/iOS,
  no web target. Use as a behavior reference; a direct source port carries licensing duties.
- [microbit-clang-wasm](https://github.com/carlosperate/microbit-clang-wasm) version
  21.11.0-alpha.1: ARM Clang/LLD in Wasm; LLVM Apache-2.0 WITH LLVM-exception, wrapper ISC.
  Published package exposes createSession/writeFile/run/readFile. Actual ARM object generation
  was verified separately in Node's WebAssembly runtime during research, not in this app.
  Runtime assets total about 98 MB uncompressed; self-host with all component notices.
- [SDK 4.33.1 archive](https://sdk.repebble.com/releases/4.33.1/sdk-core.tar.gz): archive endpoint
  lacks CORS and archive-wide license notices; use user local import or an audited build from
  separately licensed upstream sources. Do not silently proxy or redistribute the whole archive.
- [Firmware nonfree components](https://github.com/coredevices/pebbleos-nonfree): SiFli, Nordic
  fuel-gauge, and Goodix components have IC-specific usage clauses that need resolution.
- [pblboot](https://github.com/coredevices/pblboot): public second-stage bootloader; silicon
  boot ROM is a separate dependency. Matching ROM-labelled SDK images to PT2 revisions remains
  unverified.
- [picoem Rust core](https://github.com/0x4D44/picoem): MIT/Apache candidate for an adaptation
  spike, not integrated. Its M33 CPU has RP2350-specific bus/PPB/cache assumptions.

No third-party firmware or SDK binaries are bundled in this foundation.
