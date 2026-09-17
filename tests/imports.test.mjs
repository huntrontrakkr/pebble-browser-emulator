import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepository,
  importRepository,
  readLimited,
  folderSnapshot,
} from '../src/app/projects.ts';
import { describeAsset } from '../src/app/firmware-catalog.ts';
import { renderPixels } from '../src/app/display.ts';
test('repository parsing preserves explicit branch and subdirectory', () => {
  assert.deepEqual(
    parseRepository('https://github.com/owner/repo.git', 'feature/a', 'examples/watch'),
    { owner: 'owner', repository: 'repo', ref: 'feature/a', root: 'examples/watch' },
  );
  assert.throws(() => parseRepository('https://evil.test/owner/repo'));
  assert.throws(() => parseRepository('owner/repo', 'main', '../secrets'));
  assert.throws(() => parseRepository('https://github.com/owner/repo/tree/main'));
});
test('GitHub import pins raw file requests to the resolved commit and preserves binary bytes', async () => {
  const sha = 'a'.repeat(40),
    paths = [];
  const request = async (url) => {
    paths.push(String(url));
    if (String(url).includes('/commits/')) return Response.json({ sha });
    if (String(url).includes('/git/trees/'))
      return Response.json({
        tree: [
          { path: 'app/package.json', type: 'blob', mode: '100644', size: 2 },
          { path: 'app/src/c/main.c', type: 'blob', mode: '100644', size: 3 },
          { path: 'app/build/generate.py', type: 'blob', mode: '100644', size: 3 },
          { path: 'app/.github/build.sh', type: 'blob', mode: '100755', size: 3 },
        ],
      });
    if (String(url).endsWith('package.json')) return new Response('{}');
    return new Response(new Uint8Array([0, 128, 255]));
  };
  const snapshot = await importRepository(
    parseRepository('owner/repo', 'main', 'app'),
    undefined,
    () => {},
    request,
  );
  assert.equal(snapshot.commit, sha);
  assert.deepEqual(snapshot.files['src/c/main.c'], new Uint8Array([0, 128, 255]));
  assert.deepEqual(snapshot.files['build/generate.py'], new Uint8Array([0, 128, 255]));
  assert.deepEqual(snapshot.files['.github/build.sh'], new Uint8Array([0, 128, 255]));
  assert(
    paths
      .filter((p) => p.includes('raw.githubusercontent'))
      .every((p) => p.includes('/' + sha + '/')),
  );
});
test('local folders retain build helpers and recipes, enforce quotas before reading, and cancel', async () => {
  const entry = (path, text = 'source') => ({
    name: path.split('/').at(-1),
    webkitRelativePath: 'project/' + path,
    size: new TextEncoder().encode(text).length,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });
  const entries = [entry('build/generate.py'), entry('.pebble-browser.yml'), entry('.git/config')];
  const snapshot = await folderSnapshot(entries);
  assert.deepEqual(Object.keys(snapshot.files), ['build/generate.py', '.pebble-browser.yml']);
  await assert.rejects(
    folderSnapshot(entries, () => true),
    /canceled/,
  );
  await assert.rejects(
    folderSnapshot([
      {
        ...entry('oversized'),
        size: 129 * 1048576,
        arrayBuffer: () => {
          throw new Error('Must not read oversized input');
        },
      },
    ]),
    /128 MiB/,
  );
});
test('stream size limits are enforced on actual downloaded bytes', async () => {
  await assert.rejects(() => readLimited(new Response(new Uint8Array(20)), 10), /size limit/);
});
test('firmware catalog does not confuse production Obelix with qemu Emery', () => {
  assert.equal(
    describeAsset({
      id: 1,
      name: 'qemu_emery_full_micro_flash.bin',
      size: 1,
      browser_download_url: 'https://x',
    }).kind,
    'qemu-code',
  );
  const p = describeAsset({
    id: 2,
    name: 'obelix_pvt.pbz',
    size: 1,
    browser_download_url: 'https://x',
    digest: 'sha256:abc',
  });
  assert.equal(p.board, 'obelix');
  assert.equal(p.kind, 'production');
  assert.equal(p.sha256, 'abc');
});
test('pixel conversion preserves all 64 RGB colors and leaves firmware framebuffer unchanged', () => {
  const source = Uint8Array.from({ length: 64 }, (_, i) => 0xc0 + i),
    original = source.slice();
  const raw = renderPixels(source, { mode: 'pixels', ambient: 0, backlight: 0 });
  for (let i = 0; i < 64; i++) {
    assert.equal(raw[i * 4], ((i >> 4) & 3) * 85);
    assert.equal(raw[i * 4 + 1], ((i >> 2) & 3) * 85);
    assert.equal(raw[i * 4 + 2], (i & 3) * 85);
    assert.equal(raw[i * 4 + 3], 255);
  }
  const preview = renderPixels(source, { mode: 'reflective', ambient: 1, backlight: 0 });
  assert.notDeepEqual(preview, raw);
  assert.deepEqual(source, original);
});
