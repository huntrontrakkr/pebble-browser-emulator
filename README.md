# Pebble Browser Emulator

A browser-only Pebble emulator and development workbench using **Angular and Rust/WebAssembly**.

**Early development foundation. This does not boot PebbleOS or run Pebble watchfaces yet.**
The current `diagnostic-v1` board executes a small real ARM Thumb program, exposes its CPU
registers, and renders bytes written by that program into a 200×228 framebuffer. It is not
an approximation presented as a completed watch emulator.

## Run locally

Install Node.js 24 and Rust using rustup. The checked-in Rust toolchain configuration includes
the Wasm target. Then:

```sh
npm ci
npm run build:wasm
npm run dev
```

Open the development URL, select **Load diagnostic**, then **Run**. Inspect registers,
step/reset execution, save/restore state, inject diagnostic inputs, and encode a Pebble Ping
packet. The color diagnostic does not read the input registers. Packet encoding does not
send traffic to a watch. Saved snapshots currently last only for this browser session.

## Verify

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
npm run check
```

`npm run check` builds the Rust Wasm, tests its actual binary and Worker contract, and creates
the static Angular build in `dist/client`. There is no server component or application backend.
The Node Worker transport test is not browser rendering validation.

For an independent CPU comparison (optional Python tooling):

```sh
uv run --with unicorn==2.1.4 python scripts/verify-reference.py
```

This executes the same image in Unicorn's ARM M-class emulator, comparing instruction count,
registers, and every framebuffer byte against our compiled Wasm. It validates only the
executed diagnostic instruction path, not complete ARM/Pebble compatibility.

## Project layout

- `crates/emulator-core`: original CPU diagnostic, memory/framebuffer, snapshots, packet framing.
- `crates/emulator-wasm`: small versioned ABI; no host imports.
- `src/app`: Angular workbench and dedicated emulator Worker.
- `examples/watchface`: standalone Pebble demo source for the future build/install pipeline.
- `docs`: [current status](docs/STATUS.md), [architecture](docs/ARCHITECTURE.md),
  [approved roadmap](docs/ROADMAP.md), and [research/provenance](docs/RESEARCH.md).

## Next acceptance gate

Run unchanged `qemu_emery` firmware on a Rust Armv8-M implementation and compare it with
native QEMU. This requires substantially more CPU/system/peripheral implementation.
The actual Time 2 uses a separate Obelix/SiFli board; emulator-firmware support will not be
presented as production hardware fidelity. Browser compilation and the virtual phone follow
as separate measured milestones.

A Sites project is reserved in `.openai/hosting.json`. Public application release is deferred
until the first useful firmware/watchface workflow passes its gate; a diagnostic foundation
is not advertised as the completed emulator.

## License

Original source: Apache-2.0. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
No Pebble firmware or proprietary SDK binaries are included. This is an independent project.
