import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FirmwareHarness } from './firmware-harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  'actual firmware and QuickJS exchange a timer-driven AppMessage under the shared clock',
  { skip: !process.env.PEBBLE_REAL_WORKER, timeout: 120000 },
  async () => {
    const h = new FirmwareHarness();
    let phone;
    try {
      await h.boot('qemu_emery', process.env.PEBBLE_FIRMWARE_DIR);
      const installed = await h.install(process.env.PEBBLE_PBW);
      const generation = h.messages.find((m) => m.type === 'session').generation;
      h.messages = [];
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && !m.state.running);
      let origin = h.states.at(-1).virtualSeconds * 1e6;
      // Verify that a missing phase acknowledgement stops further guest execution.
      h.send({ type: 'phone-clock', generation, enabled: true });
      h.messages = [];
      h.send({ type: 'run' });
      const boundary = await h.wait((m) => m.type === 'clock' && m.sequence !== undefined);
      await sleep(50);
      assert.equal(h.messages.filter((m) => m.type === 'clock').length, 1);
      assert.ok(boundary.virtualUs - origin <= 10000.1);
      h.messages = [];
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && !m.state.running);
      h.send({ type: 'phone-clock-ack', generation, sequence: boundary.sequence });
      origin = boundary.virtualUs;
      phone = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
        workerData: { source: resolve('src/app/phone.worker.ts') },
      });
      const output = [];
      let fail;
      phone.on('error', (e) => (fail = e));
      phone.on('message', (m) => {
        output.push(m);
        if (m.type === 'error') fail = new Error(m.message);
        if (m.type === 'clock-ack')
          h.send({
            type: 'phone-clock-ack',
            generation: m.transportGeneration,
            sequence: m.sequence,
          });
        if (m.type === 'event' && m.event.type === 'outbound')
          h.send({
            type: 'appmessage',
            generation,
            uuid: installed.uuid,
            transactionId: m.event.transactionId,
            payload: m.event.payload,
          });
      });
      const phases = [];
      const bridge = (m) => {
        if (m.type === 'clock' && m.sequence !== undefined) {
          phases.push(m.virtualUs);
          phone.postMessage({
            type: 'clock',
            virtualUs: m.virtualUs,
            sequence: m.sequence,
            transportGeneration: m.generation,
          });
        }
        if (m.type === 'appmessage' && ['ack', 'nack'].includes(m.message.kind))
          phone.postMessage({
            type: 'ack',
            transactionId: m.message.transactionId,
            accepted: m.message.kind === 'ack',
          });
      };
      h.listeners.add(bridge);
      const wait = async (predicate) => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          if (fail) throw fail;
          if (h.failure) throw h.failure;
          const m = output.find(predicate);
          if (m) return m;
          await sleep(5);
        }
        throw new Error('Coupled phone timeout: ' + JSON.stringify(output.slice(-10)));
      };
      await wait((m) => m.type === 'harness-ready');
      phone.postMessage({
        type: 'start',
        appId: installed.uuid,
        name: 'clock.js',
        wasmUrl: pathToFileURL(resolve('public/wasm/quickjs.wasm')).href,
        clock: 'watch',
        nowMs: Math.floor(boundary.epochMs),
        virtualUs: Math.floor(origin),
        connected: true,
        randomSeed: 1,
        source: `setTimeout(()=>Pebble.sendAppMessage({0:'Shared clock'},()=>console.log('ACK'),()=>console.log('NACK')),50);setInterval(()=>console.log('TIMER'),20);`,
      });
      await wait((m) => m.type === 'status' && m.status === 'Running');
      h.send({ type: 'run' });
      await wait((m) => m.type === 'event' && m.event.text === 'ACK');
      assert.ok(phases.length > 5);
      for (let i = 1; i < phases.length; i++) assert.ok(phases[i] - phases[i - 1] <= 10000.1);
      h.messages = [];
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && !m.state.running);
      await sleep(30);
      const timers = output.filter((m) => m.event?.text === 'TIMER').length;
      await sleep(100);
      assert.equal(output.filter((m) => m.event?.text === 'TIMER').length, timers);
    } finally {
      await phone?.terminate();
      await h.close();
    }
  },
);
