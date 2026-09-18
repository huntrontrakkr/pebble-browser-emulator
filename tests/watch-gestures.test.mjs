import assert from 'node:assert/strict';
import test from 'node:test';
import { wristShake, screenPoint } from '../src/app/watch-gestures.ts';
import { normalizeScenario, SignalTimeline } from '../src/app/signals.ts';

test('wrist shake is deterministic, bounded and finishes at rest on virtual time', () => {
  const value = normalizeScenario(wristShake());
  assert.deepEqual(value, wristShake());
  const queue = new SignalTimeline();
  queue.load(value, 1000000);
  assert.deepEqual(queue.takeDue(999999), []);
  const first = queue.takeDue(1000000);
  assert.deepEqual(first[0].signal, { kind: 'acceleration', x: 0, y: 0, z: -1000 });
  assert.equal(queue.takeDue(1000000).length, 0);
  const remaining = queue.takeDue(1600000);
  assert.equal(queue.pending, 0);
  assert.deepEqual(remaining.at(-1).signal, { kind: 'acceleration', x: 0, y: 0, z: -1000 });
  assert.equal(remaining.filter((e) => e.signal.kind === 'tap').length, 1);
  assert.ok(remaining.some((e) => e.signal.kind === 'acceleration' && e.signal.x > 1000));
  assert.ok(remaining.some((e) => e.signal.kind === 'acceleration' && e.signal.x < -1000));
});
test('screen coordinates handle scaling, edges and round-display corners', () => {
  const rect = { width: 200, height: 228, round: false };
  assert.deepEqual(screenPoint(0.5, 0.5, rect), { x: 100, y: 114 });
  assert.deepEqual(screenPoint(1, 1, rect), { x: 199, y: 227 });
  for (const [x, y] of [
    [-0.01, 0.5],
    [1.01, 0.5],
    [0.5, -1],
    [NaN, 0.5],
    [0.5, Infinity],
  ])
    assert.equal(screenPoint(x, y, rect), null);
  const round = { width: 260, height: 260, round: true };
  assert.equal(screenPoint(0, 0, round), null);
  assert.deepEqual(screenPoint(0, 0.5, round), { x: 0, y: 130 });
  assert.deepEqual(screenPoint(0.5, 1, round), { x: 130, y: 259 });
});
