import { build, stop as stopEsbuild } from 'esbuild-wasm';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const localCargo = join(homedir(), '.cargo/bin/cargo');
const cargo = process.env.PEBBLE_CARGO || (existsSync(localCargo) ? localCargo : 'cargo');
const result = spawnSync(
  cargo,
  [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '-p',
    'pebble-emulator-wasm',
    '-p',
    'emulator-qemu',
    '-p',
    'pebble-sifli-board',
  ],
  { stdio: 'inherit' },
);
if (result.error || result.status !== 0) {
  console.error(result.error?.message ?? 'Rust/Wasm build failed');
  process.exit(1);
}
mkdirSync('public/wasm', { recursive: true });
copyFileSync(
  'target/wasm32-unknown-unknown/release/pebble_emulator_wasm.wasm',
  'public/wasm/emulator.wasm',
);

copyFileSync(
  'target/wasm32-unknown-unknown/release/emulator_qemu.wasm',
  'public/wasm/qemu-emery.wasm',
);
copyFileSync(
  'target/wasm32-unknown-unknown/release/pebble_sifli_board.wasm',
  'public/wasm/sifli-probe.wasm',
);
copyFileSync(
  'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm',
  'public/wasm/quickjs.wasm',
);

mkdirSync('public/compiler/esbuild', { recursive: true });
copyFileSync('node_modules/esbuild-wasm/esm/browser.min.js', 'public/compiler/esbuild/browser.mjs');
copyFileSync('node_modules/esbuild-wasm/esbuild.wasm', 'public/compiler/esbuild/esbuild.wasm');

try {
  await build({
    entryPoints: ['src/app/archives.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    outfile: 'public/compiler/archive-tools.mjs',
  });
} finally {
  stopEsbuild();
}
