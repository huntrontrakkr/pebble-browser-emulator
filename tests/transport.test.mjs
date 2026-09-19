import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PebbleTransport,
  encodePebblePacket,
  encodeQemuPacket,
  stm32Crc,
  encodeAppMessage,
  decodeAppMessage,
  appMetadata,
  diagnoseFirmwareLaunch,
  formatUuid,
  parseUuid,
} from '../src/app/pebble-transport.ts';
const hex = (value) => Buffer.from(value).toString('hex');
const bytes = (value) => new Uint8Array(Buffer.from(value, 'hex'));
const uuid = '00112233-4455-6677-8899-aabbccddeeff';
const dummyHost = { writeUart: async () => {}, advance: async () => {}, nowMs: () => 0 };

test('separate raw framing and FEED/BEEF QEMU framing match official vectors', () => {
  const raw = encodePebblePacket(2001, bytes('001234567800'));
  assert.equal(hex(raw), '000607d1001234567800');
  assert.equal(hex(encodeQemuPacket(1, raw)), 'feed0001000a000607d1001234567800beef');
  assert.throws(() => encodePebblePacket(65536, new Uint8Array()), /endpoint/);
  assert.throws(() => encodeQemuPacket(1, new Uint8Array(65536)), /length/);
});
test('both nested streams accept every possible byte split and multiple frames', () => {
  const a = encodePebblePacket(2001, bytes('0112345678'));
  const b = encodePebblePacket(0x30, bytes('ff2a'));
  const raw = Buffer.concat([a, b]);
  for (let split = 0; split <= raw.length; split++) {
    const stream = Buffer.concat([
      encodeQemuPacket(1, raw.subarray(0, split)),
      encodeQemuPacket(7, bytes('01')),
      encodeQemuPacket(1, raw.subarray(split)),
    ]);
    for (let outerSplit = 0; outerSplit <= stream.length; outerSplit++) {
      const received = [],
        control = [];
      const transport = new PebbleTransport(dummyHost, {
        onPacket: (direction, p) => received.push([p.endpoint, hex(p.payload)]),
        onControl: (id, p) => control.push([id, hex(p)]),
      });
      transport.feedUart(stream.subarray(0, outerSplit));
      transport.feedUart(stream.subarray(outerSplit));
      transport.finish();
      assert.deepEqual(received, [
        [2001, '0112345678'],
        [0x30, 'ff2a'],
      ]);
      assert.deepEqual(control, [[7, '01']]);
    }
  }
});
test('truncation, wrong signatures, and wrong footer fail explicitly', () => {
  const packet = encodeQemuPacket(1, encodePebblePacket(1, bytes('55')));
  for (let i = 1; i < packet.length; i++) {
    const t = new PebbleTransport(dummyHost);
    t.feedUart(packet.subarray(0, i));
    assert.throws(() => t.finish(), /Truncated/);
  }
  for (const at of [0, packet.length - 1]) {
    const t = new PebbleTransport(dummyHost),
      broken = packet.slice();
    broken[at] ^= 1;
    assert.throws(() => t.feedUart(broken), /Invalid QEMU/);
  }
  const t = new PebbleTransport(dummyHost);
  t.feedUart(encodeQemuPacket(1, bytes('00050001aa')));
  assert.throws(() => t.finish(), /Truncated/);
});
test('all official CRC golden vectors including partial word tails', () => {
  for (const [value, expected] of [
    ['', 0xffffffff],
    ['41', 0xf743b0bb],
    ['4142', 0x695f3bf2],
    ['414243', 0x6886f4d1],
    ['41424344', 0xcf534ae1],
    ['01020304', 0x1dabe74f],
    ['313233343536373839', 0xaff19057],
  ])
    assert.equal(stm32Crc(bytes(value)), expected, value);
});
test('AppMessage exact uint32 vector, signed values, UTF8 and byte tuples', () => {
  const golden = bytes('012a00112233445566778899aabbccddeeff010403020102040078563412');
  assert.deepEqual({ ...decodeAppMessage(golden).payload }, { 16909060: 0x12345678 });
  const dict = { 0: -123, 1: 'α 🌍', 2: [0, 255, 17], 3: 0xffffffff, 4: true };
  const decoded = decodeAppMessage(encodeAppMessage(uuid, 42, dict));
  assert.equal(decoded.uuid, uuid);
  assert.deepEqual({ ...decoded.payload }, { ...dict, 4: 1 });
  assert.deepEqual(decodeAppMessage(bytes('ff2a')), { kind: 'ack', transactionId: 42 });
  assert.deepEqual(decodeAppMessage(bytes('7f2a')), { kind: 'nack', transactionId: 42 });
  assert.equal(formatUuid(parseUuid(uuid)), uuid);
});
test('malformed AppMessage values are rejected before delivery', () => {
  for (const value of [
    '',
    '01',
    '0101',
    'ff2a00',
    '012a00112233445566778899aabbccddeeff0100000000030300010203',
    '012a00112233445566778899aabbccddeeff01000000000102004142',
  ])
    assert.throws(() => decodeAppMessage(bytes(value)));
  assert.throws(() => encodeAppMessage(uuid, 1, { bad: 1 }), /numeric/);
  assert.throws(() => encodeAppMessage(uuid, 1, { 0: [256] }), /byte/);
  assert.throws(() => encodeAppMessage(uuid, 1, { 0: 'x\0y' }), /NUL/);
  assert.throws(() => encodeAppMessage(uuid, 1, { 0: 1.5 }), /integer/);
});
test('UART writes are serialized and Bluetooth/battery exact envelopes', async () => {
  const written = [];
  const t = new PebbleTransport({
    ...dummyHost,
    writeUart: async (b) => {
      await Promise.resolve();
      written.push(hex(b));
    },
  });
  await Promise.all([t.setBluetooth(true), t.setBattery(57, true), t.send(0x30, bytes('ff2a'))]);
  assert.deepEqual(written, [
    'feed0003000101beef',
    'feed000500023901beef',
    'feed0001000600020030ff2abeef',
  ]);
  assert.throws(() => t.setBattery(101, false), /battery/);
  t.dispose();
  assert.throws(() => t.send(1, new Uint8Array()), /disposed/);
});
test('response wait observes sequence marks and virtual timeout/disposal', async () => {
  let now = 0,
    t;
  const host = {
    ...dummyHost,
    nowMs: () => now,
    advance: async () => {
      now += 100;
      t.feedUart(encodeQemuPacket(1, encodePebblePacket(3, bytes('00'))));
    },
  };
  t = new PebbleTransport(host, { timeoutMs: 200 });
  t.feedUart(encodeQemuPacket(1, encodePebblePacket(3, bytes('55'))));
  assert.equal(hex((await t.waitPacket(3, () => true, 1)).payload), '00');
  await assert.rejects(t.waitPacket(4), /Timeout/);
  t.dispose();
  await assert.rejects(t.waitPacket(3), /disposed/);
});

test('launch timeout reports a firmware-derived cause when the console has one', async () => {
  assert.equal(
    diagnoseFirmwareLaunch('App image exceeds virtual size: image=32161 virtual=32020'),
    'Firmware rejected application launch: image size 32161 exceeds declared virtual size 32020.',
  );
  assert.equal(
    diagnoseFirmwareLaunch('Stack overflow [task: App <Sports>]'),
    'Application Sports overflowed its stack during launch.',
  );
  let now = 0;
  const t = new PebbleTransport(
    {
      ...dummyHost,
      nowMs: () => now,
      advance: async () => {
        now += 10;
      },
    },
    {
      timeoutMs: 20,
      diagnoseWaitFailure: (endpoint) =>
        endpoint === 0x34 ? 'Firmware failed to start application Test.' : undefined,
    },
  );
  await assert.rejects(t.waitPacket(0x34), /Firmware failed to start application Test/);
  await assert.rejects(t.waitPacket(0x35), /Timeout waiting for Pebble endpoint 0x35/);
});

test('owned BlobDB deletion uses command 4 and requires real success or missing-key status', async () => {
  for (const status of [1, 6, 7, 2]) {
    let wire;
    const t = new PebbleTransport({
      ...dummyHost,
      writeUart: async (b) => {
        wire = b;
        const payload = b.subarray(10, b.length - 2);
        t.feedUart(
          encodeQemuPacket(
            1,
            encodePebblePacket(0xb1db, Uint8Array.of(payload[1], payload[2], status)),
          ),
        );
      },
    });
    const pending = t.deleteBlob(4, parseUuid(uuid));
    if ([1, 6].includes(status)) await pending;
    else await assert.rejects(pending, /rejected deletion/);
    assert.equal(hex(wire), 'feed000100190015b1db040100041000112233445566778899aabbccddeeffbeef');
  }
});
