# Round 2 live-notification rendering failure

Fixed September 17, 2026. The demo sender omitted the standard local **Dismiss** action.
Gabbro 4.37.0 accepted and stored those notifications, but its live alert remained on the
pink introduction graphic instead of revealing the message. This was an input-triggered
rendering failure, not evidence that the browser or the whole emulated CPU had frozen.

## Causal comparison

All cases booted fresh, unchanged official Gabbro 4.37.0 micro/SPI images in native QEMU.
The control used the actual `libpebble2` 0.0.31 `Notifications.send_notification()` serializer.
Records were sent through BlobDB and acknowledged by the real firmware.

| Notification input                                                      | Result                                   |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| Original demo record, no actions                                        | Introduction remains; message unreadable |
| Same demo record with only Dismiss added                                | Message appears                          |
| Official library record                                                 | Message appears                          |
| Official record with only its action removed                            | Introduction remains; message unreadable |
| Official record with icon removed                                       | Message appears                          |
| Official record with demo layout, flags or parent UUID (separate tests) | Message appears                          |
| Official record with subtitle removed                                   | Message appears                          |

Removing an action also adjusts the serialized length and action count; all other fields
stay unchanged. This isolates the action omission from the other differences between our
sender and Pebble's. Both successful insertion acknowledgments and native QEMU reproduction
were insufficient earlier checks: we had sent the same problematic input to both runtimes.

The firmware's precise internal transition/callback fault has not been traced. Zero-action
records are structurally accepted, so this is not a claim that the wire format forbids them
or that all firmware versions handle them this way. Native CPU snapshots during the symptom
were predominantly waiting for interrupts, consistent with a stuck visual state rather than
an instruction loop consuming the phone's CPU.

## Correction and regression coverage

Every demo notification now includes action ID 0, type 4 (Dismiss), with title attribute 1:
`0004010107004469736d697373`. Calendar records still have zero actions. The firmware handles
Dismiss locally for our demo data source; we do not fabricate a phone response or modify
firmware. Live and archived notification fixtures cover the corrected record lengths.

- `npm test`: 333 passed, 9 optional firmware tests skipped, no failures.
- Actual mobile-viewport browser workflow: Time 2 and Duo passed Chromium; Round 2 passed
  Chromium, Firefox and WebKit, including live insertion, settings, inputs and sample cleanup.
- Round 2's corrected message matches the frozen native QEMU reference at **every visible
  round-display pixel below row 24**. The status clock and off-display rectangular corners
  are excluded explicitly; this is not a whole-frame or timing-equivalence assertion.
- Chromium interaction separately verified Select → Dismiss → first-use tutorial → Select
  returning to Clock. The fixed notification and returned clock screenshots are retained.

[Machine-readable evidence](evidence/notification-rca.json) includes firmware, payload and
frame hashes. [Earlier negative captures](evidence/demo-notification-reference.json) remain
as historical evidence; their compatibility-limit conclusion is superseded.

To reproduce, use the native command in [DEMO.md](DEMO.md), with and without
`PEBBLE_OMIT_NOTIFICATION_ACTION=1`. Run `scripts/verify-demo-browser.mjs` against a built,
served site with `PEBBLE_PROFILES=qemu_gabbro PEBBLE_SKIP_3D=1` and
`PEBBLE_BROWSERS=chromium,firefox,webkit` for the visible-message regression.

## Phone performance

Responsive real-time watchface and app emulation is a reasonable engineering target on a
Pixel 9 Pro XL. Its Tensor G4 and 16 GB RAM are documented by
[Google](https://blog.google/products-and-platforms/devices/pixel/google-pixel-9-pro-xl/).
That feasibility assessment is an inference, not a benchmark of this emulator on that phone.
Instruction interpretation, browser scheduling, active firmware and optional 3D rendering
still determine the actual cost; compiling the host core to Wasm does not eliminate it.

On the Linux test computer, Chromium at a 412×915 viewport kept approximately real time:
1.002 virtual seconds per wall second while idle and 0.984 during the six-second window
containing a live notification. The probe records first/last acknowledged Worker clock
messages using `performance.now()`; it does not measure calibrated hardware cycles, FPS,
input latency, sustained thermals or physical-phone performance. It used the Clock example,
default synthetic inputs and the pixel view. Full phase timings are in the evidence file.

The functional fidelity target should be preserved during optimization: skip idle execution
only to the next device deadline, and reduce redundant host/UI work. Exact physical timing,
radio behavior, and compatibility with arbitrary firmware remain separate, unverified goals.

## Primary references

- [Pebble's notification sender](https://github.com/pebble/libpebble2/blob/master/libpebble2/services/notifications.py), locally inspected as PyPI release 0.0.31.
- [Timeline wire header and action types](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/timeline/item.h).
- [Local Dismiss handling](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/src/fw/services/timeline/timeline.c), `timeline_invoke_action`.
