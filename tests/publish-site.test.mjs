import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_BASE, validDomain } from '../scripts/publish-site.mjs';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/publish-site.mjs');
const PAGE = `<!doctype html><html><head>
<meta property="og:url" content="${DEFAULT_BASE}" />
<meta property="og:image" content="${DEFAULT_BASE}og-card.png" />
<meta name="twitter:image" content="${DEFAULT_BASE}og-card.png" />
</head><body></body></html>`;

const build = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'site-'));
  await writeFile(join(dir, 'index.html'), PAGE);
  return dir;
};

test('a bare hostname is required, not a URL', () => {
  assert.ok(validDomain('pebble.segfault.golf'));
  assert.ok(validDomain('a.b.c.example'));
  for (const bad of [
    'https://pebble.segfault.golf',
    'pebble.segfault.golf/',
    'pebble.segfault.golf.',
    'pebble.segfault.golf:443',
    'localhost',
    '-lead.example',
    'trail-.example',
    '',
  ])
    assert.equal(validDomain(bad), false, bad);
});

test('a domain writes the CNAME Pages needs and repoints the preview tags', async () => {
  const dir = await build();
  await run(process.execPath, [script, dir], {
    env: { ...process.env, SITE_DOMAIN: 'pebble.segfault.golf' },
  });
  assert.equal(await readFile(join(dir, 'CNAME'), 'utf8'), 'pebble.segfault.golf\n');
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  // Unfurlers do not resolve <base href>, so a stale absolute URL would unfurl
  // the old site with a broken image.
  assert.ok(!html.includes(DEFAULT_BASE));
  assert.ok(html.includes('content="https://pebble.segfault.golf/"'));
  assert.ok(html.includes('content="https://pebble.segfault.golf/og-card.png"'));
});

test('no domain leaves the default deployment untouched', async () => {
  const dir = await build();
  const { stdout } = await run(process.execPath, [script, dir], {
    env: { ...process.env, SITE_DOMAIN: '' },
  });
  assert.match(stdout, /default address/);
  assert.equal(await readFile(join(dir, 'index.html'), 'utf8'), PAGE);
  assert.ok(!(await readdir(dir)).includes('CNAME'));
});

test('a malformed domain fails the build rather than publishing a broken CNAME', async () => {
  const dir = await build();
  await assert.rejects(
    run(process.execPath, [script, dir], {
      env: { ...process.env, SITE_DOMAIN: 'https://pebble.segfault.golf' },
    }),
    (error) => {
      assert.match(String(error.stderr), /bare hostname/);
      return true;
    },
  );
  assert.ok(!(await readdir(dir)).includes('CNAME'));
});
