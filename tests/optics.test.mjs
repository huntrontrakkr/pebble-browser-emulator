import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadOpticalTable } from '../src/app/watch-optics.ts';
import { TIME2_OPTICS as spec } from '../src/app/watch-optics-profile.ts';
import { WATCH_MODELS } from '../src/app/watch-model-specs.ts';

const data = new Uint8Array(await readFile(new URL('../public/' + spec.path, import.meta.url)));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('optical artifact matches its reviewed recipe and stays specific to Time 2', async () => {
  assert.equal(digest(data), spec.sha256);
  assert.equal(data.length, spec.bytes);
  assert.equal(data.length, spec.width * spec.height * 4);
  assert.equal(
    digest(await readFile(new URL('../scripts/optics/time2.json', import.meta.url))),
    spec.recipeSha256,
  );
  assert.equal(spec.calibration, 'unmeasured-assumptions');
  assert.equal(WATCH_MODELS.qemu_emery.optics, 'time2');
  assert.equal(WATCH_MODELS.qemu_flint.optics, undefined);
  assert.equal(WATCH_MODELS.qemu_gabbro.optics, undefined);
  assert.ok(spec.bytes < 300_000);
});

test('optical loading verifies content, handles aborts and retries, and resolves below the site base', async () => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = { baseURI: 'https://example.test/pebble-browser-emulator/' };
  const signal = new AbortController().signal;
  let calls = 0;
  try {
    globalThis.fetch = async () => new Response('missing', { status: 404 });
    await assert.rejects(loadOpticalTable('time2', signal), /downloaded/);
    globalThis.fetch = async () => new Response(new Uint8Array(3));
    await assert.rejects(loadOpticalTable('time2', signal), /size/);
    const corrupt = data.slice();
    corrupt[12] ^= 1;
    globalThis.fetch = async () => new Response(corrupt);
    await assert.rejects(loadOpticalTable('time2', signal), /checksum/);
    const canceled = new AbortController();
    globalThis.fetch = async () => {
      canceled.abort();
      return new Response(data);
    };
    await assert.rejects(loadOpticalTable('time2', canceled.signal), { name: 'AbortError' });
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url.href, 'https://example.test/pebble-browser-emulator/' + spec.path);
      assert.equal(options.signal.aborted, false);
      return new Response(data);
    };
    const loaded = await loadOpticalTable('time2', signal);
    assert.deepEqual(loaded, data);
    assert.equal(await loadOpticalTable('time2', signal), loaded);
    assert.equal(calls, 1);
    await assert.rejects(loadOpticalTable('time2', canceled.signal), { name: 'AbortError' });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  }
});
