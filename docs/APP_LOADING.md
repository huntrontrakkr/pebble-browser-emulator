# App loading, recovery and remaining compatibility limits

A PBW can contain an app or a watchface; both use the same real BlobDB, AppFetch and PutBytes
installation protocol. Receiving AppRunState confirms launch, not continued app correctness.

## Recovery

Installation displays the current phase and byte count. A protocol failure stops the watch
instead of resuming it while reporting an error. A host-side watchdog stops installation
when no progress is reported for 45 seconds, including when virtual time cannot advance.
Cancel and a Worker crash clear busy state. The previous PKJS instance stops before a new
installation so its clock barrier and traffic do not remain attached to the replacement.

**Restart preview** terminates the current watch Worker and loads the retained PBW into a
fresh saved/default firmware session. It works for a local PBW without downloading the app
again. Saved demo preferences are reapplied; the current watch's unsaved RAM/flash changes
are cleared. The next selected preview also reloads firmware after an install failure.
Developer **Reset** keeps its separate warm-reset semantics for inspecting a running session.

## Reproduced store-app failure

The reported app name/link was not supplied. Testing found a concrete failure with
[Kablooey! 1.0.0](https://apps.repebble.com/app_1e6c5bbde96f4e6ca3497194) on unchanged
`qemu_emery` PebbleOS 4.37.0. Its initial game frame appears, but later input/service work
can stall. Installing another app in that session times out on BlobDB endpoint `0xb1db`.
With the current source-backed speaker model, firmware reports a full system task queue
and reset/core dump before that timeout. The Rust core reports no bus fault.

Controlled comparisons with official native QEMU **v10.1.5-pebble17**, the same PBW and
identical firmware images:

| Native QEMU timing                                  | Observed result                                             |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Default virtual clock                               | Touch starts gameplay; switching to Clock succeeds          |
| `shift=4,align=on,sleep=on` instruction-count clock | Firmware event queue overflows/reboots; switching times out |
| `shift=0,align=on,sleep=on` instruction-count clock | Touch starts gameplay; switching to Clock succeeds          |

This establishes sensitivity to available execution time between firmware timer events;
it does not prove a specific physical clock rate or rule out other core defects. Native
QEMU's audio device exposed a separate register-level discrepancy. A bounded MMIO trace
showed Kablooey enabling speaker IRQs during install; the old browser model did not raise
QEMU's documented initial refill interrupt. The current core models that interrupt,
FIFO and virtual-time drain. Kablooey now supplies audio samples, but the full system
task queue and reset still prevent the next install. This is a modeled QEMU-source
correction, not a native-trace equivalence or a compatibility fix. [Capture and scope](HARDWARE_FIDELITY.md).

A later [bounded virtual-time workload capture](evidence/kablooey-workload.json) finds
Kablooey using nearly the full generic 64 MHz estimated CPU budget continuously after
touch, compared with under 0.5 million estimated cycles per second for idle Clock.
The 64 MHz value is the [pinned QEMU generic SYSCLK declaration](https://github.com/coredevices/qemu/blob/v10.1.5-pebble17/include/hw/arm/pebble_generic.h#L73),
not a measurement of a physical Time 2. Native QEMU's default CPU execution is not
limited to one instruction per nominal clock cycle.
The Kablooey install timeout reproduces with the same full-state/frame checkpoint hashes
as before the samples were added. This supports a load/timing investigation, but an
estimated interpreter cost is neither a retired instruction count nor a physical clock
measurement. A reference-backed scheduler, CPU or device cause remains unproven.

Fresh store installs of Clear Timer, Roon Remote, Spin the Bottle, Fatal Run, Slow and
Clock Dude succeeded. That is installation coverage, not certification of their complete
behavior. In particular, network-dependent features and app-specific sensor processing
remain separate gates. The UI recovery fix does not mark Kablooey compatible.

Next: compare callback scheduling and instruction budgets against native traces, validate
speaker timing/backpressure with independent device evidence, and reproduce the user's
specific app on its selected profile. Keep those corrections separate from host loading
and input controls.

## Reproduction and tests

Supply the unmodified PBW, firmware and native QEMU locally; the script does not download
or redistribute them:

```sh
PEBBLE_QEMU=/path/to/qemu-pebble \
PEBBLE_FIRMWARE_DIR=/path/to/firmware \
PEBBLE_APP_PBW=/path/to/kablooey.pbw \
node scripts/verify-app-reference.mjs
```

Set `PEBBLE_QEMU_ICOUNT=shift=4,align=on,sleep=on` (or `shift=0,align=on,sleep=on`) to repeat
the timing comparison. The script saves console and frame captures under
`tmp/app-reference-emery` (override with `PEBBLE_TRACE_DIR`). A changed frame alone does
not prove the app handled touch; the reported native gameplay was also visually inspected.

`node scripts/verify-preview-inputs.mjs` runs the production mobile layout and real bundled
firmware. It checks a shake/tap's UART delivery, native touch coordinates/release, pause,
round clipping and Duo's missing touch capability. It explicitly injects a host Worker
crash and a non-responsive install to verify watchdog/restart behavior; those injected
failures are not firmware-compatibility evidence. `verify-model-browser.mjs` additionally
projects known display points at different camera angles and checks their touch coordinates
and the rotation toggle. Both are CI gates. Existing PWA/offline and phone configuration
gates remain in place. The evidence summary is [here](evidence/app-inputs.json).
