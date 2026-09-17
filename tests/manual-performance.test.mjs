import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../src/app/virtual-phone.ts';
import { renderPixels } from '../src/app/display.ts';
import { BufferedHistory } from '../src/app/buffered-history.ts';

test('storage snapshots follow all mutations even when diagnostic events overflow', async () => {
  const vm = new VirtualPhone(await getQuickJS(), {
    appId: 'storage-revisions',
    nowMs: 0,
    storage: { original: 'yes' },
    limits: { eventCount: 2 },
  });
  try {
    vm.start(`console.log('fill output');
      setTimeout(()=>localStorage.setItem('theme','dark'),10);
      setTimeout(()=>{localStorage.theme='light';delete localStorage.original},20);
      setTimeout(()=>localStorage.clear(),30);`);
    assert.deepEqual(vm.readStorageIfChanged(), { original: 'yes' });
    assert.equal(vm.readStorageIfChanged(), undefined);
    vm.advanceTime(10);
    assert.deepEqual(vm.readStorageIfChanged(), { original: 'yes', theme: 'dark' });
    assert.equal(vm.readStorageIfChanged(), undefined);
    vm.advanceTime(20);
    assert.deepEqual(vm.readStorageIfChanged(), { theme: 'light' });
    vm.advanceTime(30);
    assert.deepEqual(vm.readStorageIfChanged(), {});
    vm.advanceTime(40);
    assert.equal(vm.readStorageIfChanged(), undefined);
    assert.ok(vm.drainEvents().some((event) => event.type === 'limit'));
  } finally {
    vm.dispose();
  }
});

test('pixel buffer reuse preserves every color and does not write outside a view', () => {
  const pixels = Uint8Array.from({ length: 256 }, (_, i) => i);
  const backing = new Uint8ClampedArray(256 * 4 + 8).fill(123);
  const destination = backing.subarray(4, -4);
  for (const mode of ['pixels', 'reflective', 'model']) {
    const options = { mode, ambient: 0.63, backlight: 0.24 };
    const expected = renderPixels(pixels, options);
    assert.equal(renderPixels(pixels, options, destination), destination);
    assert.deepEqual(destination, expected);
    assert.deepEqual([...backing.slice(0, 4), ...backing.slice(-4)], Array(8).fill(123));
  }
  assert.throws(
    () =>
      renderPixels(pixels, { mode: 'pixels', ambient: 1, backlight: 0 }, new Uint8ClampedArray(1)),
    /matching size/,
  );
});

test('batched history retains the same ordered tail and clear discards unpublished records', () => {
  let actual = [],
    expected = [],
    publications = 0;
  const buffer = new BufferedHistory(200, (items) => {
    publications++;
    actual = [...actual, ...items].slice(-200);
  });
  try {
    for (let i = 0; i < 2000; i++) {
      const record = { index: i, text: String(i) };
      expected = [...expected, record].slice(-200);
      buffer.append(record);
      if (i % 347 === 0) {
        buffer.flush();
        assert.deepEqual(actual, expected);
      }
    }
    buffer.flush();
    assert.deepEqual(actual, expected);
    assert.ok(publications < 10);
    buffer.append({ index: 2000, text: 'discard' });
    buffer.dispose();
    actual = [];
    buffer.append({ index: 2001, text: 'new' });
    buffer.flush();
    assert.deepEqual(actual, [{ index: 2001, text: 'new' }]);
  } finally {
    buffer.dispose();
  }
});
