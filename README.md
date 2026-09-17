# Pebble Browser Emulator

A browser-only Pebble development utility with an Angular interface, a Rust/Wasm firmware
emulator, a Wasm ARM compiler, and an isolated PebbleKit JS phone runtime. No application
backend, remote build service, or CORS proxy.

The scope is the full Pebble watch family. **App builds cover all seven SDK platforms.**
Firmware execution currently covers the official **Flint, Emery, and Gabbro emulator boards**
for Pebble 2 Duo, Pebble Time 2, and Pebble Round 2. Older watches and physical-watch firmware
need their own board implementations. Sharing an app platform does not make firmware images
interchangeable. See the [product matrix](docs/PRODUCT_MATRIX.md) and [verified scope](docs/STATUS.md).

## Try a watchface

[Open the preview](https://pebble-browser-emulator.whunt003.chatgpt.site/#/example/clock).
Choose **Try example** or **Open watchface .pbw**. Default official emulator firmware loads
automatically, including on the first visit. Future previews reuse the saved firmware;
Developer tools can override it. No compiler is needed for the
included Clock example or a prepared PBW.

For a configurable watchface, select **App configuration** beside the watch. Clock includes
dark background, date and battery settings. Its page runs alongside the watch and saves
through PebbleKit JS and actual firmware AppMessage acknowledgments. The companion's
settings screen and navigation handler are source-ported from the real Pebble app to
Kotlin/Wasm. [Port scope and source](phone-app/README.md).

**Simulated inputs** controls battery, sensors and sample phone data. **Preferences** contains
theme, installation and offline downloads. Phone configuration opens beside the watch on
desktop and as a full-screen dialog on mobile. The production build is installable and can
save a selected watch plus its example for offline use; it also remembers the last opened PBW.
Updates wait for an explicit restart while the app is open. [Offline use and limits](docs/PWA.md).

Public GitHub projects can supply a checksummed `pebble-preview.json` for a direct preview,
or open in Developer tools for a source build. **Copy preview link** shares the selected
watch and exact project commit. See [preview setup, URL format and performance](docs/PREVIEWS.md).

## Run locally

Install Node.js 24, Rust using rustup, and JDK 17+ (`JAVA_HOME`), then:

```sh
npm ci
npm run build:wasm
npm run build:phone
npm run dev
```

For the full development workflow, open **Developer tools**:

1. In **Firmware**, find release **v4.37.0** or browse official releases. Select the watch model and download its matching QEMU micro-flash
   and SPI-flash pair, open both files, select **Load firmware**, then **Run**. First boot
   initializes the flash filesystem. PebbleOS **4.37.0** is verified on Flint, Emery and Gabbro; **4.36.0** is also verified on Emery. Reset keeps installed apps; reloading the original images clears them.
2. In **Projects**, load the included example or import a public GitHub repository. Enter
   a branch/commit and app subfolder when needed. Imports are pinned to the resolved commit.
3. Open the official **SDK 4.33.1 core archive**. Select the matching app platform, then **Build PBW**. The ARM compiler's
   approximately 94 MiB of assets are downloaded once, verified, and cached on the device.
   Supported source projects compile entirely inside a cancellable browser Worker.
4. Select **Install on watch**. The phone transfers the executable/resources through real
   firmware protocols. A packaged companion script starts in QuickJS after installation.
5. Use **Inputs**, **Phone**, **Debug**, and **Packets** to inspect execution and inject values.
   **Sensor test** loads an example for acceleration, taps, health, raw heart rate and touch.
   Generate repeatable motion, import CSV/JSON scenarios, and use **Frame comparison** under
   the watch to capture and compare exact pixels. See [sensor controls](docs/SENSORS.md).

Existing platform-matching PBWs can be opened without compiling. GitHub release and SDK downloads lack
suitable CORS headers, so those files are opened locally. Source files, the required SDK
subset, and compiler downloads stay on the device. The three default emulator image pairs
are included as static assets; imported firmware is never uploaded.

Display modes are exact monochrome/64-color pixels, an **uncalibrated** reflective preview, and a
rotatable models using official Time 2, 2 Duo and Round 2 CAD fetched from pinned upstream revisions. Light
and dark interface themes are available. Optical/material previews do not change guest pixels.

## Current build profile

SDK 4.33.1 native C projects for Aplite, Basalt, Chalk, Diorite, Emery, Flint and Gabbro;
modern `package.json` and legacy SDK 3 `appinfo.json`; PNG/PBI/raw resources; system fonts;
SDK message-key allocation; background workers; and PebbleKit JS modules.

JavaScript dependencies use integrity-checked npm `package-lock.json` v2/v3 archives.
Published Pebble JS packages use their SDK `dist.zip` artifacts. The fast compiler does not
execute build/package scripts. A separate **Linux compatibility build** runs custom recipes
in an imported container2wasm image, with local dependency files, quotas and cancellation.
Python and actual Linux ARM GCC object generation are verified. Complete SDK/Waf PBW builds,
custom fonts, native libraries and legacy environments still need acceptance coverage.
See [compiler details](docs/BROWSER_COMPILER.md) and [Linux image setup](tools/linux-build/README.md).

Firmware sources accept exact public GitHub release tags and checksummed board-specific
[bundles](docs/FIRMWARE_BUNDLES.md). Stock physical firmware execution remains unfinished.

The virtual phone supports XHR/fetch with deterministic test responses or optional direct
browser CORS requests, injectable watch metadata, and sandboxed configuration pages.
Local HTML/Clay pages return automatically; external pages must support Pebble's `return_to`
convention and browser embedding rules. Phone timers follow the watch's virtual clock and
pause with it. Location loss and recovery can be injected. The full companion app remains
unported; native account, library/store, BLE and background services are separate work.
See [phone scope](docs/PHONE.md).

## Verify

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
npm run check
```

Tests exercise the actual Rust Wasm, Worker lifecycle, archive integrity, firmware image
normalization, compiler binary formats, UART protocols, and sandboxed phone scripts. They
have separate [browser interaction gates](docs/BROWSER_TESTING.md). See `docs/STATUS.md` for the
optional official-firmware integration gate and independent reference evidence.

```sh
uv run --with unicorn==2.1.4 python scripts/verify-reference.py
```

This independent CPU comparison checks the diagnostic instruction path against Unicorn,
including all 45,600 framebuffer bytes. It does not establish complete Cortex-M33 fidelity.

## Structure

- `crates/emulator-core`, `crates/emulator-wasm`: independent diagnostic board and ABI.
- `crates/qemu-emery`: original generic board adapter, scheduler, and Wasm ABI.
- `vendor/rp2350-emu`: pinned permissive Rust Cortex-M33 dependency with documented fixes.
- `src/app`: Angular UI, emulator/phone/archive Workers, imports, protocol, and display.
- `phone-app`: GPL-3.0-only upstream Kotlin/Compose settings port and browser platform adapters.
- `public/compiler`: portable compiler worker, package builder, and licensed JS loader.
- `examples/platform-watchface`: adaptive C/PKJS demo with resources, modules, weather fixtures, location and messages.
- `examples/watchface`: unchanged original rendering reference.
- `examples/preview-clock`: precompiled preview example; outputs in `public/examples`.
- `examples/sensor-test`: sensor service callback and frame comparison example.
- `tools/linux-build`: optional local Linux/Wasm image preparation and recipe contract.
- `docs`: [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md), and evidence.

`npm run build` produces portable static files in `dist/client`. The application does not
require a server process. Hosting configuration is in `.openai/hosting.json`.

## License

Original emulator source: Apache-2.0. The separate `phone-app` module is **GPL-3.0-only**,
following its upstream license, with its corresponding source distributed alongside the
compiled module. Dependencies retain their own licenses; see
[third-party notices](THIRD_PARTY_NOTICES.md) and the
[bundled emulator firmware notice](public/firmware/v4.37.0/NOTICE.md). SDK archives and
physical-watch firmware are not committed. This is an independent project.
