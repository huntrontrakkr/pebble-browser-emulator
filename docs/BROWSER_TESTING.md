# Browser interaction gates

The optional interaction gate uses real browser engines, the built static application,
unchanged firmware, a compiled sensor PBW and a native-QEMU frame reference. No application
objects or guest state are patched by the harness. Firmware and SDK files are supplied locally.

```sh
npx playwright install --with-deps chromium firefox webkit
npm run build
python3 -m http.server 4201 --bind 127.0.0.1 --directory dist/client
```

In another terminal, after producing the sensor example and native reference as described
in [SENSORS.md](SENSORS.md):

```sh
PEBBLE_FIRMWARE_DIR=/path/to/official/firmware \
PEBBLE_SENSOR_PBW=/path/to/emery/watchface.pbw \
PEBBLE_SENSOR_REFERENCE=tmp/native-sensor/native-frame.bin \
npm run test:browser
```

The test installs the app, enables health tracking with real preferences, injects acceleration,
tap, compass, health, heart rate and touch, waits for every rendered pixel to match the native
reference, pauses, imports the frame reference in the UI, and downloads a PBF for a second
byte/hash check. It records browser versions, page errors and external requests in
`tmp/browser-workflow`. `PEBBLE_TRACE_DIR`, `PEBBLE_BROWSER_URL` and `PEBBLE_BROWSERS` can
override the output directory, static server and comma-separated engine list.

Test against the built static application: a development server can reload it during file
edits and invalidate the running firmware session. The local HTTP server only serves files;
it does not compile projects or execute the emulator.

Chromium, Firefox and Linux WebKit engine results do not substitute for actual Edge on
Windows or Safari on macOS. Optical calibration, assistive technology and broad app/firmware
combinations remain separate gates.

With a local container2wasm image providing Python 3, the separate build UI gate checks folder
import, automatic YAML loading, actual guest execution, artifact/record export and cancellation:

```sh
PEBBLE_LINUX_IMAGE=/path/to/python-linux.wasm node scripts/verify-linux-browser.mjs
```

This gate does not establish a complete SDK/Waf build. The default output is `tmp/linux-browser`.

# Preview workflow

The separate mobile-layout gate covers first-run firmware setup, cancellation, actual Clock
PBW installation, package download, share links, firmware persistence across reload and
virtual-clock pacing. It uses desktop Linux engines with a 390×844 viewport; this is not an
actual iOS/Android device performance claim.

```sh
PEBBLE_FIRMWARE_DIR=/path/to/official/emery/images \
PEBBLE_BROWSER_URL=http://127.0.0.1:4201/ \
PEBBLE_TRACE_DIR=/tmp/preview-evidence \
node scripts/verify-preview-browser.mjs
```

`PEBBLE_BROWSERS` selects comma-separated `chromium,firefox,webkit`; the existing optional
`PEBBLE_WEBKIT_EXECUTABLE` override also applies. Serve a completed static build and do not
rebuild it while this workflow runs. The page stays entirely local for the included example.
