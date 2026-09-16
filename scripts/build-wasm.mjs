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
