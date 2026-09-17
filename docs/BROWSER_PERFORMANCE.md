# Browser runtime overhead

The manual changes measured on 2026-09-17 reduce work around the emulator. They do not
change the CPU implementation, firmware, sensor calculations, guest display operations,
10 ms phone clock boundary or 30 Hz presentation limit. No Dream-RSI search was used.
The previously retained interrupt optimization remains in place.

## Measured changes

Three alternating paired Chromium runs compared the full static application with commit
`0ed9e4d0a2d7f695b98f9fe1d8f729a3f9908435`. Each launched the actual Clock watchface,
QuickJS phone and default demo inputs on the unchanged Emery 4.37.0 firmware. These are
desktop Linux/WSL2 measurements with a 390×844 mobile viewport, not a physical Pixel 9.

Medians over five-second samples:

| Measurement                                                |  Before |   After |
| ---------------------------------------------------------- | ------: | ------: |
| Clock-message crossings through the main thread            |   2,004 |      47 |
| Framebuffer bytes delivered while the screen was unchanged | 866,400 |       0 |
| Canvas redraws while the screen was unchanged              |      19 |       0 |
| New ImageData allocations                                  |      19 |       0 |
| Virtual time elapsed with an idle UI                       | 4.999 s | 5.015 s |
| Virtual time elapsed with synthetic UI contention          | 4.790 s | 5.004 s |

Clock traffic through the UI fell **97.7%**. The contention phase deliberately blocked
the main thread for 750 ms in each second. This demonstrates less dependence on the UI;
the original build already caught up substantially between blocks. It is not a general
speed multiplier. Roughly 10 Hz clock telemetry adds endpoint-sampling uncertainty of
about 0.1 seconds. One changed frame during a busy sample was still delivered and drawn;
the optimization removes unchanged frame transfers, not guest drawing.

A separate QuickJS benchmark advanced 1,000 clock quanta, with ten storage mutations.
Five alternating pairs after warm-up compared every emitted event and persisted value.
The output path took a storage snapshot 11 times instead of 1,001 times:

| Initial stored payload | Before, median | After, median | Clock/output loop speedup |
| ---------------------- | -------------: | ------------: | ------------------------: |
| Empty                  |       12.59 ms |       4.77 ms |                     2.64× |
| 1 KiB                  |       16.71 ms |       4.93 ms |                     3.39× |
| 64 KiB                 |      348.13 ms |      57.55 ms |                     6.05× |

These timings exclude the firmware CPU, networking, settings UI and rendering. They
must not be described as whole-emulator FPS gains. Large storage still costs time when
the guest writes it; every mutation remains observable and persistent.

## Behavior and safeguards

- Routine clock phases use a MessageChannel between watch and phone Workers. Phases
  involving AppMessages, connection changes or timed phone inputs retain the ordered
  UI path. An outbound phone AppMessage precedes its clock acknowledgment on that same
  path, preserving packet enqueueing before the next quantum. Replaced ports and stale
  generations cannot release the current clock barrier.
- Storage mutations increment a revision before diagnostic output limits are applied.
  Initial state, writes, property assignment, deletion and clearing trigger snapshots.
  Unchanged state avoids serialization and the extra QuickJS call.
- The main UI opts into frame updates that omit unchanged pixels. Forced snapshots,
  pauses, steps, faults and session initialization still include full pixels. Recorder
  consumers retain the original full-frame format unless they opt in. ImageData is
  reused until the dimensions change; all 256 colors match in each display mode.
- Log and packet observers update in 50 ms batches. They keep the existing ordered
  200/300-record tails. Clear removes unpublished records and Export flushes them first.

UI contention can still delay app messages and configuration operations that intentionally
use the ordered relay. This change is not a complete worker-side protocol router.
Guest behavior, changed-frame rendering and actual firmware acknowledgments remain
independent acceptance requirements.

An additional CPU/peripheral fast-path experiment scored only **1.003×** across five
alternating pairs, with mixed per-profile results. It was reverted. The retained Wasm is
byte-identical to the starting binary:
`67b6dfc41fadb7865cdc10d73f917b13abda443cb2ed542076893aa302d649ec`.

Raw samples, hashes and acceptance outcomes are in
[the evidence record](evidence/browser-performance.json).

The production build, 84 Rust tests and 344 default JavaScript/Wasm tests passed; nine
asset-dependent tests remain opt-in in the default command. Explicit integration runs
passed both clock transports and all three sensor profiles. Each sensor checkpoint
matched the existing native-QEMU reference byte for byte. Clock settings and the preview
workflow passed Chromium, Firefox and WebKit; the original JustTheTime store watchface
and configurable demo inputs passed all three profiles in Chromium. The demo gate also
matched the visible Round notification pixels against native QEMU. These runs reused
the existing 3D implementation without downloading CAD again.

## Reproduce

Before editing, save the built `dist/client` directory and the complete `src` directory.
Keep the source copy under the repository so its package imports resolve. Build the
candidate normally, then run each timing command separately from other CPU-heavy work:

```sh
node scripts/optimization/benchmark-phone-output.mjs \
  tmp/baseline-src/app/virtual-phone.ts tmp/phone-output.json
node scripts/optimization/benchmark-preview.mjs \
  tmp/baseline-site dist/client tmp/preview-performance.json
```

The browser script starts and closes two loopback-only static fixture servers and real
Chromium Workers. It records both normal and synthetic busy-UI phases. Regression checks
also cover startup waiting, port replacement, timed locations, packet/ACK ordering,
pause, storage quota overflow, pixel equality and log retention. Run the existing real
firmware shared-clock test with `PEBBLE_DIRECT_CLOCK=1` for the new transport, or without
that variable for the compatibility path.
