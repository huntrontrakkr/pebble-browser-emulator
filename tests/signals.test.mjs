import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signalControl,
  normalizeSignal,
  normalizeScenario,
  SignalTimeline,
  motionScenario,
  accelerationCsv,
  seededRandom,
} from '../src/app/signals.ts';
import { UartWriter } from '../src/app/uart-writer.ts';

test('sensor packets match published QEMU byte order, signed samples and quality values', () => {
  assert.deepEqual(signalControl({ kind: 'acceleration', x: -1000, y: 1234, z: -32768 }), {
    channel: 6,
    payload: Uint8Array.of(1, 0xfc, 0x18, 4, 0xd2, 0x80, 0),
  });
  assert.deepEqual(signalControl({ kind: 'tap', axis: 2, direction: -1 }), {
    channel: 2,
    payload: Uint8Array.of(2, 255),
  });
  assert.deepEqual(signalControl({ kind: 'compass', heading: 90, calibration: -1 }), {
    channel: 4,
    payload: Uint8Array.of(0, 0, 0x40, 0, 255),
  });
  assert.deepEqual(signalControl({ kind: 'health', metric: 6, value: 123456 }), {
    channel: 12,
    payload: Uint8Array.of(6, 0, 1, 0xe2, 0x40),
  });
  assert.deepEqual(signalControl({ kind: 'heart-rate', bpm: 72, quality: 4 }), {
    channel: 13,
    payload: Uint8Array.of(72, 4),
  });
  assert.deepEqual(
    signalControl({ kind: 'heart-rate', bpm: 0, quality: -1 }).payload,
    Uint8Array.of(0, 255),
  );
  assert.deepEqual(
    signalControl({ kind: 'compass', heading: 360, calibration: 2 }).payload,
    Uint8Array.of(0, 0, 0, 0, 2),
  );
});
test('invalid signals cannot wrap, coerce strings, or manufacture hardware routes', () => {
  for (const signal of [
    { kind: 'acceleration', x: 32768, y: 0, z: 0 },
    { kind: 'tap', axis: 0, direction: 0 },
    { kind: 'battery', percent: 50, charging: 'yes' },
    { kind: 'compass', heading: NaN, calibration: 2 },
    { kind: 'health', metric: 7, value: 1 },
    { kind: 'heart-rate', bpm: 256, quality: 1 },
    { kind: 'heart-rate', bpm: 60, quality: 5 },
    { kind: 'gyro', x: 1, y: 2, z: 3 },
  ])
    assert.throws(() => normalizeSignal(signal));
  assert.equal(signalControl({ kind: 'touch', down: true, x: 5, y: 6 }), null);
});
test('stable event ordering, exact deadline boundaries, replacement and reset', () => {
  const a = { kind: 'tap', axis: 0, direction: 1 },
    b = { kind: 'tap', axis: 1, direction: -1 };
  const q = new SignalTimeline();
  q.load(
    {
      version: 1,
      name: 'order',
      seed: 1,
      events: [
        { atUs: 200, signal: b },
        { atUs: 100, signal: a },
        { atUs: 100, signal: b },
      ],
    },
    1000,
  );
  assert.equal(q.nextUs, 1100);
  assert.deepEqual(q.takeDue(1099), []);
  assert.deepEqual(
    q.takeDue(1100).map((e) => e.signal),
    [a, b],
  );
  assert.equal(q.pending, 1);
  assert.throws(() => q.load({ version: 2 }, 0));
  assert.equal(q.pending, 1);
  q.clear();
  assert.equal(q.nextUs, Infinity);
  assert.deepEqual(q.takeDue(99999), []);
});
test('seeded noise and timed CSV inputs are reproducible', () => {
  const options = { preset: 'walking', seconds: 3, rate: 25, seed: 17, noise: 12 };
  const a = motionScenario(options);
  assert.deepEqual(a, motionScenario(options));
  assert.notDeepEqual(a, motionScenario({ ...options, seed: 18 }));
  assert.equal(a.events.length, 75);
  assert.equal(a.events[1].atUs, 40000);
  assert.deepEqual(
    accelerationCsv('time_ms,x_mg,y_mg,z_mg\n0,0,0,-1000\n1.25,-10,20,30').events[1],
    { atUs: 1250, signal: { kind: 'acceleration', x: -10, y: 20, z: 30 } },
  );
  assert.throws(() => accelerationCsv('time_ms,x_mg,y_mg,z_mg\n0,,0,1'));
  assert.throws(() =>
    normalizeScenario({
      version: 1,
      name: 'bad',
      seed: 1,
      events: [{ atUs: -1, signal: a.events[0].signal }],
    }),
  );
});
test('UART queues preserve whole envelopes through backpressure and clear without callbacks', () => {
  const q = new UartWriter(),
    received = [],
    finished = [];
  q.enqueue(Uint8Array.of(1, 2, 3), () => finished.push(1));
  q.enqueue(Uint8Array.of(4, 5), () => finished.push(2));
  q.flush((b) => {
    received.push(...b.subarray(0, 1));
    return 1;
  });
  assert.deepEqual(received, [1]);
  assert.deepEqual(finished, []);
  q.flush((b) => {
    received.push(...b);
    return b.length;
  });
  assert.deepEqual(received, [1, 2, 3, 4, 5]);
  assert.deepEqual(finished, [1, 2]);
  assert.equal(q.pending, false);
  q.enqueue(Uint8Array.of(6), () => finished.push(3));
  q.clear();
  assert.deepEqual(finished, [1, 2]);
});
