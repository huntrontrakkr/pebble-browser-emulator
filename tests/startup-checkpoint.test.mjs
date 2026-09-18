import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  encodeStartupCheckpoint,
  decodeStartupCheckpoint,
  loadStartupCheckpoint,
} from '../src/app/startup-checkpoint.ts';
import {
  PebbleTransport,
  encodeQemuPacket,
  encodePebblePacket,
} from '../src/app/pebble-transport.ts';
const identity = {
  profile: 'qemu_emery',
  core: 'a'.repeat(64),
  micro: 'b'.repeat(64),
  flash: 'c'.repeat(64),
};
const host = { nowMs: () => 0, advance: async () => {}, writeUart: async () => {} };

test('startup containers preserve bytes and reject corrupt, truncated or incompatible identities', async () => {
  const checkpoint = {
    version: 1,
    identity,
    steps: 42,
    transport: { serial: [], spp: [], inbox: [], sequence: 0 },
    machine: Uint8Array.of(1, 2, 3, 4),
  };
  const bytes = await encodeStartupCheckpoint(checkpoint);
  assert.deepEqual(await decodeStartupCheckpoint(bytes, identity), checkpoint);
  await assert.rejects(
    decodeStartupCheckpoint(bytes, { ...identity, core: 'd'.repeat(64) }),
    /match/,
  );
  await assert.rejects(
    decodeStartupCheckpoint(bytes, { ...identity, profile: 'qemu_flint' }),
    /match/,
  );
  await assert.rejects(decodeStartupCheckpoint(bytes.subarray(0, bytes.length - 4), identity));
  const changed = bytes.slice();
  changed[Math.floor(changed.length / 2)] ^= 0x80;
  await assert.rejects(decodeStartupCheckpoint(changed, identity));
});

test('startup transport retains partial packets and rejects a phone session already in progress', async () => {
  const packets = [];
  const a = new PebbleTransport(host),
    b = new PebbleTransport(host, { onPacket: (_, packet) => packets.push(packet) });
  const envelope = encodeQemuPacket(1, encodePebblePacket(48, Uint8Array.of(1, 2, 3)));
  a.feedUart(envelope.subarray(0, 7));
  b.restoreStartup(a.startupState());
  b.feedUart(envelope.subarray(7));
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].payload, Uint8Array.of(1, 2, 3));
  await a.setBluetooth(true);
  assert.throws(() => a.startupState(), /phone session/);
  assert.throws(
    () =>
      new PebbleTransport(host).restoreStartup({ serial: [999], spp: [], inbox: [], sequence: 0 }),
    /bytes/,
  );
});

test('prepared state manifests cannot redirect checkpoint downloads to arbitrary hosts', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json({
      version: 1,
      checkpoints: [
        { identity, path: 'https://evil.example/state', sha256: 'a'.repeat(64), bytes: 3 },
      ],
    });
  });
  await assert.rejects(
    loadStartupCheckpoint(
      identity,
      'https://emulator.example/checkpoints/',
      new AbortController().signal,
    ),
    /entry/,
  );
  assert.equal(calls.length, 1);
});

test('compiled Wasm checkpoint ABI preserves guest flash, registers and continuation and rejects a wrong board atomically', async () => {
  const wasm = await readFile(new URL('../public/wasm/qemu-emery.wasm', import.meta.url));
  const a = (await WebAssembly.instantiate(wasm, {})).instance.exports;
  const b = (await WebAssembly.instantiate(wasm, {})).instance.exports;
  const code = new Uint8Array(0x118),
    v = new DataView(code.buffer);
  v.setUint32(0, 0x20080000, true);
  v.setUint32(4, 0x101, true);
  [0x4803, 0x4903, 0x6001, 0x3001, 0xe7fe].forEach((w, i) => v.setUint16(0x100 + 2 * i, w, true));
  v.setUint32(0x110, 0x10004000, true);
  v.setUint32(0x114, 0x1234abcd, true);
  const flash = new Uint8Array(32 * 1048576).fill(255);
  const p = a.spike_upload(code.length + flash.length);
  new Uint8Array(a.memory.buffer, p, code.length).set(code);
  new Uint8Array(a.memory.buffer, p + code.length, flash.length).set(flash);
  assert.equal(a.spike_boot_profile(2, code.length, flash.length), 1);
  a.spike_run(4);
  const capture = (instance) => {
    const length = instance.spike_checkpoint_save();
    const bytes = new Uint8Array(
      instance.memory.buffer,
      instance.spike_checkpoint_ptr(),
      length,
    ).slice();
    instance.spike_checkpoint_clear();
    return bytes;
  };
  const before = capture(a);
  const upload = (instance, bytes) => {
    const p = instance.spike_upload(bytes.length);
    new Uint8Array(instance.memory.buffer, p, bytes.length).set(bytes);
  };
  upload(b, before);
  assert.equal(b.spike_checkpoint_restore(2), 1);
  assert.deepEqual(capture(b), before);
  assert.equal(a.spike_run(150), b.spike_run(150));
  assert.deepEqual(capture(b), capture(a));
  const stateHash = createHash('sha256').update(capture(b)).digest('hex');
  upload(b, before);
  assert.equal(b.spike_checkpoint_restore(1), 0);
  assert.equal(createHash('sha256').update(capture(b)).digest('hex'), stateHash);
});
