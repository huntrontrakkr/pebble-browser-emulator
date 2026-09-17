// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const root = resolve('phone-app');
const output = resolve('public/phone-app');
const files = {};
async function collect(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['build', '.gradle', '.kotlin'].includes(item.name)) continue;
    const name = prefix + item.name;
    if (item.isDirectory()) await collect(join(directory, item.name), name + '/');
    else files[name] = new Uint8Array(await readFile(join(directory, item.name)));
  }
}
await collect(root);
const upstream = JSON.parse(new TextDecoder().decode(files['upstream.json']));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [name, expected] of Object.entries(upstream.files)) {
  if (sha(files['upstream/' + name]) !== expected)
    throw new Error('Upstream source changed: ' + name);
}
let local = {};
try {
  local = JSON.parse(await readFile('.openai/phone-build.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const gradle = process.env.PEBBLE_GRADLE ?? local.gradle ?? join(root, 'gradlew');
const javaHome = process.env.JAVA_HOME ?? local.javaHome;
const build = spawnSync(
  'bash',
  [gradle, '-p', root, 'wasmJsBrowserDistribution', '--no-daemon', '--console=plain'],
  {
    stdio: 'inherit',
    env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) },
  },
);
if (build.error || build.status !== 0)
  throw new Error(
    'Phone build failed. Install JDK 17+ and set JAVA_HOME. ' + (build.error?.message ?? ''),
  );
await collect(root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'build/dist/wasmJs/productionExecutable'), output, { recursive: true });
await cp(join(root, 'browser'), output, { recursive: true });
for (const name of ['README.md', 'LICENSE', 'upstream.json', 'DEPENDENCIES.md'])
  await cp(join(root, name), join(output, name));
await cp(join(root, 'licenses'), join(output, 'licenses'), { recursive: true });
const archive = Object.fromEntries(
  Object.entries(files).map(([name, bytes]) => [
    'phone-app/' + name,
    [bytes, { mtime: new Date('2026-09-17T00:00:00Z') }],
  ]),
);
for (const name of ['scripts/build-phone.mjs', 'package.json', 'package-lock.json', 'LICENSE'])
  archive[name] = [new Uint8Array(await readFile(name)), { mtime: new Date('2026-09-17T00:00:00Z') }];
await writeFile(join(output, 'source.zip'), zipSync(archive, { level: 9 }));
const artifacts = {};
for (const name of await readdir(output)) {
  if (/\.(wasm|js|mjs|html|zip)$/.test(name)) {
    const bytes = await readFile(join(output, name));
    artifacts[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
}
await writeFile(
  join(output, 'build.json'),
  JSON.stringify({ upstream, artifacts }, null, 2) + '\n',
);
console.log('Built companion settings module and corresponding source archive.');
