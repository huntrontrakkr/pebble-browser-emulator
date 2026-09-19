// Prepare original firmware using the same compiled Rust/Wasm core shipped to browsers.
// Compare continuation against the still-running cold-boot instance before publishing.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { bundledFirmware } from '../src/app/preview-firmware.ts';
import { FIRMWARE_PROFILES } from '../src/app/watch-profiles.ts';
import { PebbleTransport, encodeQemuPacket } from '../src/app/pebble-transport.ts';
import { isWasmRunFailure } from '../src/app/wasm-abi.ts';
import {
  encodeStartupCheckpoint,
  startupIdentity,
  decodeStartupCheckpoint,
} from '../src/app/startup-checkpoint.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wasm = await readFile('public/wasm/qemu-emery.wasm');
const core = hash(wasm);
const output = resolve(process.env.PEBBLE_CHECKPOINT_OUTPUT ?? 'public/checkpoints');
const candidateManifest = process.env.PEBBLE_FIRMWARE_MANIFEST
  ? JSON.parse(await readFile(process.env.PEBBLE_FIRMWARE_MANIFEST, 'utf8'))
  : undefined;
if (candidateManifest && !output.startsWith(resolve('tmp') + '/'))
  throw new Error(
    'Candidate checkpoints must stay in tmp until provenance and independent reference review.',
  );
async function firmwareFor(profile) {
  if (!candidateManifest)
    return bundledFirmware(
      profile,
      new AbortController().signal,
      pathToFileURL(resolve('public') + '/').href,
      async (url) => new Response(await readFile(new URL(url))),
    );
  const pair = candidateManifest.profiles?.[profile];
  if (!pair) throw new Error('Candidate is missing an emulator board.');
  const parts = [];
  for (const role of ['micro', 'spi']) {
    const item = pair[role];
    if (!item || !/^[a-zA-Z0-9_.-]+\.bin$/.test(item.path))
      throw new Error('Invalid candidate image path.');
    const bytes = new Uint8Array(
      await readFile(resolve(process.env.PEBBLE_FIRMWARE_MANIFEST, '..', item.path)),
    );
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256)
      throw new Error('Candidate image checksum mismatch.');
    parts.push(bytes);
  }
  return { micro: parts[0], flash: parts[1] };
}
await mkdir(output, { recursive: true });
const checkpoints = [],
  measurements = [];
const fixedEpoch = 1789545600;
const fresh = async () => (await WebAssembly.instantiate(wasm, {})).instance.exports;
function upload(api, bytes) {
  const p = api.spike_upload(bytes.length);
  assert.ok(p);
  new Uint8Array(api.memory.buffer, p, bytes.length).set(bytes);
}
function snapshot(api) {
  const length = api.spike_checkpoint_save();
  assert.ok(length);
  const bytes = new Uint8Array(api.memory.buffer, api.spike_checkpoint_ptr(), length).slice();
  api.spike_checkpoint_clear();
  return bytes;
}
function drain(api) {
  return [0, 1, 2].map((port) => {
    const length = api.spike_uart_tx_len(port);
    const bytes = new Uint8Array(api.memory.buffer, api.spike_uart_tx_ptr(port), length).slice();
    api.spike_uart_tx_consume(port, length);
    return bytes;
  });
}
function advance(api, count) {
  const done = api.spike_run_until(count, Number.MAX_SAFE_INTEGER);
  assert.equal(isWasmRunFailure(done), false, 'Firmware bus fault');
  return done;
}
for (const profile of ['qemu_flint', 'qemu_emery', 'qemu_gabbro']) {
  const firmware = await firmwareFor(profile);
  const identity = await startupIdentity(profile, core, firmware.micro, firmware.flash);
  const api = await fresh();
  const started = performance.now();
  const p = api.spike_upload(firmware.micro.length + firmware.flash.length);
  new Uint8Array(api.memory.buffer, p, firmware.micro.length).set(firmware.micro);
  new Uint8Array(api.memory.buffer, p + firmware.micro.length, firmware.flash.length).set(
    firmware.flash,
  );
  assert.equal(
    api.spike_boot_profile(
      FIRMWARE_PROFILES[profile].id,
      firmware.micro.length,
      firmware.flash.length,
    ),
    1,
  );
  api.spike_set_epoch(fixedEpoch);
  const transport = new PebbleTransport({
    nowMs: () => api.spike_ticks() / 64000,
    advance: async () => {
      throw new Error('Unexpected phone advance');
    },
    writeUart: async () => {
      throw new Error('Unexpected phone write');
    },
  });
  let steps = 0,
    serial = '';
  const decoder = new TextDecoder();
  while (!serial.includes('Ready for communication.')) {
    assert.ok(performance.now() - started < 120000, 'Firmware boot exceeded two minutes');
    steps += advance(api, 50000);
    const ports = drain(api);
    if (ports[1].length) transport.feedUart(ports[1]);
    serial = (serial + decoder.decode(ports[2], { stream: true })).slice(-8000);
  }
  const bootMs = performance.now() - started;
  const machine = snapshot(api);
  const checkpoint = { version: 1, identity, steps, transport: transport.startupState(), machine };
  const bytes = await encodeStartupCheckpoint(checkpoint);
  const decoded = await decodeStartupCheckpoint(bytes, identity);
  assert.deepEqual(decoded.machine, machine);
  const resumed = await fresh();
  const restoreStarted = performance.now();
  upload(resumed, machine);
  assert.equal(resumed.spike_checkpoint_restore(FIRMWARE_PROFILES[profile].id), 1);
  const restoreMs = performance.now() - restoreStarted;
  assert.equal(hash(snapshot(resumed)), hash(machine), 'Entire restored state differs');
  const comparisons = [];
  // Continue the actual cold-boot instance and the restored one identically.
  for (const [index, count] of [1000, 10000, 50000].entries()) {
    if (index === 1) {
      const battery = encodeQemuPacket(5, Uint8Array.of(69, 0));
      for (const instance of [api, resumed]) {
        upload(instance, battery);
        assert.equal(instance.spike_receive_uart(1, battery.length), battery.length);
        instance.spike_button(2);
      }
    }
    assert.equal(advance(api, count), advance(resumed, count));
    const a = drain(api),
      b = drain(resumed);
    assert.deepEqual(b, a, 'UART output differs after restore');
    const stateHash = hash(snapshot(api));
    assert.equal(
      hash(snapshot(resumed)),
      stateHash,
      'Full machine continuation differs after restore',
    );
    const frame = (instance) =>
      new Uint8Array(instance.memory.buffer, instance.spike_frame(), instance.spike_frame_len());
    assert.deepEqual(frame(resumed), frame(api), 'Displayed frame differs after restore');
    comparisons.push({
      schedulerSteps: count,
      stateSha256: stateHash,
      frameSha256: hash(frame(api)),
      uartSha256: a.map(hash),
    });
  }
  // A compressed container, not an HTTP Content-Encoding. Avoid automatic .gz decoding.
  const path = `${profile}.pbcp`;
  await rm(join(output, `${profile}.pbcp.gz`), { force: true });
  await writeFile(join(output, path + '.tmp'), bytes);
  await rename(join(output, path + '.tmp'), join(output, path));
  checkpoints.push({
    identity,
    path,
    bytes: bytes.length,
    sha256: hash(bytes),
    schedulerStepsAtCapture: steps,
  });
  measurements.push({
    profile,
    coldBootMs: Math.round(bootMs),
    restoreMs: Math.round(restoreMs),
    sparseBytes: machine.length,
    compressedBytes: bytes.length,
    comparisons,
  });
  console.log(
    `${profile}: verified startup state, ${bytes.length} bytes, cold boot ${Math.round(bootMs)} ms, restore ${Math.round(restoreMs)} ms (local CPU)`,
  );
}
await writeFile(
  join(output, 'index.json.tmp'),
  JSON.stringify(
    { version: 1, firmware: candidateManifest?.version ?? 'v4.37.0', checkpoints },
    null,
    2,
  ) + '\n',
);
await rename(join(output, 'index.json.tmp'), join(output, 'index.json'));
await mkdir('tmp/startup-checkpoints', { recursive: true });
await writeFile(
  'tmp/startup-checkpoints/preparation.json',
  JSON.stringify(
    {
      coreSha256: core,
      epoch: fixedEpoch,
      scope: 'same-core cold continuation versus restore; not physical watch calibration',
      measurements,
    },
    null,
    2,
  ) + '\n',
);
