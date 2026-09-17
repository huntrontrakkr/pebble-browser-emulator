import test from 'node:test';
import assert from 'node:assert/strict';
import { FirmwareHarness } from './firmware-harness.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const profile = process.env.PEBBLE_PROFILE ?? 'qemu_emery';
test(
  'sensor controls reach actual app callbacks in unchanged firmware',
  { skip: !process.env.PEBBLE_SENSOR_PBW, timeout: 180000 },
  async () => {
    const h = new FirmwareHarness();
    try {
      await h.boot(profile, process.env.PEBBLE_FIRMWARE_DIR, process.env.PEBBLE_FIRMWARE_VERSION);
      await h.install(process.env.PEBBLE_SENSOR_PBW);
      await h.wait(() => h.serial.includes('SENSOR accel'));
      h.send({ type: 'health-settings', enabled: true, heartRate: profile === 'qemu_emery' });
      await h.wait((m) => m.type === 'health-settings');
      const inputs = [
        { kind: 'acceleration', x: 111, y: -222, z: -999 },
        { kind: 'compass', heading: 90, calibration: 2 },
        { kind: 'tap', axis: 2, direction: -1 },
        { kind: 'health', metric: 0, value: 1234 },
      ];
      if (profile === 'qemu_emery') inputs.push({ kind: 'heart-rate', bpm: 88, quality: 4 });
      if (profile !== 'qemu_flint') inputs.push({ kind: 'touch', down: true, x: 30, y: 40 });
      for (const signal of inputs) h.send({ type: 'signal', signal });
      await h.wait(() => h.serial.includes('SENSOR accel 111 -222 -999'), 15000);
      // Native QEMU with this unchanged release also returns unavailable through
      // compass_service_stub.c. Sending the channel cannot create an app capability.
      await h.wait(() => h.serial.includes('SENSOR compass 0 -1'), 15000);
      await h.wait(() => h.serial.includes('SENSOR tap 2 -1'), 15000);
      if (profile !== 'qemu_flint')
        await h.wait(() => h.serial.includes('SENSOR touch 0 30 40'), 15000);
      await h.wait(() => h.serial.includes('SENSOR values steps 1234'), 15000);
      if (profile === 'qemu_emery')
        await h.wait(() => h.serial.includes('steps 1234 heart 88'), 15000);
      assert.ok(
        h.controls.some((c) => c.channel === 6 && c.bytes.length === 2),
        'Firmware returned an actual acceleration response',
      );
      h.messages = [];
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && !m.state.running);
      const before = h.states.at(-1).virtualSeconds;
      if (process.env.PEBBLE_TRACE_DIR) {
        await mkdir(process.env.PEBBLE_TRACE_DIR, { recursive: true });
        await writeFile(
          process.env.PEBBLE_TRACE_DIR + '/' + profile + '-sensor-checkpoint.bin',
          h.states.at(-1).state.framebuffer,
        );
      }
      h.messages = [];
      h.send({
        type: 'scenario',
        scenario: {
          version: 1,
          name: 'deterministic',
          seed: 1,
          events: [{ atUs: 100000, signal: { kind: 'acceleration', x: 321, y: 123, z: -1000 } }],
        },
      });
      await h.wait((m) => m.type === 'state' && m.scenario.pending === 1);
      assert.equal(h.states.at(-1).virtualSeconds, before);
      h.send({ type: 'run' });
      await h.wait(() => h.serial.includes('SENSOR accel 321 123 -1000'));
      const applied = h.signals.find((s) => s.signal.x === 321 && s.stage === 'written to UART');
      assert.ok(applied.actualUs >= applied.scheduledUs);
      assert.ok(
        applied.actualUs - applied.scheduledUs < 1000,
        'Signal delivery was within 1 ms of virtual deadline',
      );
      h.messages = [];
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && !m.state.running);
      const frame = h.states.at(-1).state.framebuffer;
      assert.equal(h.states.at(-1).state.fault, '');
      if (process.env.PEBBLE_TRACE_DIR) {
        await mkdir(process.env.PEBBLE_TRACE_DIR, { recursive: true });
        await writeFile(process.env.PEBBLE_TRACE_DIR + '/' + profile + '-sensors-frame.bin', frame);
        await writeFile(
          process.env.PEBBLE_TRACE_DIR + '/' + profile + '-sensors-console.log',
          h.serial,
        );
        await writeFile(
          process.env.PEBBLE_TRACE_DIR + '/' + profile + '-sensors.json',
          JSON.stringify(
            {
              profile,
              frameHash: createHash('sha256').update(frame).digest('hex'),
              inputs,
              signals: h.signals,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      if (process.env.PEBBLE_TRACE_DIR) {
        await mkdir(process.env.PEBBLE_TRACE_DIR, { recursive: true });
        await writeFile(
          process.env.PEBBLE_TRACE_DIR + '/' + profile + '-last-console.log',
          h.serial,
        );
        await writeFile(
          process.env.PEBBLE_TRACE_DIR + '/' + profile + '-last-inputs.json',
          JSON.stringify(h.signals, null, 2),
        );
      }
      await h.close();
    }
  },
);
