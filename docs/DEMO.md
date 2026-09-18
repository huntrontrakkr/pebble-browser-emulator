# Demo data and watch controls

Preview starts with a 69% battery, two sample messages and two sample calendar events.
These are inputs to the unchanged firmware, not HTML painted over its framebuffer.
**Settings** opens a keyboard-accessible modal drawer. Settings persist locally in this
browser. Manual firmware/developer workflows do not automatically apply demo defaults;
Save & apply can explicitly apply them to an already booted watch.

## Signals

- Battery percentage and charging state use QEMU's real battery control channel.
- Time 2 receives a synthetic raw heart-rate reading every virtual second: a configurable
  base BPM and sinusoidal variation with a 20-second period. Duo and Round 2 do not expose
  this input and receive no fabricated HR responses. This is not a raw optical PPG waveform
  or a validated simulation of the watch's physiological algorithms.
- Motion can be off, stationary, walking or running. The moving presets send deterministic
  accelerometer values at 10 Hz in watch time. A wrist-tap button sends the actual tap input.
- Seven health totals are independently configurable. Real preference/BlobDB exchanges
  enable activity tracking before sending totals. Motion does not calculate these values.
- A configurable GPS location reaches the virtual phone script's location API. It does not
  create a GPS device inside a watch. Existing developer tools retain error, compass,
  touch, button, clock, connection and custom scenario controls. In particular, a compass
  packet does not implement the firmware's missing compass service.

The signal generator uses virtual deadlines, bounded state and no wall-time intervals or
large precomputed queue. Pause freezes it. Loading a developer scenario stops the demo
stream so two sources cannot race to set the same sensor. Reapplying demo settings replaces
the current scenario. Disabling demo data stops the stream and removes only its owned
messages/events; last-applied readings and health preferences remain until explicitly changed.

## Notifications and calendar

An original TypeScript encoder writes Pebble's serialized timeline records through BlobDB:
notifications database 4, calendar pins database 1, real endpoint `0xb1db`. Every insert,
status update and deletion waits for the firmware's token-matched acknowledgment. Unknown
or unsuccessful replies are errors. Deletion accepts only Success (1) and the explicit
Key-does-not-exist (6) response.

Default notifications are inserted and then marked dismissed through the notification
status-update protocol. They remain in the Notifications app without covering the watchface.
**Send now** uses the shown title/body and produces a live firmware alert. Calendar events
use the standard calendar data-source UUID and layout. From a watchface, Down opens the
future timeline. Start offsets are measured from the watch's current clock at application
time. Fixed per-slot UUIDs allow editing/removal without duplicates or clearing unrelated
watch data. Each list allows eight items; text, coordinates, totals and timing are validated
on both sides of the Worker boundary.

Demo setup completes before the pending watchface installation starts. Session generations
and request revisions prevent an old setup acknowledgment from launching a canceled preview.

Wire references (read as protocol documentation; no upstream runtime code is copied):

- [PebbleOS 4.37.0 timeline item header](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/timeline/item.h)
- [Attribute IDs](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/timeline/attribute.h)
- [Notification insert/update behavior](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/src/fw/services/blob_db/notif_db.c)
- [BlobDB commands and statuses](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/blob_db/endpoint_private.h)
- [Official calendar feed](https://github.com/coredevices/PebbleOS/blob/6262d5fc1f7257c36e27682843e01268810fc62e/tools/libs/pbl-cli/pbl/feeds/calendar.py)

The independent `tests/fixtures/demo-timeline.json` vectors use Python `struct` with the
firmware's 46-byte `<16s16sIHBBBBHBB` header and `<BH` attribute headers. They cover UTF-8,
archive status, calendar parent IDs, lengths and little-endian time/duration fields.
Notification vectors also include the standard local Dismiss action, independently checked
against Pebble's `libpebble2` notification serializer.

### Round 2 live-alert correction

Our original encoder omitted the Dismiss action included by Pebble's normal notification
sender. Actionless messages were acknowledged but triggered Gabbro 4.37.0's incomplete
live-alert rendering. Adding that action fixes the message; no firmware is patched.
The corrected visible message matches native QEMU in Chromium, Firefox and WebKit.
Select opens Dismiss; selecting it dismisses the message. Fresh firmware also shows its
one-time action tutorial, which Select closes. [Root cause, evidence and limits](NOTIFICATION_RCA.md).

`PEBBLE_FIRMWARE_DIR=... PEBBLE_APP_PBW=public/examples/clock-gabbro.pbw
PEBBLE_PROFILE=qemu_gabbro PEBBLE_QEMU=... node scripts/capture-notification-reference.mjs`
records unchanged native firmware behavior. Set `PEBBLE_OMIT_NOTIFICATION_ACTION=1` to
reproduce the original failure with only the action removed. Browser acceptance compares
the corrected message to the frozen native reference, excluding the changing status clock
and off-display corners. Existing complete sensor-frame comparisons keep their separate scope.

## Controls and models

Back sits on the left; Up, Select and Down sit on the right. Their arrangement changes with
the watch profile. Each control has a 44px or larger target, a text/accessible name, pointer
capture, pressed state and keyboard support. Arrow keys work while the watch area has focus.
Window blur/visibility changes release held buttons. The default pixel view preserves all
rectangular framebuffer pixels, and the round screen clips its actual round display.

All three current products have their own simplified official CAD geometry, loaded only when 3D watch
is selected. Controls are projected from case-space anchors and move when the watch rotates;
they hide on the back. WebGL stops while hidden, uses an on-demand render loop and caps its
pixel ratio at 1.5. Materials, optical response, screen placement and enlarged button targets
are visual approximations, not evidence of physical hardware or color calibration.

Selecting a different watch reopens the current example, GitHub target or uploaded PBW for
that profile. Unsupported packages still report their platform/installation error. The
renderer is reused, replaced loads are canceled, and parsed/simplified geometry is prepared
in a Worker and cached in device storage. The initial download still uses the original CAD;
subsequent opens use the derived mesh. Geometry reduction does not change the live framebuffer.

The 3D **Lighting** menu selects studio, daylight or warm room; **Light direction** rotates
the environment and key light. **Ambient light** controls reflected illumination, while
**Backlight** adds screen emission. A diffuse LCD material with a clear cover layer responds
to view angle, and metal/plastic cases reflect the same environment. Small procedural maps
are generated once per environment and reused; no HDR downloads, shadow maps, bloom,
transmission passes or per-frame reflection captures are needed. Reflective 2D mode combines
ambient and backlight in linear light and is dark with both at zero. These manual optical
controls are separate from injected sensor values and do not claim measured material,
display spectral response, lux, LED output or physical-panel calibration.

See [3D changes, measurements and reproduction](MODEL_RENDERING.md).

CAD is fetched directly from Core Devices' pinned hardware repository revision
`cb50db8e68c053e7dd595188313dd54aba693bc9` and checked against these SHA-256 values. The STL
files are not redistributed by this app. The upstream README permits use for researching,
learning, coding and hacking on its devices; the app links directly to each original file.

| Product | Official file | SHA-256 |
| --- | --- | --- |
| Time 2 | `watch/Pebble Time 2 (obelix)/2026-04-08 Pebble Time 2 - 3D CAD Solid Model.STL` | `fb7c75e955e26de21611c81f73eb72bfe24a89df8b0b5064c730c88cecfa6311` |
| 2 Duo | `watch/Pebble 2 Duo (asterix)/20250918 Pebble 2 Duo - Solid model.STL` | `fa9b42bf877c0012eb3d4dd05425ae1e89f5af8d72e876446a62f3b1f23edb5a` |
| Round 2 | `watch/Pebble Round 2 (getafix)/Pebble Round 2 - External 3D CAD - 20mm.stl` | `df4be31aeb930c3ee3d2abd7ef06cc4c6e7bcbd79331e636e0ec081244b6a3d6` |

## Reproduction

`npm test` includes strict settings validation, deterministic virtual-time signals, independent
wire vectors, real App lifecycle routing, and BlobDB acknowledgment/error behavior.

`node scripts/verify-demo-firmware.mjs FIRMWARE_DIRECTORY [qemu_emery]` boots the shipped Wasm
core with actual 4.37.0 images, applies defaults, installs Clock, sends a live alert, removes
the samples, and records the actual firmware acknowledgment bytes. Without a profile argument
it runs all three profiles; the directory must contain each matching micro/SPI image pair.

`node scripts/verify-demo-browser.mjs` runs the mobile-size Chromium workflow on all three
profiles, including rendered firmware screens, settings, live alerts, pointer capture, 3D
models and demo removal. `PEBBLE_BROWSERS`, `PEBBLE_PROFILES`, `PEBBLE_SKIP_3D`,
`PEBBLE_BROWSER_URL` and `PEBBLE_TRACE_DIR` select a browser subset, targets and output path.
This is desktop-browser testing at a phone viewport, not a measured physical-phone benchmark.
