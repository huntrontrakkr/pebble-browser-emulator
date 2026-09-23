// Round 30: the first run of the browser build. Loads the linked library with the
// SQLite Wasm build and fflate the page provides, starts the phone, installs a serial
// link whose far end records what the phone sends, and asks it to connect. No watch
// answers here, so this proves startup and the transport's first frame only.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, deps] = process.argv.slice(2);
// Bare specifiers resolve from the importing file, so the imports live beside the packages.
const loader = join(deps, 'deps.mjs');
await writeFile(loader, "export { default as sqlite3InitModule } from '@sqlite.org/sqlite-wasm';\nexport * as fflate from 'fflate';\n");
const { sqlite3InitModule, fflate } = await import(pathToFileURL(resolve(loader)));
globalThis.sqlite3 = await sqlite3InitModule();
globalThis.fflate = fflate;
console.log('SQLite', globalThis.sqlite3.version.libVersion);

const entries = [];
for (const name of await readdir(dist)) {
  if (!name.endsWith('.mjs') || name.includes('uninstantiated')) continue;
  if ((await readFile(join(dist, name), 'utf8')).includes('phoneStart')) entries.push(name);
}
if (entries.length !== 1) throw new Error(`expected one entry module in ${dist}: ${entries}`);
const phone = await import(pathToFileURL(resolve(dist, entries[0])));
console.log('exports', Object.keys(phone).sort().join(', '));

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const started = phone.phoneStart();
console.log('phoneStart', started === '' ? 'ok' : started);
if (started !== '') process.exit(1);
const sent = [];
phone.phoneAttachSerial((bytes) => sent.push(hex(bytes)));
console.log('phoneConnectWatch', phone.phoneConnectWatch() || 'ok');
await new Promise((resolve) => setTimeout(resolve, 3000));
console.log('serial to watch:', sent.length ? '\n  ' + sent.join('\n  ') : 'nothing');
console.log('status:\n' + phone.phoneStatus());
process.exit(0);
