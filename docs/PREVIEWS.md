# Watchface previews and links

The default workspace is **Preview**. Choose a watch, then **Try example**, **Open
watchface .pbw**, or expand **Open from GitHub** and enter a public repository.
Developer tools remain available
for source builds, firmware changes, inputs, the virtual phone, packets and frame checks.

## Firmware setup

Preview automatically loads the bundled official 4.37.0 emulator firmware on first
use. No firmware file picker is required. The selected model's two images download
from the same static site, expand with a bounded streaming gzip decoder, and must
match their exact sizes and official SHA-256 digests before boot. Time 2 downloads
about 1.52 MB compressed; its original 32 MiB SPI image is unchanged after expansion.
No firmware download or Worker starts on the idle page.

After checksum verification, the images are stored locally in IndexedDB (Blobs, with a typed-array
fallback for WebKit). A saved firmware pair takes precedence over the bundled default.
If a download fails, **Retry default firmware** and manual file import remain available.
Cancellation stops the stream and prevents an abandoned preview from launching.

Firmware loaded through Developer tools becomes the saved default for its profile.
Choose another version there to override it. These are original firmware images, not
full running-machine snapshots: the guest still boots on each page load. Reset keeps
the current session's flash; a new preview session starts from the saved image pair.
Clearing saved files or browser site data removes the stored firmware too.

The bundled emulator images have a pinned source/component review, original release
hashes, licenses and corresponding-source links in
[their notice](../public/firmware/v4.37.0/NOTICE.md). The QEMU configurations exclude
the physical-device vendor blobs. This does not establish redistribution rights for
all firmware. GitHub release-asset and SDK downloads still lack browser CORS permission;
other versions and the SDK use manual import. There is no proxy. Storage denial is
reported and does not prevent the current session from running.

## Shareable URLs

Hash routes work on a static host without server route rewriting, including when hosted
inside a subdirectory:

```text
https://pebble-browser-emulator.whunt003.chatgpt.site/#/example/clock
https://pebble-browser-emulator.whunt003.chatgpt.site/#/github/owner/repository
https://pebble-browser-emulator.whunt003.chatgpt.site/#/github/owner/repository?ref=main&path=watchface&watch=qemu_flint
```

`watch` is `qemu_emery` (default), `qemu_flint`, or `qemu_gabbro`. `ref` accepts a
branch, tag or commit; `path` selects the project folder. Values must be URL encoded.
The loader resolves the reference to a commit before fetching files. **Copy preview
link** then shares that exact commit, so a moving branch does not silently change the
shared example. **Download PBW** saves the actual package that was selected.

### Prepared previews

Place a `pebble-preview.json` in the selected project folder and commit the PBWs it
names. A prepared package avoids downloading a compiler on a visitor's phone:

```json
{
  "version": 1,
  "packages": {
    "emery": {
      "path": "preview/watchface.pbw",
      "sha256": "REPLACE_WITH_THE_64_CHARACTER_LOWERCASE_SHA256"
    }
  }
}
```

Optional `flint` and `gabbro` entries follow the same shape. Paths are relative to the
project folder and cannot traverse directories or point to other hosts. The loader
checks the hash before handing the package to the emulator; the installer checks its
platform and package metadata. Packages are limited to 8 MiB and manifests to 16 KiB.
Repository text is data; preview manifests cannot execute build commands.

For a repository with an existing committed PBW, `&pbw=preview/watchface.pbw` selects
that artifact directly. It is still pinned to the resolved Git commit; a manifest adds
an explicit content checksum. GitHub release attachments cannot be used here because
of their CORS restrictions. Publish a committed PBW or open a downloaded package locally.

This repository's root manifest is a complete working example. Its public preview is
`#/github/huntrontrakkr/pebble-browser-emulator`.

### Source-only projects

When there is no preview manifest or explicit PBW path, the project is imported into
Developer tools. A saved SDK starts the existing browser build automatically. Otherwise
the panel asks for SDK 4.33.1 and resumes after it is opened. Successful builds return
to Preview for automatic firmware loading and installation. The same compiler limits apply: custom
fonts, arbitrary SDK/Waf environments and unsupported dependencies still need the
separate compatibility work described in [STATUS](STATUS.md). A URL does not make an
unsupported project buildable. Network imports and builds are cancellable.

## Phone performance

- No emulator, compiler, sensor panel or developer workbench starts on the idle preview page.
- Clock is a small precompiled native app with no phone script or compiler download.
- Screen snapshots are limited to 30 per second; unchanged displays report state at 4 Hz.
  Explicit pause/step/input snapshots remain immediate. The CPU and sensor timelines still
  execute; presentation does not skip guest instructions.
- Phone clock acknowledgments still run at their original boundaries but no longer update
  Angular's displayed elapsed-time signal on every message.
- Preview execution is paced to the virtual clock after boot. It can run slower on a device
  that cannot keep up. This is not calibration to physical hardware cycles. Developer firmware
  loads retain unrestricted execution for existing test workflows.
- Preview execution pauses when the page becomes hidden and resumes when visible. An ongoing
  installation is allowed to finish. The optional 3D view redraws on changes and stops when hidden.
- Firmware startup reuses the upload allocation for SPI storage and avoids an extra JavaScript
  concatenation buffer. On the verified Emery pair the Wasm memory after boot decreased from
  109,576,192 to 42,336,256 bytes. This measures linear memory, not whole-browser RAM or phone FPS.

Browser evidence uses desktop Linux engines at a phone-sized viewport. Actual phone model,
thermal conditions, browser memory pressure and CPU throughput require device measurements.
