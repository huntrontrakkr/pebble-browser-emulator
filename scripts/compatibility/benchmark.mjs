// Infrastructure calibration with the bundled Clock; never evaluates corpus entries.
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execute } from './supervisor.mjs';
import { pool, resources, save, json } from './common.mjs';
const out = resolve(process.argv[2] ?? 'tmp/compatibility-calibration');
await mkdir(out, { recursive: true });
const machine = await resources(),
  report = { machine, samples: [] };
for (const concurrency of [...new Set([1, Math.min(8, machine.workers), machine.workers])]) {
  const start = performance.now();
  const runs = await pool(
    Array.from({ length: concurrency }, (_, i) => i),
    concurrency,
    async (i) => {
      const job = {
        id: `clock-${concurrency}-${i}`,
        profile: 'qemu_emery',
        out: join(out, `${concurrency}-${i}`),
        pbw: resolve('public/examples/clock-emery.pbw'),
        firmwareDir: resolve('tmp/firmware-releases/v4.37.0'),
        firmwareVersion: '4.37.0',
        wasm: resolve('public/wasm/qemu-emery.wasm'),
        durationMs: 1000,
        timeoutMs: 180000,
      };
      const terminal = await execute(job),
        observation = await json(join(job.out, 'observations.json'));
      if (!observation.scenarioCompleted)
        throw Error(
          'Bundled Clock calibration did not complete: ' + JSON.stringify(observation.exception),
        );
      return { hostMs: terminal.hostMs, maxRssKiB: observation.resourceUsage.maxRSS };
    },
  );
  const hostMs = performance.now() - start;
  report.samples.push({
    concurrency,
    hostMs,
    casesPerMinute: concurrency / (hostMs / 60000),
    runs,
  });
  await save(join(out, 'benchmark.json'), report);
  console.log(JSON.stringify(report.samples.at(-1)));
}
report.selectedWorkers = report.samples.toSorted(
  (a, b) => b.casesPerMinute - a.casesPerMinute,
)[0].concurrency;
await save(join(out, 'benchmark.json'), report);
