import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const localCargo = join(homedir(), '.cargo/bin/cargo');
const cargo = process.env.PEBBLE_CARGO || (existsSync(localCargo) ? localCargo : 'cargo');
const metadata = JSON.parse(
  execFileSync(
    cargo,
    [
      'metadata',
      '--locked',
      '--offline',
      '--filter-platform',
      'wasm32-unknown-unknown',
      '--format-version',
      '1',
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  ),
);
mkdirSync('public/licenses', { recursive: true });
const notices = ['Rust dependency licenses (including build-time dependencies)\n'];
for (const pkg of metadata.packages) {
  if (metadata.workspace_members.includes(pkg.id)) continue;
  const directory = dirname(pkg.manifest_path);
  const names = readdirSync(directory).filter((name) => /^(LICENSE|COPYING|NOTICE)/i.test(name));
  if (!names.length) throw new Error(`Missing license text for ${pkg.name} ${pkg.version}`);
  notices.push(`${pkg.name} ${pkg.version} — ${pkg.license || 'see license text'}\n`);
  for (const name of names)
    notices.push(`${name}\n${readFileSync(join(directory, name), 'utf8')}\n`);
}
writeFileSync('public/licenses/RUST.txt', notices.join('\n'));
copyFileSync(
  'node_modules/@jitl/quickjs-wasmfile-release-sync/LICENSE',
  'public/licenses/QUICKJS.txt',
);
copyFileSync('THIRD_PARTY_NOTICES.md', 'public/licenses/NOTICE.md');
copyFileSync('LICENSE', 'public/licenses/PROJECT.txt');
