// Compare the actual QuickJS clock/output paths, independently of firmware throughput.
import { getQuickJS } from 'quickjs-emscripten';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [baselinePath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: benchmark-phone-output.mjs BASELINE_VIRTUAL_PHONE_TS OUTPUT');
const { VirtualPhone: Baseline } = await import(pathToFileURL(resolve(baselinePath)));
const { VirtualPhone: Candidate } = await import('../../src/app/virtual-phone.ts');
const module = await getQuickJS();
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const samples = [];
function measure(Phone, payloadBytes) {
  const phone = new Phone(module, {
    appId: 'output-benchmark',
    nowMs: 0,
    storage: payloadBytes ? { data: 'x'.repeat(payloadBytes) } : {},
  });
  let snapshots = 0,
    serializedBytes = 0,
    lastStorage = '';
  const events = [],
    writes = [];
  const drain = () => {
    events.push(...phone.drainEvents());
    const values = phone.readStorageIfChanged ? phone.readStorageIfChanged() : phone.getStorage();
    if (values) {
      snapshots++;
      const serialized = JSON.stringify(values);
      serializedBytes += serialized.length;
      if (serialized !== lastStorage) writes.push(serialized);
      lastStorage = serialized;
    }
  };
  try {
    phone.start(
      `let n=0;setInterval(()=>{localStorage.setItem('counter',String(++n));console.log('tick',n)},1000);`,
    );
    const began = performance.now();
    drain();
    for (let now = 10; now <= 10000; now += 10) {
      phone.advanceTime(now);
      drain();
    }
    return { elapsedMs: performance.now() - began, snapshots, serializedBytes, events, writes };
  } finally {
    phone.dispose();
  }
}
for (const payloadBytes of [0, 1024, 65536]) {
  const sides = { baseline: [], candidate: [] };
  let expected;
  for (let round = -1; round < 5; round++) {
    for (const side of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const result = measure(side === 'baseline' ? Baseline : Candidate, payloadBytes);
      const trace = { events: result.events, writes: result.writes };
      expected ??= trace;
      assert.deepEqual(trace, expected, 'Every phone event and persisted value must match');
      if (round >= 0)
        sides[side].push({
          elapsedMs: result.elapsedMs,
          snapshots: result.snapshots,
          serializedBytes: result.serializedBytes,
        });
    }
  }
  const result = {
    payloadBytes,
    quanta: 1000,
    virtualSeconds: 10,
    outputEqual: true,
    speedup:
      median(sides.baseline.map((x) => x.elapsedMs)) /
      median(sides.candidate.map((x) => x.elapsedMs)),
    ...sides,
  };
  samples.push(result);
  console.log(JSON.stringify({ payloadBytes, speedup: result.speedup }));
}
await writeFile(
  output,
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      scope:
        'QuickJS phone clock plus output/storage polling, five alternating pairs after warm-up. Not whole-emulator FPS.',
      samples,
    },
    null,
    2,
  ) + '\n',
);
