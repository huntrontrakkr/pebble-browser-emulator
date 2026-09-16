import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessageKeys,
  normalizePackage,
  generateAppinfoC,
} from '../public/compiler/portable-builder.mjs';
import { PLATFORMS } from '../public/compiler/platforms.mjs';
const golden = JSON.parse(
  await readFile(new URL('./fixtures/resources/metadata-goldens.json', import.meta.url), 'utf8'),
);
for (const fixture of golden)
  test('SDK message keys ' + JSON.stringify(fixture.input), () =>
    assert.deepEqual(normalizeMessageKeys(fixture.input), fixture.output),
  );
const base = {
  name: 'demo',
  author: 'Test',
  version: '1.2.3',
  pebble: {
    sdkVersion: '3',
    projectType: 'native',
    uuid: '7c5f2e40-63c4-4d17-9cd6-8a85f0ced130',
    targetPlatforms: Object.keys(PLATFORMS),
  },
};
test('all SDK platform flags and limits', () => {
  for (const platform of Object.keys(PLATFORMS)) {
    const a = normalizePackage(base, { platform });
    assert.match(
      generateAppinfoC(a, { platform }),
      new RegExp('PROCESS_INFO_PLATFORM_' + platform.toUpperCase()),
    );
    assert.equal(PLATFORMS[platform].maxWorkerMemory, 10240);
  }
});
test('legacy metadata and keys', () => {
  const a = normalizePackage(
    {
      shortName: 'Old app',
      longName: 'Old long name',
      companyName: 'Legacy',
      versionLabel: '2.1',
      sdkVersion: '3',
      targetPlatforms: ['basalt'],
      uuid: base.pebble.uuid,
      appKeys: ['status'],
    },
    { legacy: true, platform: 'basalt' },
  );
  assert.equal(a.shortName, 'Old app');
  assert.equal(a.appKeys.status, 10000);
});
test('dependencies only when bundled JS supplied', () => {
  const p = { ...base, dependencies: { package: '1.0.0' } };
  assert.throws(() => normalizePackage(p));
  assert.doesNotThrow(() => normalizePackage(p, { bundledJs: 'compiled bundle' }));
});
test('invalid platform, keys and manifest reject', () => {
  assert.throws(() => normalizePackage(base, { platform: 'unknown' }));
  assert.throws(() => normalizeMessageKeys(['block[0]']));
  assert.throws(() => normalizeMessageKeys(['key', 'key']));
  assert.throws(() => normalizePackage({ ...base, pebble: { ...base.pebble, appKeys: { x: 1 } } }));
});

test('message key blocks cannot overflow uint32 allocation', () => {
  assert.throws(() => normalizeMessageKeys(['too_big[4294967296]']));
  assert.throws(() => normalizeMessageKeys(['overflow[4294957297]']));
  assert.throws(() => normalizeMessageKeys(['full[4294957296]', 'overflow']));
  assert.throws(() => normalizeMessageKeys(['huge[9007199254740992]']));
  assert.deepEqual(normalizeMessageKeys(['last[4294957296]']), { last: 10000 });
});
test('prototype property names remain ordinary numeric message keys', () => {
  const keys = normalizeMessageKeys(['__proto__', 'constructor']);
  assert.equal(Object.getPrototypeOf(keys), Object.prototype);
  assert.deepEqual(Object.entries(keys), [
    ['__proto__', 10000],
    ['constructor', 10001],
  ]);
  assert.throws(
    () => normalizePackage(base, { platform: 'constructor' }),
    /Unsupported SDK platform/,
  );
});
