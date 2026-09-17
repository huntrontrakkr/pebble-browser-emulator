import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { workload } from './core-workload.mjs';
const [baselinePath, candidatePath, assets, output, rounds = '3'] = process.argv.slice(2);
if (!output)
  throw new Error('Usage: benchmark.mjs BASELINE_WASM CANDIDATE_WASM FIRMWARE_DIR OUTPUT [ROUNDS]');
if (!Number.isInteger(Number(rounds)) || Number(rounds) < 1 || Number(rounds) > 20)
  throw new Error('ROUNDS must be an integer from 1 to 20');
const digest = (v) => createHash('sha256').update(v).digest('hex');
const modules = await Promise.all(
  [baselinePath, candidatePath].map(async (p) => WebAssembly.compile(await readFile(p))),
);
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const results = [];
for (const [index, profile] of ['qemu_flint', 'qemu_emery', 'qemu_gabbro'].entries()) {
  const micro = await readFile(resolve(assets, `${profile}_v4.37.0_micro_flash.bin`));
  const flash = await readFile(resolve(assets, `${profile}_v4.37.0_spi_flash.bin`));
  let expected;
  const samples = [];
  for (let round = -1; round < Number(rounds); round++) {
    const pair = [];
    // Alternate order, one candidate at a time; include an unscored tier-up/warm-up pair.
    for (const side of round % 2 === 0 ? [0, 1] : [1, 0]) {
      const api = (await WebAssembly.instantiate(modules[side], {})).exports;
      const result = workload(api, micro, flash, index + 1);
      const trace = digest(JSON.stringify(result.checkpoints));
      expected ??= trace;
      assert.equal(trace, expected, `${profile}: registers, ticks, frame or UART diverged`);
      pair[side] = {
        phases: result.phases,
        schedulerSteps: result.schedulerSteps,
        memoryBytes: result.memoryBytes,
        traceSha256: trace,
      };
    }
    if (round >= 0) samples.push({ baseline: pair[0], candidate: pair[1] });
  }
  const total = (sample) => sample.phases.boot + sample.phases.buttons;
  const ratios = samples.map((s) => total(s.baseline) / total(s.candidate));
  const phases = Object.fromEntries(
    ['boot', 'buttons'].map((phase) => [
      phase,
      median(samples.map((s) => s.baseline.phases[phase] / s.candidate.phases[phase])),
    ]),
  );
  results.push({
    profile,
    microSha256: digest(micro),
    flashSha256: digest(flash),
    traceSha256: expected,
    medianSpeedup: median(ratios),
    minimumPairedSpeedup: Math.min(...ratios),
    phases,
    samples,
  });
}
const report = {
  schemaVersion: 1,
  runtime: process.version,
  measuredAt: new Date().toISOString(),
  baselineSha256: digest(await readFile(baselinePath)),
  candidateSha256: digest(await readFile(candidatePath)),
  valid: true,
  score: Math.exp(results.reduce((s, r) => s + Math.log(r.medianSpeedup), 0) / results.length),
  results,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    score: report.score,
    profiles: results.map((r) => ({
      profile: r.profile,
      speedup: r.medianSpeedup,
      phases: r.phases,
    })),
  }),
);
