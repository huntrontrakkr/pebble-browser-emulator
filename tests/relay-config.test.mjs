import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeResourceSettings } from '../src/app/resource-fetch.ts';
import { normalizeServiceDefaults, resolveRelay } from '../src/app/service-defaults.ts';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/write-service-config.mjs');
const KEY = 'k'.repeat(24);
const OTHER = 'z'.repeat(24);

test('a relay needs both halves before anything is sent', () => {
  const none = { endpoint: '', relayKey: '' };
  const off = { enabled: false, endpoint: 'https://a.example', relayKey: KEY };
  assert.equal(resolveRelay(off, none), undefined);
  // An endpoint with no key, or a key with no endpoint, is not a relay: the
  // request would be sent and refused, which reads like the host failing.
  assert.equal(
    resolveRelay({ enabled: true, endpoint: 'https://a.example', relayKey: '' }, none),
    undefined,
  );
  assert.equal(resolveRelay({ enabled: true, endpoint: '', relayKey: KEY }, none), undefined);
  assert.equal(resolveRelay({ enabled: false, endpoint: '', relayKey: '' }, none), undefined);
});

test("a visitor's own relay wins over the deployment's", () => {
  const defaults = { endpoint: 'https://hosted.example', relayKey: OTHER };
  assert.deepEqual(
    resolveRelay({ enabled: true, endpoint: 'https://mine.example', relayKey: KEY }, defaults),
    { endpoint: 'https://mine.example', key: KEY },
  );
  assert.deepEqual(resolveRelay({ enabled: false, endpoint: '', relayKey: '' }, defaults), {
    endpoint: 'https://hosted.example',
    key: OTHER,
  });
});

test('an endpoint and a key are never taken from different services', () => {
  const defaults = { endpoint: 'https://hosted.example', relayKey: OTHER };
  // A key is issued for one endpoint. Pairing a visitor's endpoint with the
  // deployment's key would hand one service's credential to another, so a
  // half-configured visitor entry falls back whole rather than borrowing.
  const mixed = resolveRelay(
    { enabled: true, endpoint: 'https://mine.example', relayKey: '' },
    defaults,
  );
  assert.deepEqual(mixed, { endpoint: 'https://hosted.example', key: OTHER });
  assert.notEqual(mixed?.endpoint, 'https://mine.example');
});

test('settings refuse a key too short to be one, and keep downloads working', () => {
  assert.throws(
    () =>
      normalizeResourceSettings({ enabled: true, endpoint: 'https://a.example', relayKey: 'x' }),
    /at least 16 characters/,
  );
  assert.throws(
    () =>
      normalizeResourceSettings({
        enabled: true,
        endpoint: 'https://a.example',
        relayKey: 'x'.repeat(257),
      }),
    /too long/,
  );
  // Downloads without relaying stay valid; an absent key is simply no relay.
  const downloads = normalizeResourceSettings({ enabled: true, endpoint: 'https://a.example' });
  assert.equal(downloads.relayKey, '');
  assert.equal(downloads.enabled, true);
});

test('a deployment file is ignored unless it is well formed', () => {
  assert.deepEqual(normalizeServiceDefaults(null), { endpoint: '', relayKey: '' });
  assert.deepEqual(normalizeServiceDefaults({ endpoint: 'http://evil.example', relayKey: KEY }), {
    endpoint: '',
    relayKey: '',
  });
  assert.equal(
    normalizeServiceDefaults({ endpoint: 'https://a.example', relayKey: 'short' }).relayKey,
    '',
  );
});

test('the deploy step writes a config the application accepts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  const target = join(dir, 'service-config.json');
  await run(process.execPath, [script, target], {
    env: { ...process.env, ENDPOINT: 'https://hosted.example/', RELAY_KEY: KEY },
  });
  const written = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(written, { endpoint: 'https://hosted.example', relayKey: KEY });
  // What the build writes is what the application will accept back.
  assert.deepEqual(normalizeServiceDefaults(written), written);
});

test('a build with no service still publishes an explicit empty config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  const target = join(dir, 'service-config.json');
  await run(process.execPath, [script, target], {
    env: { ...process.env, ENDPOINT: '', RELAY_KEY: '' },
  });
  // Absent, the application's startup request answers 404, which the browser
  // logs as an error in every visitor's console. An explicit empty file is the
  // same "no service" without the noise.
  const written = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(written, {});
  assert.deepEqual(normalizeServiceDefaults(written), { endpoint: '', relayKey: '' });
  assert.equal(
    resolveRelay(
      { enabled: false, endpoint: '', relayKey: '' },
      written.endpoint ? written : { endpoint: '', relayKey: '' },
    ),
    undefined,
  );
});

test('the deploy step fails the build rather than publishing a bad config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  const target = join(dir, 'service-config.json');
  const fails = async (env, pattern) => {
    await assert.rejects(
      run(process.execPath, [script, target], { env: { ...process.env, ...env } }),
      (error) => {
        assert.match(String(error.stderr), pattern);
        return true;
      },
    );
  };
  await fails({ ENDPOINT: '', RELAY_KEY: KEY }, /both ENDPOINT and RELAY_KEY, or neither/i);
  await fails(
    { ENDPOINT: 'https://a.example', RELAY_KEY: '' },
    /both ENDPOINT and RELAY_KEY, or neither/i,
  );
  await fails({ ENDPOINT: 'http://a.example', RELAY_KEY: KEY }, /must be HTTPS/);
  await fails({ ENDPOINT: 'https://u:p@a.example', RELAY_KEY: KEY }, /credentials/);
  await fails({ ENDPOINT: 'https://a.example', RELAY_KEY: 'short' }, /16 to 256/);
});
