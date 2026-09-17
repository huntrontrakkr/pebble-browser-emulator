import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePreviewLink, previewLink, repositoryPreview } from '../src/app/preview-links.ts';
import { previewFirmwareFiles } from '../src/app/preview-firmware.ts';
import { PresentationBudget } from '../src/app/worker-scheduler.ts';
import { renderPixels } from '../src/app/display.ts';

test('preview links preserve static subdirectory hosting, selected board and explicit source identity', () => {
  const target = {
    kind: 'github',
    profile: 'qemu_flint',
    repository: {
      owner: 'person',
      repository: 'face',
      ref: 'feature/watch',
      root: 'examples/hello world',
    },
    pbw: 'preview/face.pbw',
  };
  const link = previewLink('https://example.com/watch/?old=ignored', target);
  assert.equal(new URL(link).pathname, '/watch/');
  assert.equal(new URL(link).search, '');
  assert.deepEqual(parsePreviewLink(new URL(link).hash), target);
  assert.deepEqual(parsePreviewLink('#/example/clock'), { kind: 'example', profile: 'qemu_emery' });
  assert.equal(parsePreviewLink(''), null);
});

test('preview links reject unknown boards, traversal, foreign URLs and ambiguous options', () => {
  for (const hash of [
    '#/example/clock?watch=obelix',
    '#/example/clock?watch=qemu_emery&watch=qemu_flint',
    '#/github/person/face?path=..%2Fprivate',
    '#/github/person/face?pbw=https://other.test/file.pbw',
    '#/github/person/face?pbw=..%2Fa.pbw',
    '#/github/person/face?command=rm',
    '#/github/person%2Fother/face',
    '#/github/person/face/extra',
  ])
    assert.throws(() => parsePreviewLink(hash), hash);
});

test('GitHub preview downloads only a checksummed, commit-pinned artifact when a manifest is present', async () => {
  const calls = [],
    bytes = new Uint8Array([80, 75, 3, 4]),
    commit = '1'.repeat(40);
  const request = async (url) => {
    calls.push(String(url));
    if (url.includes('/commits/')) return Response.json({ sha: commit });
    if (url.endsWith('pebble-preview.json'))
      return Response.json({
        version: 1,
        packages: {
          emery: {
            path: 'preview/face.pbw',
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        },
      });
    if (url.endsWith('/preview/face.pbw')) return new Response(bytes);
    throw new Error('Unexpected request: ' + url);
  };
  const target = parsePreviewLink('#/github/person/face?ref=main&path=watchface');
  const result = await repositoryPreview(target, new AbortController().signal, () => {}, request);
  assert.equal(result.kind, 'package');
  assert.deepEqual(result.package.bytes, bytes);
  assert.equal(result.target.repository.ref, commit);
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every((url) => url.includes('/' + commit + '/watchface/')));
});

test('preview manifests fail closed on checksum mismatch and external or oversized artifacts', async () => {
  for (const path of ['https://evil.test/face.pbw', '../face.pbw', 'face.pbw']) {
    const request = async (url) =>
      url.includes('/commits/')
        ? Response.json({ sha: 'a'.repeat(40) })
        : url.endsWith('.json')
          ? Response.json({ version: 1, packages: { emery: { path, sha256: 'f'.repeat(64) } } })
          : new Response('incorrect');
    await assert.rejects(
      repositoryPreview(
        parsePreviewLink('#/github/a/b?ref=main'),
        new AbortController().signal,
        () => {},
        request,
      ),
    );
  }
  const request = async (url) =>
    url.includes('/commits/')
      ? Response.json({ sha: 'a'.repeat(40) })
      : new Response('abc', { headers: { 'Content-Length': String(9 * 1048576) } });
  await assert.rejects(
    repositoryPreview(
      parsePreviewLink('#/github/a/b?ref=main&pbw=face.pbw'),
      new AbortController().signal,
      () => {},
      request,
    ),
    /limit|exceed/i,
  );
});

test('presentation coalesces screen changes while explicit pause/step snapshots stay immediate', () => {
  const budget = new PresentationBudget();
  assert.equal(budget.due(0, true), true);
  for (let time = 1; time < 33; time++) assert.equal(budget.due(time, true), false);
  assert.equal(budget.due(34, true), true);
  assert.equal(budget.due(40, false, true), true);
  assert.equal(budget.due(100, false), false);
  assert.equal(budget.due(290, false), true);
});

test('palette conversion preserves every input byte under changing optical settings', () => {
  const source = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const [mode, ambient, backlight] of [
    ['pixels', 1, 0],
    ['reflective', 0.4, 0.7],
    ['model', 0, 0],
    ['pixels', 0, 1],
  ]) {
    const expected = new Uint8ClampedArray(1024);
    for (let p = 0; p < 256; p++) {
      const channels = [(p >> 4) & 3, (p >> 2) & 3, p & 3];
      for (let c = 0; c < 3; c++) {
        const raw = channels[c] / 3;
        expected[p * 4 + c] =
          mode === 'pixels'
            ? raw * 255
            : ([31, 38, 35][c] + ([212, 218, 199][c] - [31, 38, 35][c]) * raw) *
                (0.25 + 0.75 * ambient) *
                (1 - backlight) +
              raw * 255 * backlight;
      }
      expected[p * 4 + 3] = 255;
    }
    assert.deepEqual(renderPixels(source, { mode, ambient, backlight }), expected);
  }
});

test('one-time firmware setup rejects mixed versions and mismatched boards before reading large files', async () => {
  const file = (name) => ({
    name,
    size: 33554432,
    arrayBuffer: () => {
      throw new Error('Should not read');
    },
  });
  await assert.rejects(
    previewFirmwareFiles(
      [file('qemu_emery_v4.37.0_micro_flash.bin'), file('qemu_emery_v4.36.0_spi_flash.bin')],
      'qemu_emery',
    ),
    /same firmware version/,
  );
  await assert.rejects(
    previewFirmwareFiles(
      [file('qemu_flint_v4.37.0_micro_flash.bin'), file('qemu_flint_v4.37.0_spi_flash.bin')],
      'qemu_emery',
    ),
    /match the selected watch/,
  );
});
