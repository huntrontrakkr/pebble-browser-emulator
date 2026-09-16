import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePackage,
  readProjectMetadata,
  buildPebbleApp,
} from '../public/compiler/portable-builder.mjs';
const e = new TextEncoder(),
  encode = (x) => e.encode(JSON.stringify(x));
const legacy = {
  shortName: 'Short',
  longName: 'The complete old app name',
  companyName: 'Legacy <verbatim>',
  versionLabel: '1.0',
  sdkVersion: '3',
  uuid: '81d7fc6b-55cc-4eb7-bb7a-06466f283a82',
  appKeys: { status: 5 },
};
const pkg = {
  name: 'test',
  version: '1.0.0',
  author: 'Some Author <person@example.com> (https://example.com)',
  pebble: { displayName: 'Modern', sdkVersion: '3', uuid: legacy.uuid },
};
test('plain npm manifest falls back to appinfo and retains dependencies', () => {
  const npm = { name: 'npm-support', dependencies: { 'js-package': '1.0.0' } };
  const info = readProjectMetadata({ 'package.json': encode(npm), 'appinfo.json': encode(legacy) });
  assert.equal(info.legacy, true);
  assert.deepEqual(info.metadata, legacy);
  assert.deepEqual(info.packageInfo, npm);
  assert.throws(() => normalizePackage(info.metadata, { ...info }), /dependencies/);
  const normalized = normalizePackage(info.metadata, { ...info, bundledJs: 'compiled' });
  assert.equal(normalized.longName, legacy.longName);
  assert.equal(normalized.companyName, 'Legacy <verbatim>');
});
test('modern Pebble metadata takes precedence over legacy appinfo', () => {
  const info = readProjectMetadata({ 'package.json': encode(pkg), 'appinfo.json': encode(legacy) });
  assert.equal(info.legacy, false);
  assert.deepEqual(info.projectInfo, pkg.pebble);
  assert.equal(normalizePackage(info.metadata).companyName, 'Some Author');
});
test('missing or empty targetPlatforms allows all supported SDK platforms', () => {
  for (const targetPlatforms of [undefined, [], null])
    for (const platform of ['aplite', 'basalt', 'chalk', 'diorite', 'emery', 'flint', 'gabbro']) {
      const normalized = normalizePackage(
        { ...legacy, targetPlatforms },
        { legacy: true, platform },
      );
      assert.equal(normalized.longName, legacy.longName);
    }
  assert.throws(
    () =>
      normalizePackage(
        { ...legacy, targetPlatforms: ['aplite'] },
        { legacy: true, platform: 'emery' },
      ),
    /does not declare/,
  );
});
test('invalid metadata cannot silently fall back', () => {
  for (const bad of [null, [], 4])
    assert.throws(
      () =>
        readProjectMetadata({
          'package.json': encode({ pebble: bad }),
          'appinfo.json': encode(legacy),
        }),
      /Invalid Pebble/,
    );
  assert.throws(() => readProjectMetadata({ 'appinfo.json': encode([]) }), /JSON object/);
});
test('pathological compiler diagnostics retain only a bounded tail', async () => {
  const sourceFiles = {
    'package.json': encode(pkg),
    'src/c/main.c': e.encode('int main(void){return 0;}'),
  };
  const sdkFiles = {
    'manifest.json': encode({ version: '4.33.1' }),
    'pebble/emery/lib/libpebble.a': new Uint8Array(),
    'pebble/common/pebble_app.ld.template': e.encode('@MAX_APP_MEMORY_SIZE@'),
  };
  let maxLine = 0;
  const session = {
    writeFile: async () => {},
    run: async (_args, { stderr }) => {
      for (let i = 0; i < 100; i++) stderr(e.encode('x'.repeat(4096)));
      return 1;
    },
    readFile: async () => undefined,
  };
  await assert.rejects(
    buildPebbleApp({
      sourceFiles,
      sdkFiles,
      session,
      log: (s) => (maxLine = Math.max(maxLine, s.length)),
    }),
    (error) => error.message.length <= 6100 && /clang failed/.test(error.message),
  );
  assert(maxLine <= 65536);
});
const sdkGolden = JSON.parse(
  await (
    await import('node:fs/promises')
  ).readFile(new URL('./fixtures/resources/legacy-goldens.json', import.meta.url), 'utf8'),
);
for (const fixture of sdkGolden)
  test('official SDK metadata golden ' + fixture.name, () => {
    const files = Object.fromEntries(
      Object.entries(fixture.files).map(([path, value]) => [path, encode(value)]),
    );
    const info = readProjectMetadata(files);
    for (const platform of ['aplite', 'basalt', 'chalk', 'diorite', 'emery', 'flint', 'gabbro']) {
      if (fixture.targets.includes(platform)) {
        const normalized = normalizePackage(info.metadata, {
          ...info,
          platform,
          bundledJs: 'compiled',
        });
        assert.equal(normalized.shortName, fixture.projectInfo.shortName);
        assert.equal(normalized.longName, fixture.projectInfo.longName);
        assert.equal(normalized.companyName, fixture.projectInfo.companyName);
        assert.equal(normalized.versionLabel, fixture.projectInfo.versionLabel);
      } else
        assert.throws(() =>
          normalizePackage(info.metadata, { ...info, platform, bundledJs: 'compiled' }),
        );
    }
  });
