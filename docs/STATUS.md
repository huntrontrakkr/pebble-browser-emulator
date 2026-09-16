# Implementation status

This is an executable **development foundation**, not a working PebbleOS emulator yet.

## Implemented

- Public Git repository and Angular 22 application with a static-only build.
- Original Rust CPU diagnostic with a deliberately limited Thumb instruction subset.
- Vector-table loading, bounded flash/SRAM, framebuffer writes, and explicit faults.
- Browser Worker + versioned Wasm ABI; register inspection, step/run/pause/reset.
- A 200×228 diagnostic program that fills the framebuffer by executing ARM instructions.
- Full diagnostic-machine snapshots and deterministic replay; saved state is session-local.
- Injected diagnostic button/battery registers; these are not physical device models.
- Pebble packet framing/stream decoding and a browser Ping-encoding inspector.
- 14 native Rust tests and 10 compiled-Wasm/Worker/inspector tests pass.
- Independent Unicorn 2.1.4 ARM M-class comparison: 228,004 diagnostic instructions,
  matching R0–R2 and all 45,600 framebuffer bytes (SHA-256
  `64a9ef0caecf55b6ba0c27fe4c92aae72171094c650697e3e90e1e38bb9f2c56`).
- Separate demo watchface source is included, but has not yet been built/run with the SDK.
- Optional WebMCP state inspector has a mocked registry contract test; registration in an
  actual supporting browser has not been verified.

## Not implemented

- Armv8-M CPU coverage, NVIC/exceptions/MPU/FPU, and actual qemu_emery peripherals.
- Booting any PebbleOS firmware, including SDK emulator firmware.
- Production Obelix/SiFli hardware, boot ROM, bootloader, LCPU, Bluetooth, or energy models.
- Browser watchface compilation, PBW installation, GitHub project import, and PebbleKit JS.
- Physical Bluetooth connections, offline application caching, and cross-browser validation.

The user-facing notice deliberately exposes these limits. Do not mark Milestone 1 in the
roadmap complete until a pinned, unchanged qemu_emery firmware passes the reference gate.
