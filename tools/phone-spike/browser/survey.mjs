// One store app through the libpebble3 phone, for store-survey.mjs: boots the released
// qemu_emery firmware in the application's QEMU worker, starts the phone worker with the
// network on (CORS, as the session setting allows) and the built-in phone's default
// location, links them, installs the package from ?pbw= and watches the app for ?seconds=.
// With ?relay= and ?relayKey=, the phone's network may relay what the browser refuses.
// It records what the app's PebbleKit JS logged and every request and socket it made,
// as the phone worker reports them. It never answers a request itself.
// window.__result carries the outcome.
const params = new URL(location.href).searchParams;
const uuid = params.get('uuid');
const seconds = Number(params.get('seconds') ?? 60);
// The optional relay (services/resources, /v1/app-fetch) for hosts that refuse CORS.
const relay = params.get('relay')
  ? { endpoint: params.get('relay'), key: params.get('relayKey') ?? '' }
  : undefined;
const status = document.getElementById('status');
const steps = [];
const step = (text) => {
  steps.push({ at: Math.round(performance.now()), text });
  status.textContent = text;
  console.log('STEP', text);
};

const qemu = new Worker('./qemu.worker.js', { type: 'module' });
const phone = new Worker('./libpebble.worker.js', { type: 'module' });
const history = [];
const listeners = new Set();
const pkjs = [];
const network = [];
for (const [name, worker] of [
  ['qemu', qemu],
  ['phone', phone],
]) {
  worker.onmessage = ({ data }) => {
    history.push({ from: name, data });
    if (name === 'phone' && data.type === 'pkjs-console') pkjs.push(`[${data.level}] ${data.text}`);
    if (name === 'phone' && data.type === 'network-activity') network.push(data.activity);
    for (const listener of listeners) listener(name, data);
  };
}
function wait(from, predicate, timeout = 120000) {
  const earlier = history.find((m) => m.from === from && predicate(m.data));
  if (earlier) return Promise.resolve(earlier.data);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`timed out waiting for ${from}`));
    }, timeout);
    const check = (name, data) => {
      if (name !== from) return;
      if (data.type === 'failed' && predicate.id !== undefined && data.id === predicate.id) {
        clearTimeout(timer);
        listeners.delete(check);
        reject(new Error(data.message));
      } else if (predicate(data)) {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(data);
      }
    };
    listeners.add(check);
  });
}
let nextId = 1;
async function ask(message, transfer = [], timeout) {
  const id = nextId++;
  const done = (data) => data.type === 'done' && data.id === id;
  done.id = id;
  const reply = wait('phone', done, timeout);
  phone.postMessage({ ...message, id }, transfer);
  return (await reply).value;
}
const bytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

let running = false;
try {
  qemu.postMessage({ type: 'init', wasmUrl: new URL('wasm/qemu-emery.wasm', location.href).href });
  await wait('qemu', (d) => d.type === 'ready');
  qemu.postMessage({
    type: 'firmware',
    profile: 'qemu_emery',
    micro: await bytes('firmware/qemu_emery_v4.37.0_micro_flash.bin'),
    flash: await bytes('firmware/qemu_emery_v4.37.0_spi_flash.bin'),
    name: 'qemu_emery v4.37.0',
  });
  await wait('qemu', (d) => d.type === 'firmware-loaded');
  qemu.postMessage({ type: 'run' });
  qemu.postMessage({ type: 'pacing', realtime: true });
  await wait('qemu', (d) => d.type === 'firmware-ready', 180000);
  step('firmware ready');

  phone.postMessage({
    type: 'init',
    bundleUrl: new URL('libpebble3/libpebble3.js', location.href).href,
    sqliteUrl: new URL('sqlite/index.mjs', location.href).href,
    quickjsWasmUrl: new URL('quickjs.wasm', location.href).href,
    network: { mode: 'cors', ...(relay ? { relay } : {}) },
  });
  await wait('phone', (d) => d.type === 'ready' || d.type === 'failed').then((d) => {
    if (d.type === 'failed') throw new Error(d.message);
  });
  await ask({
    type: 'location',
    coordinates: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
  });
  const channel = new MessageChannel();
  qemu.postMessage({ type: 'phone-link', port: channel.port2 }, [channel.port2]);
  await wait('qemu', (d) => d.type === 'phone-link' && d.attached);
  await ask({ type: 'link', port: channel.port1, platform: 'emery' }, [channel.port1], 60000);
  step('phone connected');

  await ask(
    { type: 'install', bytes: await bytes(params.get('pbw')), name: `${uuid}.pbw` },
    [],
    120000,
  );
  step('installed');
  await wait('phone', (d) => d.type === 'running-app' && d.uuid === uuid, 90000);
  running = true;
  step('running');
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  step(`observed ${seconds} s`);
  window.__result = { ok: true, running, steps, pkjs, network };
} catch (error) {
  step(`failed: ${error.message}`);
  window.__result = { ok: false, running, error: error.message, steps, pkjs, network };
}
