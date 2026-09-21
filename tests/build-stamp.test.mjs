import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildStamp } from '../src/app/build-stamp.ts';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/stamp-build.mjs');
const SHA = 'a'.repeat(40);
const REPO = 'https://github.com/huntrontrakkr/pebble-browser-emulator';

/** Enough of a Document for the reader: it only ever queries meta tags. */
const page = (tags) => ({
  querySelector: (selector) => {
    const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
    return name && name in tags ? { content: tags[name] } : null;
  },
});

test('an unstamped page reports no build rather than guessing one', () => {
  assert.equal(buildStamp(page({})), null);
  assert.equal(buildStamp(undefined), null);
  // A stamp that is not a commit is not a stamp.
  assert.equal(buildStamp(page({ 'build-commit': 'main' })), null);
  assert.equal(buildStamp(page({ 'build-commit': 'a'.repeat(39) })), null);
});

test('a stamped page links to the exact commit it was built from', () => {
  const stamp = buildStamp(
    page({
      'build-commit': SHA,
      'build-repository': REPO,
      'build-time': '2026-09-21T16:00:00.000Z',
    }),
  );
  assert.equal(stamp.commit, SHA);
  assert.equal(stamp.shortCommit, 'aaaaaaa');
  assert.equal(stamp.commitUrl, `${REPO}/commit/${SHA}`);
  assert.equal(stamp.modified, false);
});

test('a build from a modified tree says so', () => {
  const stamp = buildStamp(
    page({ 'build-commit': SHA, 'build-repository': REPO, 'build-modified': 'true' }),
  );
  // The commit alone would name code that is not what was built.
  assert.equal(stamp.modified, true);
  assert.equal(buildStamp(page({ 'build-commit': SHA, 'build-modified': 'yes' })).modified, false);
});

test('a repository that is not an https URL becomes no link at all', () => {
  for (const repository of ['javascript:alert(1)', 'http://example.com', 'not a url', '']) {
    const stamp = buildStamp(page({ 'build-commit': SHA, 'build-repository': repository }));
    assert.equal(stamp.repository, '', repository);
    assert.equal(stamp.commitUrl, '', repository);
  }
});

const HTML = '<!doctype html><html><head><title>x</title></head><body></body></html>';

test('the stamp written into a page is the stamp the application reads back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stamp-'));
  const target = join(dir, 'index.html');
  await writeFile(target, HTML);
  await run(process.execPath, [script, target], {
    env: {
      ...process.env,
      GITHUB_SHA: SHA,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
    },
  });
  const html = await readFile(target, 'utf8');
  const tags = Object.fromEntries(
    [...html.matchAll(/<meta name="([^"]+)" content="([^"]*)" \/>/g)].map((m) => [m[1], m[2]]),
  );
  const stamp = buildStamp(page(tags));
  assert.equal(stamp.commit, SHA);
  assert.equal(stamp.commitUrl, `https://github.com/o/r/commit/${SHA}`);
  assert.ok(Date.parse(stamp.builtAt) > 0);
});

test('a page with no commit available is published unstamped, not stamped wrongly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stamp-'));
  const target = join(dir, 'index.html');
  await writeFile(target, HTML);
  // No workflow SHA, and a directory that is not a git repository.
  const { stdout } = await run(process.execPath, [script, target], {
    cwd: dir,
    env: { ...process.env, GITHUB_SHA: '' },
  });
  assert.match(stdout, /without a build stamp/);
  assert.equal(await readFile(target, 'utf8'), HTML);
});

test('a page is never stamped twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stamp-'));
  const target = join(dir, 'index.html');
  await writeFile(target, HTML);
  const env = { ...process.env, GITHUB_SHA: SHA };
  await run(process.execPath, [script, target], { env });
  await assert.rejects(run(process.execPath, [script, target], { env }), (error) => {
    assert.match(String(error.stderr), /already carries a build stamp/);
    return true;
  });
});
