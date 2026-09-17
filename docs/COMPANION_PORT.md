# Companion app source port

The first browser port of Core Devices' companion app covers watchface configuration.
The Angular watch workbench loads a separately built Kotlin/Wasm/Compose module on demand.
This is not an Android APK, a complete companion application, or a phone OS emulator.

## Try it

1. Open Preview and choose **Try example**.
2. Select **App configuration** beside the watch.
3. Set **Dark background**, **Show date** or **Show battery**, then **Save**.

Clock's own HTML page runs in the companion panel. The upstream Kotlin interceptor decodes
the return, Clock's own PKJS sends the settings, and the running native watchface updates
only after delivery through the existing firmware protocol. Cancel/Back closes without
sending settings. PKJS storage is now persistent across visits, scoped by application ID.
The existing session storage is read as a migration fallback. Storage failure is reported.

Configurable imported PBWs use the same flow when their metadata declares `configurable`
and includes a companion script. Developer tools can also request configuration explicitly.
Apps without a configuration page do not get a preview settings button.

The original **JustTheTime** store PBW, with its bundled **Clay 1.0.8**, also passes
configuration save, real firmware acknowledgment and frame changes on all three current
profiles. [Store test, download and reproduction](STORE_WATCHFACE_TEST.md).

## Reused upstream code

The GPL-3.0-only source is pinned at
[`333877b80baf77b11fad35520cf139a2b13ac75f`](https://github.com/coredevices/mobileapp/tree/333877b80baf77b11fad35520cf139a2b13ac75f).
`phone-app/upstream/` retains the exact screen and URL-normalization test sources, verified
against `upstream.json`. The Kotlin URL normalizer and request interceptor bodies remain
unchanged. The settings Scaffold/header is adapted to a browser host. Native DI/navigation,
the WebView factory and ConfigPageSession become explicit browser adapters.
This first slice uses Compose's default theme. Native app theme resources and independent
phone-screen pixel comparisons remain pending; sharing the screen code is not proof of
pixel-identical Android rendering.

The current upstream interceptor accepts `pebblejs://close#`, `pebblejs://close/?` and
`pebblejs://close/`, decodes once with Ktor, and treats an empty result as cancellation.
This differs from assuming every PKJS host returns the raw encoded fragment. The developer
manual-return field still delivers the exact entered string. One compatibility difference
is explicit: this browser adapter sends the existing emulator's null `webviewclosed`
cancellation event; the pinned native screen's error/back path only navigates away.

The display adapter confines Compose's canvas to the measured native header height; the
DOM WebView occupies the remaining area. This prevents Chromium from occluding the native
header when an opaque iframe overlaps a full-height WebGL surface. Density is converted to
CSS pixels; tests cover a device pixel ratio of 2. No watch framebuffer is synthesized.

## Browser adapter boundaries

- Local HTML data pages run their own code, including Clay 1.0.4. Literal close targets are
  translated to the static callback; dynamic anchor targets can be intercepted. The HTML
  doctype is retained. Local WebView storage is bounded to 1 MiB and scoped by app ID.
- Remote HTTP(S) pages receive the official `return_to` parameter. They must support it.
  Arbitrary computed `location` assignments/custom schemes cannot be intercepted universally.
  Remote pages retain normal browser network, embedding and storage restrictions.
- The configuration frame is opaque and grants only scripts/forms. It cannot access the
  emulator DOM, origin storage, top navigation or popups. Host returns require the actual
  child window, expected origin, per-page nonce, application identity and runtime generation.
- An explicit **Open in new tab** handles sites that disallow framing. The same-origin return
  page uses a session channel; it reports success only after the open session responds.
  Settings payloads stay in URL fragments and are not sent to the static hosting server.
  During local development, Chromium may block an external sandbox page's return to
  localhost under Local Network Access rules. The HTTPS hosted site avoids that local
  address-space crossing; the contract gate uses HTTPS static test origins.
  This is a static redirect, not an application backend or CORS proxy.
- Closing/replacing the app removes the module and listeners. Lost loading/request states
  time out with a visible message. Account credentials are not fabricated.

## Evidence and reproduction

`npm run build:phone` builds using the checksummed Gradle wrapper, Kotlin 2.4.10 and Compose
1.11.1. JDK 17+ is a local build dependency; no JVM runs in the browser. Full builds package
the module source, locks, notices and build scripts as `phone-app/source.zip` alongside the
binaries. [Module build instructions and license](../phone-app/README.md).

With the built site served at port 4201:

```sh
node scripts/verify-phone-app-browser.mjs
PEBBLE_CLAY_ARCHIVE=/path/pebble-clay-1.0.4.tgz node scripts/verify-phone-port-contract.mjs
```

The Clay artifact is verified against its published npm SHA-512 before execution.
[Watch/browser evidence](evidence/phone-app-browser.json) covers the real firmware ACK,
frame change, save, cancel, native Back, storage/reload, sandbox isolation and forged sender
rejection. [Compiled upstream and Clay evidence](evidence/phone-port-contract.json) covers
the original normalization cases, encoded return variants, malformed returns and actual
Clay HTML/PKJS. These are desktop Linux engines with mobile viewports, not measurements on
a Pixel 9 or exhaustive Android/iOS parity. The roughly 11 MB uncompressed companion
runtime is loaded only when needed; ordinary preview never downloads it.

## Next acceptance gates

1. Port the companion's application/session model and installed-app library screen. Adapt
   its persistent database to browser storage and validate app switching against native UI.
2. Port libpebble3's protocol/session services and adapt the actual QEMU transport to the
   existing browser worker. Compare recorded native packet exchanges before replacing the
   current bridge; no generated success acknowledgments.
3. Move applicable PKJS/configuration-session services to upstream implementations, including
   plugins, lifecycle and cancellation behavior. Keep arbitrary page/network restrictions
   explicit and test real packages with independent native results.
4. Evaluate account/app-store operations individually against browser CORS and authentication
   requirements. Android BLE, notifications/background execution and native WebView cookies
   cannot simply be assumed available in a static browser port.

The approved hardware/compiler roadmap remains unchanged. Those compatibility gates and
this companion port are separate workstreams.
