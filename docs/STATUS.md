# Compatibility and verification

The project now executes real QEMU Emery firmware and builds actual Pebble app packages.
It remains an experimental emulator. Support is specific to the combinations below, and
functional execution does not establish physical-watch timing, optics, power, or radio fidelity.

| Capability               | Current scope                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firmware execution       | Official full `qemu_emery` PebbleOS 4.37.0 and 4.36.0 boot unchanged; real GPIO buttons and app installation work.                                                                          |
| Physical Time 2 firmware | Obelix/SiFli production PBZ metadata can be inspected. The production board is not implemented.                                                                                             |
| Firmware versions        | Official release catalog with direct version lookup; matching local image pairs; raw micro flash or SDK ELF32 normalization; SPI flash 32 MiB. Other versions need individual verification. |
| GitHub source            | Public repository, branch/commit, and project folder; commit-pinned binary-safe downloads; local ZIP alternative.                                                                           |
| Browser builds           | Verified SDK 4.33.1 / Emery native C profile, system fonts, numbered message keys, one PKJS file, conventional build templates.                                                             |
| PBW installation         | Actual BlobDB, AppFetch, PutBytes, CRC commits, and firmware launch events. Existing Emery PBWs can be imported.                                                                            |
| Virtual phone            | QuickJS sandbox, geolocation injection, virtual Date/timers, per-app storage, AppMessage encoding/delivery and actual ACK/NACK.                                                             |
| Inputs                   | Buttons, RTC epoch, firmware battery percentage/charging, and virtual Bluetooth connection state.                                                                                           |
| Inspection               | CPU registers, session log, raw/decoded endpoint capture, filtering/export, manual packet injection.                                                                                        |
| Display                  | Exact ARGB2222 pixel conversion; adjustable but uncalibrated reflective approximation; official rotatable Time 2 CAD with live pixels.                                                      |
| Reset                    | Restarts the loaded CPU, RAM, and peripherals while retaining modified SPI flash, installed apps, and RTC phase.                                                                            |
| Snapshots                | Diagnostic board only. Firmware/phone snapshots and replay remain open.                                                                                                                     |

## Evidence and limits

- Native Rust tests cover the independent diagnostic, the generic board adapter, stack limits,
  SVC/exception return, NVIC, exact-zero SysTick, UART FIFO, flash erase, and the CPU's local
  acquire/release instructions, priority byte lanes, ITSTATE stacking, WFE/SEVONPEND, active
  stack reads, CPS mask selection, and MSP/PSP exception returns. Encoding vectors were assembled independently.
- JavaScript tests exercise the compiled diagnostic Wasm, Workers, source/archive validation,
  compiler packaging, transport streams, and actual QuickJS execution with resource limits.
- The diagnostic matches Unicorn 2.1.4 for 228,004 instructions, R0–R2, and all 45,600 pixels.
- Browser-capable Clang/LLD compiled the current demo into an 8,118-byte PBW and 82,548-byte
  ELF. SDK metadata injection, resource pack, CRCs, and a separate relocation fixture match
  the official SDK byte-for-byte. A Worker harness reproduced the same PBW.
- Actual Wasm boots the unchanged official firmware, installs that PBW with real firmware
  acknowledgments, and delivers a QuickJS geolocation-derived AppMessage to the native app.
  The native app's ACK reaches the JavaScript success callback.
- An official native QEMU oracle runs the exact same firmware/PBW. It confirms the expected
  rectangular time/battery/status watchface. The lost-wake fault causing stalled transitions
  and transfers was traced to dropped priority-register byte stores and corrected. The UI
  reads the last committed display update, separately from in-progress guest drawing memory.
  With time, battery (57%), and AppMessage text (GPS 40.71) aligned, all **45,600 bytes match**
  native QEMU: SHA-256 `ff5e62857b3d6e14c4a2d7cbc57a57e64f3f89471c483f09c599c4d3ea3b470b`.
  This is one exact rendering checkpoint, not exhaustive frame or firmware coverage.
- The actual QEMU Worker passes boot, install/reinstall, AppMessage, battery/link, reset
  cancellation, and step-during-install gates with 4.37.0. The same install/reinstall and
  message/input workflow also passes with the unchanged 4.36.0 image pair.
- Node Worker/Web API harnesses test application logic and shipped Wasm; actual browser visual
  and Chrome/Edge/Firefox/Safari compatibility testing have not been completed.

Pinned firmware files (not redistributed):

| File                                 | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `qemu_emery_v4.37.0_micro_flash.bin` | `6783255bd4efc4053176936cffebaf8bf7ba7beed572e11ae99aa187e0e41b02` |
| `qemu_emery_v4.37.0_spi_flash.bin`   | `d8a622dd54a41e03d10049b102971ec51f1457c9d718dc260968fbcdb47300b5` |

Official assets: [PebbleOS v4.37.0 release](https://github.com/coredevices/PebbleOS/releases/tag/v4.37.0).
The shipped UI retrieves official metadata directly, but release-asset CORS restrictions
require a download followed by local import. No proxy or application backend is substituted.

## Reproduce optional firmware tests

Build Wasm and provide the official matching files plus a compiled demo PBW:

```sh
PEBBLE_REAL_WORKER=1 \
PEBBLE_FIRMWARE_DIR=/path/to/official/assets \
PEBBLE_PBW=/path/to/browser-demo.pbw \
npm test
```

The ordinary test suite needs no firmware or SDK downloads. `PEBBLE_TRACE_DIR` can point to
an existing directory to retain full protocol traces from the integration gate.

Set `PEBBLE_REFERENCE_FRAME=1` as well to verify all 45,600 frame bytes against the native
QEMU oracle. That test requires the deterministic reference demo PBW (SHA-256 recorded in
`docs/evidence/firmware-acceptance.json`). `worker-frame-acceptance.json` records the exact
final Wasm and input hashes used in the passing Worker test.

## Next gates

1. Expand independent native-QEMU comparisons and complete actual browser interaction,
   visual, accessibility, and Chrome/Edge/Firefox/Safari verification.
2. Expand the build profile to PNG/PBI/vector/font resources, dependency resolution and PKJS
   modules, background workers, legacy metadata, and additional SDK/platform combinations.
3. Add firmware/phone/flash snapshots, clock/random/input replay, packet breakpoints and
   loss/delay injection, network fixtures/CORS calls, configuration pages, notifications,
   health/motion/touch/audio/haptics, and battery consumption modeling.
4. Implement the physical Obelix board, boot/ROM/flash/controller dependencies, and establish
   comparison measurements against actual Time 2 hardware before claiming hardware fidelity.

Unknown instructions/peripherals, MPU/TrustZone, exception behavior, RP2350-derived cycle
estimates, audio placeholders, and reset behavior across additional firmware need wider coverage.
A successful boot or app ACK alone is insufficient evidence of complete emulation.
