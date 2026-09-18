import { spawn } from 'node:child_process';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  save,
  json,
  inventory,
  sha,
  pool,
  resources,
  integer,
  verifyTerminals,
} from './common.mjs';
const children = new Set();
let canceled = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    canceled = true;
    for (const child of children) {
      child.kill('SIGTERM');
      child.cancellationTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    }
  });
export async function execute(
  job,
  workerScript = resolve('scripts/compatibility/capture-case.mjs'),
) {
  if (canceled) throw Error('Capture canceled.');
  await mkdir(job.out, { recursive: true });
  await save(join(job.out, 'job.json'), job);
  const stdout = await open(join(job.out, 'stdout.txt'), 'w'),
    stderr = await open(join(job.out, 'stderr.txt'), 'w');
  const started = performance.now();
  let timedOut = false,
    spawnError,
    killTimer;
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=1024', workerScript, join(job.out, 'job.json')],
    { stdio: ['ignore', stdout.fd, stderr.fd], env: { ...process.env, UV_THREADPOOL_SIZE: '1' } },
  );
  children.add(child);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  }, job.timeoutMs);
  const result = await new Promise((resolve) => {
    child.on('error', (e) => {
      spawnError = String(e);
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  clearTimeout(child.cancellationTimer);
  children.delete(child);
  await stdout.close();
  await stderr.close();
  const terminal = {
    id: job.id,
    finishedAt: new Date().toISOString(),
    hostMs: performance.now() - started,
    ...result,
    timedOut,
    canceled,
    ...(spawnError ? { spawnError } : {}),
  };
  await save(join(job.out, 'terminal.json'), terminal);
  return terminal;
}
if (process.argv[1] === resolve('scripts/compatibility/supervisor.mjs')) await capture();
async function capture() {
  const dir = resolve(process.argv[2] ?? 'tmp/compatibility-census'),
    manifest = await json(join(dir, 'manifest.json'));
  try {
    await readFile(join(dir, 'seal.json'));
    throw Error('Batch is already sealed. Use a new corpus directory.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    await readFile(join(dir, 'capture.json'));
    throw Error(
      'This directory already contains a capture attempt. Preserve it and use a new directory.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lock = await open(join(dir, 'capture.lock'), 'wx');
  await lock.close();
  try {
    const machine = await resources(),
      workers = integer(
        process.env.PEBBLE_BATCH_WORKERS,
        machine.workers,
        1,
        Math.max(1, machine.cpus),
      );
    const config = {
      format: 'pebble-compatibility-capture',
      version: 1,
      startedAt: new Date().toISOString(),
      machine,
      workers,
      durationMs: integer(process.env.PEBBLE_SCENARIO_MS, 20000, 1000, 600000),
      timeoutMs: integer(process.env.PEBBLE_HOST_TIMEOUT_MS, 300000, 5000, 3600000),
      firmwareDir: resolve(process.env.PEBBLE_FIRMWARE_DIR ?? 'tmp/firmware-releases/v4.37.0'),
      firmwareVersion: process.env.PEBBLE_FIRMWARE_VERSION ?? '4.37.0',
      wasm: resolve(process.env.PEBBLE_WASM ?? 'public/wasm/qemu-emery.wasm'),
      captureSource: await inventory('scripts/compatibility'),
      runtimeSource: await inventory('src/app'),
      node: process.version,
    };
    // Missing shared prerequisites are a batch setup failure, not 600 app failures.
    config.wasmSha256 = sha(await readFile(config.wasm));
    config.firmwareHashes = {};
    for (const profile of manifest.profiles)
      for (const part of ['micro', 'spi']) {
        const name = `${profile}_v${config.firmwareVersion}_${part}_flash.bin`;
        config.firmwareHashes[name] = sha(await readFile(join(config.firmwareDir, name)));
      }
    await save(join(dir, 'capture.json'), config);
    const jobs = manifest.entries.flatMap((entry) =>
      manifest.profiles.map((profile) => ({
        id: `${entry.id}-${profile}`,
        entryId: entry.id,
        profile,
        out: join(dir, 'cases', `${entry.id}-${profile}`),
        pbw: entry.acquisition.path ? join(dir, entry.acquisition.path) : null,
        appSha256: entry.acquisition.sha256,
        firmwareDir: config.firmwareDir,
        firmwareVersion: config.firmwareVersion,
        wasm: config.wasm,
        durationMs: config.durationMs,
        timeoutMs: config.timeoutMs,
      })),
    );
    let completed = 0;
    const started = performance.now();
    const progress = setInterval(
      () =>
        console.log(
          JSON.stringify({
            phase: 'capture',
            terminalRecords: completed,
            planned: jobs.length,
            workers,
            active: children.size,
            elapsedSeconds: Math.round((performance.now() - started) / 1000),
          }),
        ),
      15000,
    );
    let terminals;
    try {
      terminals = await pool(jobs, workers, async (job) => {
        if (canceled) throw Error('Capture canceled; batch remains unsealed.');
        const t = await execute(job);
        completed++;
        return t;
      });
    } finally {
      clearInterval(progress);
    }
    if (canceled) throw Error('Capture canceled; batch remains unsealed.');
    verifyTerminals(manifest, terminals);
    config.finishedAt = new Date().toISOString();
    config.hostMs = performance.now() - started;
    config.casesPerMinute = jobs.length / (config.hostMs / 60000);
    await save(join(dir, 'capture.json'), config);
    const files = (await inventory(dir)).filter(
      (f) => !['capture.lock', 'discovery.lock'].includes(f.path),
    );
    await save(join(dir, 'seal.json'), {
      format: 'pebble-compatibility-seal',
      version: 1,
      finishedAt: config.finishedAt,
      manifestSha256: sha(await readFile(join(dir, 'manifest.json'))),
      terminals,
      files,
    });
    console.log(
      JSON.stringify({
        phase: 'sealed',
        cases: terminals.length,
        hostMs: config.hostMs,
        casesPerMinute: config.casesPerMinute,
        artifactBytes: files.reduce((s, f) => s + f.bytes, 0),
      }),
    );
  } finally {
    await unlink(join(dir, 'capture.lock'));
  }
}
