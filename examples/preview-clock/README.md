# Clock preview

A native watchface showing local watch time, date and battery level. It uses system fonts
and minute ticks. Its companion script supplies an embedded HTML settings page for dark
background, date and battery visibility. **App settings** opens it alongside the watch.
Saving persists PKJS settings and sends a real AppMessage; the native face applies and
persists those values. Cancel keeps the prior settings. No external network request or
additional assets are required.
Source is Apache-2.0. The included PBWs in `public/examples` are builds of this source,
not images or recordings of a watchface. They execute through actual firmware installation.

Reproduce with the local official SDK 4.33.1 and pinned compiler assets:

```sh
node scripts/verify-browser-builds.mjs \
  --sdk /path/to/sdk-core \
  --assets /path/to/microbit-clang-wasm/gen \
  --out /tmp/preview-clock \
  --example examples/preview-clock
```

The script fixes the package timestamp to 1700000000. Copy each platform's `watchface.pbw`
to `public/examples/clock-<platform>.pbw` and update the SHA-256 in `pebble-preview.json`
after rebuilding. SDK archive SHA-256 and compiler provenance are in
[`docs/BROWSER_COMPILER.md`](../../docs/BROWSER_COMPILER.md).
