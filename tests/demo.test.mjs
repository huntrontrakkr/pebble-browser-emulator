import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  defaultDemoSettings,
  normalizeDemoSettings,
  DemoSignalStream,
} from '../src/app/demo-settings.ts';
import { demoRecords, demoKey } from '../src/app/demo-timeline.ts';

const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/demo-timeline.json', import.meta.url)),
);
test('demo defaults, bounded validation and independent copies', () => {
  const settings = defaultDemoSettings();
  assert.equal(settings.battery, 69);
  assert.deepEqual(normalizeDemoSettings(settings), settings);
  settings.calendar[0].title = 'Changed';
  assert.equal(defaultDemoSettings().calendar[0].title, 'Design review');
  for (const mutate of [
    (s) => (s.battery = 101),
    (s) => (s.battery = NaN),
    (s) => (s.bpm = 250),
    (s) => (s.latitude = 91),
    (s) => (s.longitude = Infinity),
    (s) => s.metrics.pop(),
    (s) => (s.metrics[0] = -1),
    (s) => (s.notifications[1].id = 0),
    (s) => (s.notifications[0].body = '🌍'.repeat(129)),
    (s) => (s.calendar[0].duration = 0),
    (s) => (s.calendar[0].startMinutes = 1.5),
    (s) => (s.motion = 'secret'),
    (s) => (s.enabled = 'false'),
  ]) {
    const bad = defaultDemoSettings();
    mutate(bad);
    assert.throws(() => normalizeDemoSettings(bad));
  }
  assert.equal('secret' in normalizeDemoSettings({ ...settings, secret: 'ignored' }), false);
});

test('timeline bytes match independent Python struct vectors from the firmware wire schema', () => {
  const settings = defaultDemoSettings();
  const records = demoRecords(settings, fixtures.epochMs);
  assert.deepEqual(
    records.map((r) => ({
      database: r.database,
      key: Buffer.from(r.key).toString('hex'),
      value: Buffer.from(r.value).toString('hex'),
      ...(r.dismissed ? { dismissed: Buffer.from(r.dismissed).toString('hex') } : {}),
    })),
    fixtures.records,
  );
  assert.equal(new Set(records.map((r) => Buffer.from(r.key).toString('hex'))).size, 4);
  const later = demoRecords(settings, fixtures.epochMs + 3600000);
  assert.deepEqual(later[2].key, records[2].key, 'Stable owned key prevents duplicate events');
  assert.equal(
    new DataView(later[2].value.buffer).getUint32(32, true) -
      new DataView(records[2].value.buffer).getUint32(32, true),
    3600,
  );
  const live = demoRecords(settings, fixtures.epochMs, 0);
  assert.equal(live.length, 1);
  assert.equal(live[0].dismissed, undefined, 'Live alert is not automatically archived');
  // Independently produced by libpebble2 0.0.31 Notifications.send_notification().
  const dismissAction = '0004010107004469736d697373';
  assert.equal(live[0].value[45], 1, 'Live notifications expose the standard Dismiss action');
  assert.equal(Buffer.from(live[0].value.slice(-13)).toString('hex'), dismissAction);
  assert.equal(records[2].value[45], 0, 'Calendar records do not acquire notification actions');
  settings.enabled = false;
  assert.deepEqual(demoRecords(settings, fixtures.epochMs), []);
  assert.throws(() => demoKey(1, 8));
});

test('synthetic pulse and motion use deterministic virtual deadlines and stop cleanly', () => {
  const settings = defaultDemoSettings();
  settings.motion = 'walking';
  const stream = new DemoSignalStream();
  stream.start(settings, 1000000, true);
  assert.deepEqual(stream.takeDue(999999), []);
  const events = stream.takeDue(11000000);
  assert.equal(events.filter((e) => e.signal.kind === 'heart-rate').length, 11);
  assert.equal(events.filter((e) => e.signal.kind === 'acceleration').length, 101);
  assert.equal(stream.takeDue(11000000).length, 0, 'Paused clock produces no more events');
  const other = new DemoSignalStream();
  other.start(settings, 1000000, true);
  assert.deepEqual(other.takeDue(11000000), events);
  stream.stop();
  assert.equal(stream.nextUs, Infinity);
  assert.deepEqual(stream.takeDue(1e12), []);
  settings.motion = 'stationary';
  stream.start(settings, 0, false);
  assert.deepEqual(
    stream.takeDue(1e12),
    [{ atUs: 0, signal: { kind: 'acceleration', x: 0, y: 0, z: -1000 } }],
    'Unsupported HR produces no invented readings',
  );
  assert.equal(stream.nextUs, Infinity);
});
