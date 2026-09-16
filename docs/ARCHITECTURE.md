# Runtime architecture

The static Angular application orchestrates independent Workers:

- **Diagnostic Worker:** original small Thumb test machine, snapshots, packet-codec checks.
- **Generic Pebble Worker:** Rust M4/M33 instruction engine, original generic board adapter, virtual time,
  firmware flash/SRAM/framebuffer, and UART transport. No Wasm host imports.
- **Compiler Worker:** version-pinned Clang/LLD Wasm, isolated memory filesystem, user SDK,
  a declarative supported build profile, original SDK-compatible PBW packaging. Project
  Python/Waf and package installation scripts are never executed. Cancel terminates the Worker.
- **Phone Worker:** isolated QuickJS Wasm runtime, bounded memory/stack/execution/output,
  virtual timers, local storage, injected location, HTTP fixtures/CORS requests, configuration events, and actual AppMessage acknowledgments.
- **Archive Worker:** bounded ZIP/TAR/gzip extraction and package inspection with path,
  expanded-size, header, size, and CRC validation.

No user compilation or app execution runs on a server. Public GitHub source and compiler/CAD
assets are fetched directly; release and SDK artifacts without CORS are opened locally.

## Board separation

`diagnostic-v1` is a separate development machine, with input registers at 0x40000000 and
0x40000004. Those addresses do not mean the same thing on QEMU Emery or physical Obelix.

The generic boards use a nominal 64 MHz clock. Emery/Gabbro advertise Cortex-M33; Flint advertises Cortex-M4. Shared instruction-engine architecture exclusions remain incomplete. Geometry, memory, CPUID, and device feature registers come from the selected profile.

Emery memory map:

| Region                           | Address / size                                             |
| -------------------------------- | ---------------------------------------------------------- |
| Micro flash                      | 0x00000000 / 4 MiB                                         |
| SRAM                             | 0x20000000 / 512 KiB                                       |
| External flash                   | 0x10000000 / 32 MiB                                        |
| UART 0/1/2                       | 0x40000000 / 0x40001000 / 0x40002000                       |
| Timers                           | 0x40003000 / 0x40004000                                    |
| RTC / buttons / system / display | 0x40005000 / 0x40006000 / 0x40007000 / 0x40008000          |
| Flash / touch / audio control    | 0x40010000 / 0x40011000 / 0x40012000                       |
| Framebuffer                      | 0x50000000 / 128 KiB window; 45,600 visible ARGB2222 bytes |

The CPU comes from pinned `rp2350-emu` 0.2.6 via its generic CoreBus API. RP2350 board
peripherals are not substituted for Pebble hardware. Local CPU corrections are documented in the vendored change log and covered by
independent instruction fixtures. The board wrapper supplies SysTick advancement, virtual peripherals,
interrupt signaling, and WFI/WFE wakeups. Timing remains approximate; scheduler steps are not
reported as accurate hardware cycles. The physical SiFli board has different dependencies.

Raw micro images use the vector table at zero. SDK ELF32 inputs are normalized from PT_LOAD
**physical addresses**, including data load images whose virtual addresses point into SRAM.
Input bounds and vector tables are checked before replacing the machine.

## Transport

Raw packets are `payload_length:u16BE | endpoint:u16BE | payload`. UART1 uses a separate
`0xFEED | channel:u16BE | length:u16BE | payload | 0xBEEF` envelope. The host respects the
256-byte receive FIFO and advances the guest while servicing partial writes. QEMU control
channels deliver battery and logical Bluetooth state. This is not physical Bluetooth RF.

Installation sends AppMetadata through BlobDB, handles the firmware's AppFetch request,
transfers executable/resources/background worker with PutBytes, checks real ACK cookies and CRC commits,
and waits for the requested UUID's running-app event. It does not manufacture success.
AppMessage dictionaries travel through endpoint 0x30; QuickJS success callbacks depend on
received firmware ACKs. Wire transaction IDs retain their owning phone instance until
settled; session generations reject late messages across watch resets. Incoming messages
are acknowledged after host delivery.

## Display and state

A successful display UPDATE latches guest pixels into a presentation buffer. The UI reads
that completed frame, so pausing midway through drawing cannot expose a half-drawn screen.
It never draws a substitute watchface. Raw pixels map
2-bit channels to 0/85/170/255. The reflective mode is explicitly uncalibrated. Three.js uses
official pinned STL geometry and a live framebuffer texture; materials and illumination
remain approximations. Display settings never mutate guest memory.

Source snapshots and the trimmed SDK subset persist in IndexedDB. Compiler assets use the
Cache API after integrity verification. Phone storage is isolated per app in the current
browser session. Firmware and its writable flash currently remain in the active Worker;
reset preserves the current SPI flash and RTC time while restarting CPU, RAM, peripherals,
and transport. Reopening the original firmware pair restores its original flash contents.
Diagnostic snapshots are session-local.
Complete firmware/phone save states and deterministic replay are future gates.

## Platform builds and dependencies

The compiler uses each selected platform's SDK headers, library, feature defines and memory limits.
Resource conversion runs on raw PNG bytes and reproduces SDK output without browser color management.
esbuild's Wasm browser API resolves local JS/JSON modules and integrity-checked npm archives in a
bounded in-memory filesystem. Pebble package `dist.zip` artifacts supply their `dist/js` entry.
No npm lifecycle script, custom Python or repository-provided plugin runs on the host.

The app changes its running model only after the Worker accepts a firmware image. Failed loads retain
the previous board identity and framebuffer geometry. Flint's packed 1bpp pixels expand to canonical
ARGB2222 only at completed display updates; round-screen clipping is a presentation-only mask.
