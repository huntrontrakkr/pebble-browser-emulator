These scripts run from the repository root and have no fixed machine paths.

Run the real browser Wasm compiler plus real browser esbuild, using a locally extracted official SDK and previously downloaded pinned compiler assets:

```sh
node scripts/verify-browser-builds.mjs \
  --sdk "$PEBBLE_SDK_DIR" \
  --assets "$PEBBLE_COMPILER_ASSET_DIR" \
  --out "$PEBBLE_EVIDENCE_DIR" \
  --example examples/platform-watchface
```

`--platform emery` selects one target. Without it, every declared target is compiled. `--repo /path/to/repo` is available when invoking from another directory. Node24+ is required. Output includes actual ELF/PBW bytes, expanded package contents, source hashes, PBW hashes and build sizes. Build timestamp is fixed1700000000 for repeatability. The compiler assets directory must contain llvm.core.wasm, llvm.core2.wasm, llvm.core3.wasm, llvm.core4.wasm and llvm-resources.tar from the application's pinned microbit-clang-wasm release; no native compiler or native esbuild process is used.

Regenerate all31 original image fixture goldens and four resource pack fixtures by running the official SDK Python tools locally:

```sh
uv run --with pypng==0.20220715.0 python scripts/regenerate-resource-goldens.py \
  --sdk "$PEBBLE_SDK_DIR" \
  --output tests/fixtures/resources
```

Goldens are deterministic and SDK-free to test after generation. The generator reproduces the delivered `goldens.json` exactly. No full SDK/firmware/libpebble files should be committed; only original image fixtures, SDK format output for those fixtures and scripts are included.

Regenerate metadata/key goldens from the unchanged SDK functions:

```sh
python scripts/regenerate-metadata-goldens.py --sdk "$PEBBLE_SDK_DIR" --output tests/fixtures/resources
```
