# Installation and offline use

The production build includes an install manifest, icons and a versioned service worker.
It remains a static, browser-only application. On a supported browser, use
**Preferences → Install app**, or the browser's **Install app / Add to Home Screen** action.
Installation requires HTTPS (localhost is allowed for development). The exact installation
UI depends on the browser; see [MDN's installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

## What is saved

In **Preferences → Offline access**, choose a watch and select **Download for offline use**.
This saves the app shell, Wasm runtimes, that watch's official default firmware, its Clock
PBW, its matching prepared startup state, and the companion configuration module with its license/source files. The size shown
is the total for that watch; shared assets are reused when downloading another watch.
Progress and cancellation work during large downloads. Readiness requires every selected
asset to be present. It does not indicate that arbitrary firmware or applications are supported.

Once the download completes, the example can boot and its local configuration page can
save settings without a network connection. Returning to the page reopens the most recent
PBW from IndexedDB, with its selected watch profile, because by then nothing has to be
fetched to do it; **Open saved watchface** reopens it by hand when the firmware for that
profile is not stored yet. A first visit, with nothing saved, still stays idle and downloads
nothing. Local PBWs can also be imported offline.
The one saved PBW replaces the previous one; this is not a watchface library. Firmware and
app settings use their existing local stores. A pristine firmware startup checkpoint can
accelerate reopening. An active phone/watch session is not saved: reopening still installs
the selected app and applies the current demo settings.

Saving an already open local HTML/Clay form also works if the connection drops without
an offline download. Its return stays inside the sandboxed page and requires no server
callback. Opening the companion module for the first time still requires network or cache.

GitHub imports, external configuration pages, live phone network requests and upstream 3D
CAD downloads still require a connection on first use. After successful loading, each 3D
model's simplified mesh is saved in device storage for reuse, including offline; a source
or simplifier version change needs a new download. This cache is separate from the offline
package. The compiler/SDK and Linux build images have
separate import and cache requirements and are not included in this offline package.
Pixels and Reflective views need no downloaded CAD model. Browser storage can be evicted,
so retain important source files and PBWs separately.

Public catalog responses and downloaded store/release packages use a separate bounded
IndexedDB cache, whether fetched directly or through the optional service. Pinned package
links can reuse it without a catalog request. **Clear cached downloads** removes that cache
without removing saved firmware, phone settings or the last opened watchface. The optional
service itself is never required for offline operation.

**Remove offline downloads** clears the large assets in this app's service-worker cache.
It keeps the shell, saved firmware, the last PBW, app settings, and unrelated site data.
Use the browser's site-data controls to remove everything for this origin.

## Updates

An available update waits while the current app is in use. **Review update → Restart &
update** activates it and reloads the requesting tab. **Later** dismisses the notice for
the current visit. Other open emulator tabs must be closed first; a nested phone
configuration iframe is not treated as another watch session.

An update preserves watches explicitly downloaded for offline use. Unchanged assets are
copied after SHA-256 verification; changed assets must download and verify before the
update is ready. A failed update leaves the active version and its cache intact. The
browser can also activate a waiting version naturally after every app tab closes, following
the [service-worker lifecycle](https://web.dev/articles/service-worker-lifecycle).

The worker only caches files in the build's exact same-origin inventory. Size and SHA-256
checks prevent a partial deployment from mixing new files with an old build. Remote
responses and imported private projects are not put in this cache. File fingerprints detect
deployment mismatches; they are not a separate trust system for a compromised hosting origin.

## Build and verification

Use `npm run build` to build the Rust/Wasm core, Kotlin/Wasm companion, and Angular app.
`scripts/build-pwa.mjs` creates `dist/client/sw.js` from the final static assets and refuses
an incomplete build missing required runtime, icon, example or firmware files. CI builds
both runtimes before publishing its static artifact. Successful `main` builds automatically
deploy that artifact to GitHub Pages; see [hosting and releases](HOSTING.md).

The relative base URL, manifest and worker scope support a static subdirectory as well as a
domain root. Serve the complete `dist/client` directory; `sw.js` must not be given an
immutable long-lived HTTP cache policy. Registrations use `updateViaCache: 'none'`.

`npm run dev` deliberately does not register a service worker, to keep hot reload predictable.
Test the production files on localhost or HTTPS:

```sh
node --test tests/service-worker.test.mjs
node scripts/verify-pwa-browser.mjs
```

The browser verifier serves the real build under `/emulator/`, checks mobile and desktop
configuration layouts, downloads an offline watch, boots firmware offline, saves and
reopens companion settings, reopens the saved PBW, and tests a waiting update with two
tabs. Unit coverage also exercises cancellation, storage failures, corrupt downloads,
selective removal, and preservation of the old version after an update fails.

Browser-engine checks on a Linux computer do not establish physical Pixel/iPhone performance,
OS installation UX, storage persistence, or a full Safari/Android release matrix.
Chromium uses browser network-offline emulation. The local WPE WebKit 26.6 build rejects
even a minimal service-worker-only navigation in that mode, so its alternate check disables
all responses from the real static server and verifies that an uncached network probe fails.
That checks availability without the server; physical Safari offline behavior still needs
its own device test. CI runs the Chromium production-build acceptance gate.
