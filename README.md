# Pebble Browser Emulator

A browser-only Pebble development utility with an Angular interface, a Rust/Wasm firmware
emulator, a Wasm ARM compiler, and an isolated PebbleKit JS phone runtime. No application
backend, remote build service, or CORS proxy.

The current target is **QEMU Emery emulator firmware**. The physical 2026 Pebble Time 2 uses
an Obelix/SiFli board that requires a separate implementation. Firmware/repository support
is measured per combination; there is no claim that every published firmware or app works.
See [compatibility and verification](docs/STATUS.md).

## Run locally

Install Node.js 24 and Rust using rustup, then:

```sh
npm ci
npm run build:wasm
npm run dev
```

1. In **Firmware**, find release **v4.37.0** or browse official releases. Download a matching QEMU Emery micro-flash
   and SPI-flash pair, open both files, select **Load firmware**, then **Run**. First boot
   initializes the flash filesystem. Full PebbleOS **4.37.0** and **4.36.0** pass the current
   app installation gate. Reset keeps installed apps; reloading the original images clears them.
2. In **Projects**, load the included example or import a public GitHub repository. Enter
   a branch/commit and app subfolder when needed. Imports are pinned to the resolved commit.
3. Open the official **SDK 4.33.1 core archive**. Select **Build PBW**. The ARM compiler's
   approximately 94 MiB of assets are downloaded once, verified, and cached on the device.
   Supported source projects compile entirely inside a cancellable browser Worker.
4. Select **Install on watch**. The phone transfers the executable/resources through real
   firmware protocols. A packaged companion script starts in QuickJS after installation.
5. Use **Inputs**, **Phone**, **Debug**, and **Packets** to inspect execution and inject values.

Existing Emery PBWs can be opened without compiling. GitHub release and SDK downloads lack
suitable CORS headers, so those files are opened locally. Source files, the required SDK
subset, and compiler downloads stay on the device. Firmware is not included or uploaded.

Display modes are exact 64-color pixels, an **uncalibrated** reflective preview, and a
rotatable model using official Time 2 CAD fetched from its pinned upstream revision. Light
and dark interface themes are available. Optical/material previews do not change guest pixels.

## Current build profile

SDK 3 native C projects targeting Emery, `package.json`, conventional SDK Waf templates,
firmware system fonts, explicitly numbered message keys, and one PKJS entry file. Custom
resources/fonts, dependency packages, background workers, C++, custom Waf, legacy layouts,
and other watch platforms currently produce explicit unsupported errors.

## Verify

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
npm run check
```

Tests exercise the actual Rust Wasm, Worker lifecycle, archive integrity, firmware image
normalization, compiler binary formats, UART protocols, and sandboxed phone scripts. They
are not a substitute for cross-browser visual testing. See `docs/STATUS.md` for the
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
- `public/compiler`: portable compiler worker, package builder, and licensed JS loader.
- `examples/watchface`: standalone C/PKJS demo with time, battery, connection, and messages.
- `docs`: [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md), and evidence.

`npm run build` produces portable static files in `dist/client`. The application does not
require a server process. Hosting configuration is in `.openai/hosting.json`.

## License

Original source: Apache-2.0. Dependencies retain their own licenses; see
[third-party notices](THIRD_PARTY_NOTICES.md). No firmware or proprietary SDK binary is
committed. This is an independent project.
