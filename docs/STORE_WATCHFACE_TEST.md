# Real store watchface acceptance

The fixture is **JustTheTime** by Noah Kiser / KiserDesigns, downloaded through the
[official store listing](https://apps.repebble.com/justthetime_50bdea7ee3ff48308157c046).
It is the original store PBW, including its native watchface binaries and bundled
**@rebble/clay 1.0.8** configuration script. No source rebuild or watchface-specific
emulator changes are used.

## Try it

1. On the store listing, select **DOWNLOAD PBW**.
2. Open [the emulator](https://pebble-browser-emulator.whunt003.chatgpt.site).
3. Choose Pebble Time 2, Pebble 2 Duo, or Pebble Round 2, then **Open watchface .pbw**.
4. Select the downloaded file. Default firmware loads automatically.
5. Select **App configuration**, change **Background**, and press **Save Settings**.

The package contains native `emery`, `flint`, and `gabbro` binaries, so each current
profile can use its own build. The watchface's own Clay HTML is shown inside the
source-ported companion settings screen. Its PKJS sends the settings to the actual
running firmware through AppMessage.

## Pinned artifact

- Store version: **1.2**. The PBW's internal `versionLabel` is **1.1**; this discrepancy
  is present in the original download and is not normalized by the test.
- UUID: `f77d3896-63b3-4cc4-b349-f61ac75ca168`.
- Size: **377,109 bytes**.
- SHA-256: `d0b5d7888ca05b48b629c2d315802184a0e737e57ea20c0067de95ca2e2263b4`.
- [Store download](https://appstore-api.repebble.com/api/assets/pbw/50bdea7ee3ff48308157c046/1.2/1b2bf26b-122f-43f5-842f-1f852487a16f.pbw).
- [Author's source repository](https://github.com/KiserDesigns/Pebble_JustTheTime).

The source repository did not provide a project license at the time of inspection.
The PBW and extracted source are used locally for acceptance only and are not copied
into this repository or the deployed site. Download from the author/store separately.

## Reproduction

[Recorded acceptance](evidence/store-watchface-browser.json): all three current profiles
passed on the live HTTPS site in Chromium. The background change was acknowledged by the
firmware and visible in each framebuffer. Saved settings reopened correctly, native Back
cancelled without sending new settings, and no third-party runtime requests were made.

```sh
curl -fL 'https://appstore-api.repebble.com/api/assets/pbw/50bdea7ee3ff48308157c046/1.2/1b2bf26b-122f-43f5-842f-1f852487a16f.pbw' -o /tmp/JustTheTime-1.2.pbw
PEBBLE_STORE_PBW=/tmp/JustTheTime-1.2.pbw \
PEBBLE_BROWSER_URL=https://pebble-browser-emulator.whunt003.chatgpt.site \
node scripts/verify-store-watchface-browser.mjs
```

The runner checks the package hash before loading it. Its default matrix is Chromium
with a 390 × 844 mobile viewport, DPR 2, on all three current profiles. Set
`PEBBLE_BROWSERS`, `PEBBLE_PROFILES`, and `PEBBLE_TRACE_DIR` to override the matrix/output;
without `PEBBLE_BROWSER_URL`, it targets an existing local server on port 4201.

Assertions cover original PBW installation, actual Clay controls, the white-background
AppMessage, the firmware's ACK and Clay's success callback, the resulting framebuffer
change, reopening saved settings, and native Back cancellation without another message.
No Worker responses or network requests are mocked. Screenshots and JSON are written to
the ignored trace directory. Before/after framebuffer hashes and changed-pixel counts
measure the settings effect; they are **not** an independent hardware/QEMU reference
comparison, and clock-dependent frame hashes are not fixed golden images.

This offline face does not exercise weather services, remote configuration pages,
accounts, older-platform compatibility, arbitrary source compilation, or a physical
Pixel 9. Passing this fixture does not establish universal store compatibility.
