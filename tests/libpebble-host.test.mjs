import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import {
  LibPebbleLink,
  asLibPebbleModule,
  provideLibPebbleDependencies,
} from '../src/app/libpebble-host.ts';

/** Stands in for the Kotlin build's exports; records what the glue does with them. */
function fakePhone({ reading = true } = {}) {
  const calls = [];
  let sink = null;
  return {
    calls,
    toWatch: (bytes) => sink?.(bytes),
    phoneStart: () => (calls.push('start'), ''),
    phoneAttachSerial: (fn) => {
      sink = fn;
      calls.push(fn ? 'attach' : 'detach');
    },
    phoneSerialFromWatch: (bytes) => (calls.push(['watch', [...bytes]]), reading),
    phoneConnectWatch: () => (calls.push('connect'), ''),
    phoneStatus: () => 'status',
  };
}
const nextMessage = (port) => new Promise((resolve) => port.once('message', resolve));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the link carries raw serial bytes both ways without interpreting them', async () => {
  const phone = fakePhone();
  const link = new LibPebbleLink(asLibPebbleModule(phone));
  const { port1: worker, port2 } = new MessageChannel();
  link.start();
  link.connect(port2);
  assert.deepEqual(phone.calls, ['start', 'attach', 'connect']);

  const out = nextMessage(worker);
  phone.toWatch(Uint8Array.of(0xfe, 0xed, 0, 3, 0, 1, 1, 0xbe, 0xef));
  assert.deepEqual([...(await out).bytes], [0xfe, 0xed, 0, 3, 0, 1, 1, 0xbe, 0xef]);

  worker.postMessage({ type: 'serial', bytes: Uint8Array.of(1, 2, 3) });
  worker.postMessage({ type: 'other', bytes: Uint8Array.of(9) });
  await settle();
  assert.deepEqual(phone.calls.at(-1), ['watch', [1, 2, 3]]);
  assert.deepEqual(link.counters, { toWatch: 9, fromWatch: 3, dropped: 0 });

  link.close();
  assert.equal(phone.calls.at(-1), 'detach');
  worker.close();
});

test('bytes no connection reads are counted as dropped, not hidden', async () => {
  const phone = fakePhone({ reading: false });
  const link = new LibPebbleLink(asLibPebbleModule(phone));
  const { port1: worker, port2 } = new MessageChannel();
  link.start();
  link.connect(port2);
  worker.postMessage({ type: 'serial', bytes: Uint8Array.of(1, 2) });
  await settle();
  assert.deepEqual(link.counters, { toWatch: 0, fromWatch: 0, dropped: 2 });
  link.close();
  worker.close();
});

test('startup failures and wrong modules are reported', () => {
  assert.throws(() => asLibPebbleModule({ phoneStart() {} }), /missing phoneAttachSerial/);
  const failing = { ...fakePhone(), phoneStart: () => 'no sqlite3' };
  assert.throws(() => new LibPebbleLink(failing).start(), /did not start: no sqlite3/);
  const link = new LibPebbleLink(fakePhone());
  assert.throws(() => link.connect(new MessageChannel().port1), /Start the phone/);
  assert.throws(() => provideLibPebbleDependencies({ sqlite3: {}, fflate: {} }), /fflate/);
  assert.throws(() => provideLibPebbleDependencies({ fflate: { inflateSync() {} } }), /SQLite/);
});
