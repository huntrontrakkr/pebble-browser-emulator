// The libpebble3 phone worker in a browser page, against the released firmware in the
// QEMU worker. Both are the application's own workers; this page only wires them
// together as the application will: QEMU's `phone-link` port to the phone's `link`.
// It then installs Clock and runs Clock's settings round trip through its PebbleKit JS,
// and last installs the network probe (network-probe.js) with the phone's network on.
// window.__result carries the outcome for tools/phone-spike/browser/run.mjs.
import { strToU8, unzipSync, zipSync } from 'fflate';

const CLOCK = 'c61ace0a-d61a-47ce-9d04-f46a78849ec6';
const status = document.getElementById('status');
const steps = [];
const step = (text) => {
  steps.push({ at: Math.round(performance.now()), text });
  status.textContent = text;
  console.log('STEP', text);
};

const qemu = new Worker('./qemu.worker.js', { type: 'module' });
const phone = new Worker('./libpebble.worker.js', { type: 'module' });
const listeners = new Set();
const history = [];
for (const [name, worker] of [
  ['qemu', qemu],
  ['phone', phone],
]) {
  worker.onmessage = ({ data }) => {
    history.push({ from: name, data });
    if (name === 'phone' && data.type === 'pkjs-console') console.log(`[${data.app}] ${data.text}`);
    if (data.type === 'error' || data.type === 'failed')
      console.log(`${name} ${data.type}: ${data.message}`);
    for (const listener of listeners) listener(name, data);
  };
  worker.onerror = (event) => console.log(`${name} worker error: ${event.message}`);
}
function wait(from, predicate, timeout = 120000) {
  const earlier = history.find((m) => m.from === from && predicate(m.data));
  if (earlier) return Promise.resolve(earlier.data);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`timed out waiting for ${from}: ${predicate}`));
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

/**
 * Clock's package with the probe's PebbleKit JS in place of Clock's own, pointed at the
 * run's server through another origin. Clock's watch binary, UUID and message keys stay;
 * the version goes up so the phone installs it over Clock.
 */
async function probePackage() {
  const files = unzipSync(await bytes('clock-emery.pbw'));
  const script = (await (await fetch('network-probe.js')).text()).replace(
    "var BASE = '__BASE__';",
    `var BASE = ${JSON.stringify(`http://localhost:${location.port}`)};`,
  );
  if (!script.includes(`localhost:${location.port}`)) throw new Error('probe base not set');
  const info = JSON.parse(new TextDecoder().decode(files['appinfo.json']));
  info.versionLabel = '1.2';
  files['appinfo.json'] = strToU8(JSON.stringify(info));
  files['pebble-js-app.js'] = strToU8(script);
  return zipSync(files);
}

try {
  step('loading the watch core');
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
  });
  await wait('phone', (d) => d.type === 'ready' || d.type === 'failed').then((d) => {
    if (d.type === 'failed') throw new Error(d.message);
  });
  step('phone started');

  const channel = new MessageChannel();
  qemu.postMessage({ type: 'phone-link', port: channel.port2 }, [channel.port2]);
  await wait('qemu', (d) => d.type === 'phone-link' && d.attached);
  await ask({ type: 'link', port: channel.port1, platform: 'emery' }, [channel.port1]);
  const first = await wait('phone', (d) => d.type === 'running-app' && d.uuid);
  step(`connected; watch running ${first.uuid}`);

  await ask(
    { type: 'install', bytes: await bytes('clock-emery.pbw'), name: 'Clock.pbw' },
    [],
    90000,
  );
  await wait('phone', (d) => d.type === 'running-app' && d.uuid === CLOCK, 60000);
  step('Clock installed and running');

  let url = '';
  for (let tries = 0; !url; tries++) {
    try {
      url = await ask({ type: 'configure' }, [], 40000);
    } catch (error) {
      if (tries >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  step(`configuration page ${url.slice(0, 40)}…`);
  const acknowledged = wait(
    'phone',
    (d) => d.type === 'pkjs-console' && d.text.includes('Clock settings acknowledged by watch'),
    30000,
  );
  const settings = { DARK_MODE: 1, SHOW_DATE: 1, SHOW_BATTERY: 0 };
  await ask({
    type: 'configuration-closed',
    url: 'pebblejs://close#' + encodeURIComponent(JSON.stringify(settings)),
  });
  await acknowledged;
  step('Clock settings acknowledged by watch');

  await ask({ type: 'network', setting: { mode: 'cors' } });
  const probeDone = wait(
    'phone',
    (d) => d.type === 'pkjs-console' && d.text.includes('PROBE done'),
    120000,
  );
  const probeAcknowledged = wait(
    'phone',
    (d) => d.type === 'pkjs-console' && d.text.includes('Network probe acknowledged by watch'),
    150000,
  );
  await ask({ type: 'install', bytes: await probePackage(), name: 'Network probe.pbw' }, [], 90000);
  step('network probe installed');
  const summary = (await probeDone).text;
  await probeAcknowledged;
  const probe = history
    .filter(
      (m) => m.from === 'phone' && m.data.type === 'pkjs-console' && m.data.text.includes('PROBE '),
    )
    .map((m) => m.data.text.slice(m.data.text.indexOf('PROBE ')));
  step(`network probe: ${summary.slice(summary.indexOf('PROBE '))}, acknowledged by watch`);
  const failures = probe.filter((line) => line.startsWith('PROBE fail'));
  window.__result = { ok: failures.length === 0, steps, probe };
} catch (error) {
  step(`failed: ${error.message}`);
  window.__result = { ok: false, error: error.message, steps };
}
