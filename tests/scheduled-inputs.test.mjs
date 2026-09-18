import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDueSignals } from '../src/app/scheduled-inputs.ts';
const event = (atUs, value) => ({ atUs, signal: { kind: 'health', metric: 0, value } });
test('explicit inputs override simultaneous defaults consistently across CPU quantum boundaries', () => {
  const defaults = [event(10, 1), event(20, 2)],
    scenario = [event(10, 100), event(20, 200)],
    gesture = [event(10, 101)];
  const burst = mergeDueSignals(defaults, scenario, gesture, false);
  const split = [
    ...mergeDueSignals(defaults.slice(0, 1), scenario.slice(0, 1), gesture, false),
    ...mergeDueSignals(defaults.slice(1), scenario.slice(1), [], false),
  ];
  assert.deepEqual(burst, split);
  assert.deepEqual(
    burst.map((e) => e.signal.value),
    [1, 100, 101, 2, 200],
  );
  assert.equal(burst.at(-1).signal.value, 200);
  assert.deepEqual(
    defaults.map((e) => e.signal.value),
    [1, 2],
  );
});
test('wrist gestures suppress only demo acceleration, including their final due sample', () => {
  const accel = { atUs: 10, signal: { kind: 'acceleration', x: 0, y: 0, z: -1000 } };
  assert.deepEqual(mergeDueSignals([accel, event(10, 1)], [accel], [accel], true), [
    event(10, 1),
    accel,
    accel,
  ]);
  assert.deepEqual(mergeDueSignals([accel], [], [], false), [accel]);
});
