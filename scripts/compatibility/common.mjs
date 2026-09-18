import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
export async function save(p, value) {
  await writeFile(p + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await rename(p + '.tmp', p);
}
export function integer(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return n;
}
export async function pool(items, concurrency, work) {
  let next = 0;
  const result = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        result[i] = await work(items[i], i);
      }
    }),
  );
  return result;
}
export async function resources() {
  let cpus = os.availableParallelism(),
    memory = os.freemem();
  try {
    const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(' ');
    if (quota !== 'max')
      cpus = Math.min(cpus, Math.max(1, Math.floor(Number(quota) / Number(period))));
  } catch {}
  try {
    const max = Number((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim());
    const used = Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8'));
    if (Number.isFinite(max)) memory = Math.min(memory, max - used);
  } catch {}
  return {
    cpus,
    availableMemoryBytes: memory,
    totalMemoryBytes: os.totalmem(),
    model: os.cpus()[0]?.model,
    workers: Math.max(
      1,
      Math.min(24, cpus - 4, Math.floor((memory - 4 * 2 ** 30) / (2 * 2 ** 30))),
    ),
  };
}
export async function inventory(dir, prefix = '') {
  const result = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const path = join(prefix, name),
      info = await stat(join(dir, path));
    if (info.isDirectory()) result.push(...(await inventory(dir, path)));
    else result.push({ path, bytes: info.size, sha256: sha(await readFile(join(dir, path))) });
  }
  return result;
}
export function verifyTerminals(manifest, terminals) {
  const wanted = manifest.entries
    .flatMap((e) => manifest.profiles.map((p) => `${e.id}-${p}`))
    .sort();
  const actual = terminals.map((t) => t.id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted) || terminals.some((t) => !t.finishedAt))
    throw new Error(
      'Incomplete batch: every planned case must have exactly one terminal record before evaluation.',
    );
}
export async function verifySeal(dir) {
  const manifest = await json(join(dir, 'manifest.json')),
    seal = await json(join(dir, 'seal.json'));
  if (seal.manifestSha256 !== sha(await readFile(join(dir, 'manifest.json'))))
    throw new Error('Manifest changed after capture.');
  verifyTerminals(manifest, seal.terminals);
  for (const file of seal.files) {
    if (file.path.startsWith('/') || file.path.split('/').includes('..'))
      throw new Error('Unsafe seal path.');
    const bytes = await readFile(join(dir, file.path));
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
      throw new Error('Capture changed after seal: ' + file.path);
  }
  const paths = [];
  async function walk(prefix = '') {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const path = join(prefix, entry.name);
      if (
        !prefix &&
        ['evaluation', 'seal.json', 'capture.lock', 'discovery.lock'].includes(entry.name)
      )
        continue;
      if (entry.isDirectory()) await walk(path);
      else paths.push(path);
    }
  }
  await walk();
  if (JSON.stringify(paths.sort()) !== JSON.stringify(seal.files.map((f) => f.path).sort()))
    throw new Error('Capture contains unsealed, missing or duplicate artifact paths.');
  const needed = [
    'manifest.json',
    'capture.json',
    ...seal.terminals.map((t) => `cases/${t.id}/terminal.json`),
  ];
  if (needed.some((path) => !seal.files.some((f) => f.path === path)))
    throw new Error('Seal lacks required records.');
  for (const terminal of seal.terminals)
    if (
      JSON.stringify(await json(join(dir, 'cases', terminal.id, 'terminal.json'))) !==
      JSON.stringify(terminal)
    )
      throw new Error('Terminal differs from seal.');
  return { manifest, seal };
}

// Never round-trip a tick deadline through floating point milliseconds.
export function targetTicks(originTicks, durationMs) {
  const ticks = originTicks + durationMs * 64000;
  if (
    ![originTicks, durationMs, ticks].every(Number.isSafeInteger) ||
    originTicks < 0 ||
    durationMs < 0
  )
    throw new Error('Invalid virtual tick deadline.');
  return ticks;
}
