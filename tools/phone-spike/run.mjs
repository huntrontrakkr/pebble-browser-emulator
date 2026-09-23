// Round 30: the first run of the browser build. Loads the linked library with the
// SQLite Wasm build and fflate the page provides, starts the phone, installs a serial
// link whose far end records what the phone sends, and asks it to connect. No watch
// answers here, so this proves startup and the transport's first frame only.
import { loadPhone } from './load.mjs';

const [dist, deps] = process.argv.slice(2);
const phone = await loadPhone(dist, deps);
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
