# Pebble companion browser port

First working slice of the actual Core Devices companion app, compiled to Kotlin/Wasm with
Compose Multiplatform. This is a source port, not an Android APK or a complete phone OS.

Pinned upstream: [coredevices/mobileapp at 333877b8](https://github.com/coredevices/mobileapp/tree/333877b80baf77b11fad35520cf139a2b13ac75f).
The original files and their SHA-256 hashes are in `upstream/` and `upstream.json`.

## Implemented slice

- Settings screen Scaffold, app title and Back control from `WatchappSettingsScreen.kt`.
- The upstream URL normalizer and `SettingsRequestInterceptor` Kotlin bodies are unchanged.
  The current app decodes a returned URL once and treats empty/absent data as cancellation.
- A browser session replaces native navigation and dependency injection. A sandboxed HTML
  frame replaces the native WebView. The installed app's existing isolated QuickJS runtime
  receives the result and sends its own AppMessages to the actual watch firmware.
- The module loads only when settings are opened and is destroyed on close or app replacement.

The original screen also manages application lookup, PKJS lifetime and Android/iOS WebView
services. Those services are not ported here. `Main.kt` contains the adapted screen, while
`SettingsNavigation.kt` preserves the upstream navigation behavior. `UPSTREAM.patch` shows
the extraction/adaptation; the browser adapter is original code under the same GPL license.

## Browser limits

HTML data pages (including Clay) run their own HTML/JavaScript. Literal `pebblejs://close`
targets are translated to a fragment in the same opaque document, then returned by a
session-bound message. Saving an open local form needs no network request or callback page.
Dynamic anchor targets are also intercepted. Arbitrary
computed assignments to the browser's protected `location` object cannot be intercepted.
Remote HTTP(S) pages receive the official `return_to` parameter. A page must honor it;
hard-coded remote custom-scheme navigation cannot be observed by a browser parent.
Pages that prohibit embedding can be opened in a separate tab. Normal CSP, mixed-content,
network and browser storage restrictions still apply; no proxy is used.

The nested page has an opaque origin, scripts/forms only, and no access to the emulator DOM,
origin storage, top navigation or popups. Local HTML pages have bounded, app-scoped WebView
storage. Correlated session/request/generation checks prevent returns from replaced pages
being delivered to another app. Closing without saving returns cancellation.

Not ported: native Android/iOS runtime, account login, app library/store, Room database,
background services, real BLE, native WebView cookies, PKJS engine or the libpebble3 transport.
The existing watch/phone protocol bridge remains in use. Support is not universal.

## Build and source

Install JDK 17+ and set `JAVA_HOME`; run `npm ci` in the repository, then `npm run build:phone`.
Alternatively `cd phone-app && ./gradlew wasmJsBrowserDistribution` builds the Kotlin module.
Gradle, Kotlin, Compose and dependencies are pinned; commit both dependency lockfiles.
Gradle also verifies resolved artifact SHA-256 values in `gradle/verification-metadata.xml`.
The initial build downloads compiler dependencies; the deployed application is entirely static.

Optional machine-local `.openai/phone-build.json` accepts `javaHome` and `gradle` executable
paths. This ignored file is for local tooling only. Standard builds use the checked-in
Gradle wrapper with its distribution checksum. `PEBBLE_GRADLE` can override that wrapper.

The deployed directory provides `source.zip` with this module's source, upstream files,
build scripts, locks, patch and license, plus `build.json` with artifact hashes.
The archive includes the root npm manifest and lock: extract it, install JDK 17+, set
`JAVA_HOME`, run `npm ci`, then `npm run build:phone` to rebuild the browser distribution.
Dependency sources and notices are listed in `DEPENDENCIES.md` and `licenses/`.

This module is GPL-3.0-only, following upstream's open-source license. The repository's
Apache-2.0 license does not replace this module's license. Core Devices and the respective
upstream contributors retain their copyrights. Browser modifications: Pebble Browser
Emulator contributors, 2026. No Core Devices endorsement is implied.
