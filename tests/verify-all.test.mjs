import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

async function fixture(t, scripts) {
  const cwd = await mkdtemp(join(tmpdir(), 'pebble-verify-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'scripts'));
  await mkdir(join(cwd, 'dist/client'), { recursive: true });
  await writeFile(join(cwd, 'dist/client/index.html'), 'test application');
  await copyFile(
    new URL('../scripts/verify-all.mjs', import.meta.url),
    join(cwd, 'scripts/verify-all.mjs'),
  );
  for (const [name, source] of Object.entries(scripts))
    await writeFile(join(cwd, 'scripts', name + '.mjs'), source);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, PEBBLE_VERIFY_PORT: String(port) };
  delete env.PEBBLE_BROWSER_URL;
  delete env.PEBBLE_CLAY_ARCHIVE;
  delete env.PEBBLE_RESOURCE_SERVICE;
  return {
    cwd,
    env,
    run: () => exec(process.execPath, ['scripts/verify-all.mjs'], { cwd, env, timeout: 10000 }),
    results: async () =>
      JSON.parse(await readFile(join(cwd, 'tmp/verify-all/results.json'), 'utf8')),
  };
}

test('suite reports missing Clay and download-service prerequisites without launching gates', async (t) => {
  const f = await fixture(t, {
    'verify-phone-port-contract': 'throw new Error("must not launch without Clay");',
    'verify-resource-service-browser': 'throw new Error("must not launch without service");',
  });
  await f.run();
  const results = await f.results();
  assert.deepEqual(
    results.map((r) => r.state),
    ['skipped', 'skipped'],
  );
  assert.match(results[0].detail, /PEBBLE_CLAY_ARCHIVE/);
  assert.match(results[1].detail, /PEBBLE_RESOURCE_SERVICE/);
});

test('configured gates run and receive the suite server URL on a custom port', async (t) => {
  const f = await fixture(t, {
    'verify-phone-port-contract': `
      import assert from 'node:assert/strict';
      assert.equal(process.env.PEBBLE_CLAY_ARCHIVE, 'fixture.tgz');
      assert.equal(await (await fetch(process.env.PEBBLE_BROWSER_URL)).text(), 'test application');
    `,
    'verify-resource-service-browser': `
      import assert from 'node:assert/strict';
      assert.equal(process.env.PEBBLE_RESOURCE_SERVICE, 'http://127.0.0.1:4318');
    `,
  });
  f.env.PEBBLE_CLAY_ARCHIVE = 'fixture.tgz';
  f.env.PEBBLE_RESOURCE_SERVICE = 'http://127.0.0.1:4318';
  await f.run();
  assert.deepEqual(
    (await f.results()).map((r) => r.state),
    ['passed', 'passed'],
  );
});

test('suite preserves complete failing gate logs and returns failure', async (t) => {
  const f = await fixture(t, {
    'verify-failing': `console.log('first evidence'); console.log('x'.repeat(5000)); throw new Error('gate broke');`,
  });
  await assert.rejects(f.run(), (error) => error.code === 1);
  const log = await readFile(join(f.cwd, 'tmp/verify-all/verify-failing.mjs.log'), 'utf8');
  assert.match(log, /^first evidence/);
  assert.match(log, /Error: gate broke/);
  assert.equal((await f.results())[0].state, 'failed');
});
