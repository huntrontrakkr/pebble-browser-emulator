import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { bundledFirmware } from '../src/app/preview-firmware.ts';

const root = new URL('../public/firmware/v4.37.0/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('every bundled board expands to its unchanged official release images through the browser loader', async () => {
  for (const [profile, pair] of Object.entries(manifest.profiles)) {
    const calls = [];
    const request = async (url, options) => {
      calls.push(String(url));
      assert.equal(options.credentials, 'same-origin');
      const name = new URL(url).pathname.split('/').pop();
      const item = Object.values(pair).find((file) => file.path === name);
      assert.ok(item);
      const bytes = await readFile(new URL(name, root));
      assert.equal(bytes.length, item.gzipBytes);
      assert.equal(sha(bytes), item.gzipSha256);
      return new Response(bytes);
    };
    const firmware = await bundledFirmware(
      profile,
      new AbortController().signal,
      'https://example.test/watch/',
      request,
    );
    assert.equal(firmware.profile, profile);
    for (const [role, bytes] of [
      ['micro', firmware.micro],
      ['spi', firmware.flash],
    ]) {
      assert.equal(bytes.byteLength, pair[role].bytes);
      assert.equal(sha(bytes), pair[role].sha256);
    }
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => url.startsWith('https://example.test/watch/firmware/v4.37.0/')));
  }
});

test('firmware also accepts a fetch body already decompressed by HTTP, including a split gzip header', async () => {
  for (const transport of ['http-decoded', 'gzip-split-header']) {
    const pair = manifest.profiles.qemu_emery;
    const firmware = await bundledFirmware(
      'qemu_emery',
      new AbortController().signal,
      'https://example.test/',
      async (url) => {
        const name = new URL(url).pathname.split('/').pop();
        const gzip = await readFile(new URL(name, root));
        if (transport === 'http-decoded')
          return new Response(gunzipSync(gzip), { headers: { 'Content-Encoding': 'gzip' } });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(gzip.subarray(0, 1));
              controller.enqueue(gzip.subarray(1, 2));
              controller.enqueue(gzip.subarray(2));
              controller.close();
            },
          }),
          { headers: { 'Content-Encoding': 'gzip' } },
        );
      },
    );
    assert.equal(sha(firmware.micro), pair.micro.sha256);
    assert.equal(sha(firmware.flash), pair.spi.sha256);
  }
});

test('default firmware fails closed on unavailable, truncated, corrupt, or oversized content', async () => {
  const expected = manifest.profiles.qemu_flint.micro.bytes;
  for (const [response, error] of [
    [new Response('', { status: 404 }), /could not be downloaded/],
    [new Response(gzipSync(Buffer.alloc(8))), /incomplete/],
    [new Response(gzipSync(Buffer.alloc(expected))), /checksum/],
    [new Response(gzipSync(Buffer.alloc(expected + 1))), /expected size/],
    [new Response(Buffer.alloc(8)), /incomplete/],
    [new Response(Buffer.alloc(expected)), /checksum/],
    [new Response(Buffer.alloc(expected + 1)), /expected size/],
  ]) {
    await assert.rejects(
      bundledFirmware(
        'qemu_flint',
        new AbortController().signal,
        'https://example.test/',
        async () => response,
      ),
      error,
    );
  }
});

test('canceling an in-flight default firmware stream stops reading and cannot return an image', async () => {
  for (const prefix of [
    new Uint8Array(),
    new Uint8Array([0x1f]),
    gzipSync(Buffer.alloc(8)),
    Buffer.alloc(8),
  ]) {
    const controller = new AbortController();
    let started,
      canceled = false;
    const reading = new Promise((resolve) => {
      started = resolve;
    });
    const request = async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            if (prefix.length) stream.enqueue(prefix);
          },
          pull() {
            started();
          },
          cancel() {
            canceled = true;
          },
        }),
      );
    const pending = bundledFirmware(
      'qemu_emery',
      controller.signal,
      'https://example.test/',
      request,
    );
    await reading;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(canceled, true);
  }
});

test('the release ships every notice recorded in its provenance inventory', async () => {
  assert.ok(manifest.licenses.length >= 30);
  for (const item of manifest.licenses)
    assert.equal(sha(await readFile(new URL(item.path, root))), item.sha256, item.path);
});
