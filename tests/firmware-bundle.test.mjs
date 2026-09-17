import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseFirmwareBundle, inspectFirmwareBundle } from '../src/app/firmware-bundle.ts';
import { boardDescriptor, signalRoute } from '../src/app/board-registry.ts';
import { fetchFirmwareRelease } from '../src/app/firmware-catalog.ts';
const hash = (b) => createHash('sha256').update(b).digest('hex');
test('firmware bundles validate identity and hashes without substituting physical boards', async () => {
  const bytes = Uint8Array.of(1, 2, 3),
    manifest = {
      format: 'pebble-firmware-bundle',
      version: 1,
      board: 'obelix',
      revision: 'pvt',
      firmwareVersion: 'custom/2026.09-rc',
      assets: [{ role: 'firmware-package', path: 'stock.pbz', sha256: hash(bytes) }],
    };
  const inspected = await inspectFirmwareBundle(manifest, { 'stock.pbz': bytes });
  assert.equal(inspected.loadable, null);
  assert.match(inspected.reason, /SiFli/);
  await assert.rejects(
    inspectFirmwareBundle(manifest, { 'stock.pbz': Uint8Array.of(4) }),
    /SHA-256 mismatch/,
  );
  assert.throws(
    () => parseFirmwareBundle({ ...manifest, board: 'qemu_emery' }),
    /Invalid firmware asset/,
  );
  assert.throws(
    () => parseFirmwareBundle({ ...manifest, assets: [...manifest.assets, ...manifest.assets] }),
    /Duplicate/,
  );
  assert.throws(() => signalRoute('qemu_flint', 'touch'), /no implemented/);
  assert.throws(() => signalRoute('obelix', 'acceleration'), /no implemented/);
  assert.equal(boardDescriptor('qemu_emery').platform, boardDescriptor('obelix').platform);
  assert.notEqual(boardDescriptor('qemu_emery').family, boardDescriptor('obelix').family);
});
test('firmware release lookup preserves arbitrary exact tags and public source identity', async () => {
  let url;
  const request = async (input) => {
    url = input;
    return Response.json({
      tag_name: 'release/test-build',
      published_at: '2026-01-01',
      html_url: 'https://github.com/example/fw/releases/tag/release%2Ftest-build',
      prerelease: true,
      assets: [],
    });
  };
  const result = await fetchFirmwareRelease('release/test-build', 'example/fw', request);
  assert.equal(url, 'https://api.github.com/repos/example/fw/releases/tags/release%2Ftest-build');
  assert.equal(result.tag, 'release/test-build');
});
