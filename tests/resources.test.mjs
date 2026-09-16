import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pebblePng,
  pebblePbi,
  resourcePack,
  prepareResources,
  selectResourceFile,
} from '../public/compiler/portable-resources.mjs';
import { decodePng } from '../public/compiler/png.mjs';
const root = new URL('./fixtures/resources/', import.meta.url);
const golden = JSON.parse(await readFile(new URL('goldens.json', root), 'utf8'));
for (const [name, outputs] of Object.entries(golden.images)) {
  const bytes = new Uint8Array(await readFile(new URL(name + '.png', root)));
  const image = decodePng(bytes);
  for (const [key, expected] of Object.entries(outputs))
    test(name + ' ' + key, () => {
      const run = () =>
        key.startsWith('png')
          ? pebblePng(image, { color: key.endsWith('pebble64') })
          : pebblePbi(decodePng(bytes, { ignoreSbit: false }), {
              format: key.split('-')[1],
              crop: key.endsWith('True'),
            });
      if (typeof expected === 'object') {
        assert.throws(run);
        return;
      }
      assert.equal(Buffer.from(run()).toString('hex'), expected);
    });
}
for (const [name, p] of Object.entries(golden.packs))
  test('pack ' + name, async () => {
    assert.deepEqual(
      resourcePack(p.inputs.map((x) => new Uint8Array(Buffer.from(x, 'hex')))),
      new Uint8Array(await readFile(new URL(name + '.pbpack', root))),
    );
  });
test('resource selection, aliases, targets, IDs', () => {
  const files = {
    'resources/raw.bin': Uint8Array.of(1),
    'resources/raw~color.bin': Uint8Array.of(2),
    'resources/raw~emery~color.bin': Uint8Array.of(3),
  };
  assert.equal(selectResourceFile(files, 'raw.bin', 'emery'), 'resources/raw~emery~color.bin');
  const r = prepareResources(files, {
    resources: {
      media: [
        { type: 'raw', name: 'SKIP', file: 'nope', targetPlatforms: ['flint'] },
        { type: 'raw', name: 'DATA', file: 'raw.bin', aliases: ['ALIAS'] },
      ],
    },
  });
  assert.deepEqual(r.ids, { DATA: 1, ALIAS: 1 });
  assert.deepEqual(r.entries[0].bytes, Uint8Array.of(3));
});
test('resource limits and unsafe paths reject before build', () => {
  assert.throws(() => resourcePack(new Array(257).fill(Uint8Array.of(1))));
  assert.throws(() => selectResourceFile({}, '../../secret', 'emery'));
});
test('prototype property names remain ordinary numeric resource IDs', () => {
  const r = prepareResources(
    { 'resources/x': Uint8Array.of(1) },
    { resources: { media: [{ type: 'raw', name: '__proto__', file: 'x' }] } },
  );
  assert.equal(Object.getPrototypeOf(r.ids), Object.prototype);
  assert.equal(r.ids.__proto__, 1);
  assert.match(r.header, /#define RESOURCE_ID___proto__ 1/);
});
