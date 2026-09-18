import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pool,
  verifyTerminals,
  verifySeal,
  inventory,
  save,
  sha,
  integer,
} from '../scripts/compatibility/common.mjs';
test('pool is bounded and preserves manifest ordering despite variable completion order', async () => {
  let active = 0,
    max = 0;
  const results = await pool([25, 1, 12, 2, 1], 2, async (n, i) => {
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, n));
    active--;
    return i;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(max, 2);
});
test('evaluation gate rejects missing and duplicate cases including unavailable titles', () => {
  const manifest = { profiles: ['emery', 'flint'], entries: [{ id: 'one' }, { id: 'two' }] },
    terminals = manifest.entries.flatMap((e) =>
      manifest.profiles.map((p) => ({ id: `${e.id}-${p}`, finishedAt: 'now' })),
    );
  verifyTerminals(manifest, terminals);
  assert.throws(() => verifyTerminals(manifest, terminals.slice(1)), /Incomplete/);
  assert.throws(
    () => verifyTerminals(manifest, [...terminals.slice(1), terminals[1]]),
    /Incomplete/,
  );
  assert.throws(
    () =>
      verifyTerminals(
        manifest,
        terminals.map((t) => ({ ...t, finishedAt: null })),
      ),
    /Incomplete/,
  );
});
test('sealed evidence verifies hashes and rejects changes, partial or forged terminal lists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pebble-census-'));
  try {
    await mkdir(join(dir, 'cases', 'one-emery'), { recursive: true });
    const manifest = { entries: [{ id: 'one' }], profiles: ['emery'] },
      terminal = { id: 'one-emery', finishedAt: 'now' };
    await save(join(dir, 'manifest.json'), manifest);
    await save(join(dir, 'capture.json'), {});
    await save(join(dir, 'cases', 'one-emery', 'terminal.json'), terminal);
    await writeFile(join(dir, 'cases', 'one-emery', 'console.txt'), 'original');
    await assert.rejects(verifySeal(dir));
    const seal = {
      manifestSha256: sha(await readFile(join(dir, 'manifest.json'))),
      terminals: [terminal],
      files: await inventory(dir),
    };
    await save(join(dir, 'seal.json'), seal);
    await verifySeal(dir);
    await writeFile(join(dir, 'cases', 'one-emery', 'unsealed.txt'), 'unexpected');
    await assert.rejects(verifySeal(dir), /unsealed/);
    await rm(join(dir, 'cases', 'one-emery', 'unsealed.txt'));
    await writeFile(join(dir, 'cases', 'one-emery', 'console.txt'), 'modified');
    await assert.rejects(verifySeal(dir), /changed after seal/);
    await writeFile(join(dir, 'cases', 'one-emery', 'console.txt'), 'original');
    await save(join(dir, 'seal.json'), { ...seal, terminals: [{ ...terminal, code: 0 }] });
    await assert.rejects(verifySeal(dir), /Terminal differs/);
    await save(join(dir, 'seal.json'), { ...seal, terminals: [] });
    await assert.rejects(verifySeal(dir), /Incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('resource configuration rejects unbounded values', () => {
  for (const v of [-1, 0, Infinity, 1.5, 'bad']) assert.throws(() => integer(v, 8, 1, 24));
  assert.equal(integer(undefined, 8, 1, 24), 8);
});

test('whole-batch evaluator separates package absence and companion errors and escapes metadata', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pebble-census-eval-'));
  try {
    const manifest = {
      ranking: 'test fixture',
      profiles: ['qemu_emery'],
      entries: [
        {
          id: 'one',
          title: '<script>alert(1)</script>',
          category: 'watchfaces',
          rank: 1,
          acquisition: { path: 'fixture.pbw' },
        },
        {
          id: 'two',
          title: 'Companion fixture',
          category: 'watchapps-and-companions',
          rank: 1,
          acquisition: { path: 'fixture.pbw' },
        },
      ],
    };
    const terminals = [];
    await save(join(dir, 'manifest.json'), manifest);
    await save(join(dir, 'capture.json'), {});
    for (const entry of manifest.entries) {
      const id = entry.id + '-qemu_emery',
        path = join(dir, 'cases', id);
      await mkdir(path, { recursive: true });
      const terminal = { id, finishedAt: 'now', code: 0, hostMs: 1 };
      terminals.push(terminal);
      await save(join(path, 'terminal.json'), terminal);
      await save(join(path, 'observations.json'), {
        scenarioCompleted: entry.id === 'two',
        resourceUsage: {},
        ...(entry.id === 'one'
          ? { exception: { phase: 'package', message: 'This PBW has no emery manifest.' } }
          : {}),
      });
      await writeFile(join(path, 'console.txt'), '');
      await writeFile(
        join(path, 'events.jsonl'),
        entry.id === 'two'
          ? JSON.stringify({
              type: 'phone',
              event: { type: 'error', message: 'fixture failure' },
            }) + '\n'
          : '',
      );
    }
    await save(join(dir, 'seal.json'), {
      finishedAt: 'now',
      manifestSha256: sha(await readFile(join(dir, 'manifest.json'))),
      terminals,
      files: await inventory(dir),
    });
    const run = spawnSync(process.execPath, ['scripts/compatibility/evaluate.mjs', dir], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(await readFile(join(dir, 'evaluation', 'report.json')));
    assert.deepEqual(report.counts, { 'no-compatible-binary': 1, 'companion-error-observed': 1 });
    assert.equal(report.titleCounts.completedAny, 0);
    const html = await readFile(join(dir, 'evaluation', 'index.html'), 'utf8');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    // An evaluation directory is derived output and cannot invalidate an unchanged capture seal.
    await verifySeal(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervisor kills an unresponsive worker and durably records its timeout', async () => {
  const { execute } = await import('../scripts/compatibility/supervisor.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pebble-stalled-worker-'));
  try {
    const script = join(dir, 'stall.mjs');
    await writeFile(script, "process.on('SIGTERM', () => {}); while (true) {}\n");
    const result = await execute({ id: 'stalled', out: join(dir, 'case'), timeoutMs: 200 }, script);
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(result.hostMs < 10000);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'case', 'terminal.json'))), result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('integer deadlines cannot spin at the fractional-millisecond boundaries found by the census', async () => {
  const { targetTicks } = await import('../scripts/compatibility/common.mjs');
  for (const [origin, milliseconds] of [
    [450090793, 3000],
    [400110237, 2000],
    [395298687, 3000],
  ]) {
    const oldMs = origin / 64000 + milliseconds;
    const oldStoppedTicks = Math.floor(oldMs * 64000);
    assert.ok(oldStoppedTicks / 64000 < oldMs, 'reproduces the old non-terminating comparison');
    const target = targetTicks(origin, milliseconds);
    assert.equal(target, origin + milliseconds * 64000);
    assert.ok(Number.isSafeInteger(target));
    assert.ok(target - 1 < target);
    assert.equal(target < target, false, 'new loop terminates at the exact target');
  }
  assert.throws(() => targetTicks(Number.MAX_SAFE_INTEGER, 1));
  assert.throws(() => targetTicks(1.5, 1000));
});
