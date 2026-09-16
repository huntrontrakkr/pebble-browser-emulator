import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  APP_PLATFORMS,
  FIRMWARE_PROFILES,
  WATCH_PRODUCTS,
  profileDisplay,
  fileProfile,
} from '../src/app/watch-profiles.ts';
import { describeAsset } from '../src/app/firmware-catalog.ts';
const wasm = await readFile(new URL('../public/wasm/qemu-emery.wasm', import.meta.url));
test('all watch families map to the official seven app platforms, with distinct Time 2 generations', () => {
  assert.equal(new Set(WATCH_PRODUCTS.map((p) => p.platform)).size, 7);
  assert.equal(new Set(WATCH_PRODUCTS.map((p) => p.id)).size, WATCH_PRODUCTS.length);
  assert.equal(WATCH_PRODUCTS.find((p) => p.id === 'time-2-2016').runtime, undefined);
  assert.equal(WATCH_PRODUCTS.find((p) => p.id === 'time-2').runtime, 'qemu_emery');
  assert.equal(APP_PLATFORMS.chalk.width, 180);
  assert.equal(APP_PLATFORMS.gabbro.width, 260);
});
test('UI profile geometry agrees with the shipped Wasm ABI and official board dimensions', async () => {
  const { instance } = await WebAssembly.instantiate(wasm, {}),
    api = instance.exports;
  for (const [name, width, height, guestLength] of [
    ['qemu_flint', 144, 168, 3360],
    ['qemu_emery', 200, 228, 45600],
    ['qemu_gabbro', 260, 260, 67600],
  ]) {
    const code = new Uint8Array(0x104),
      view = new DataView(code.buffer);
    view.setUint32(0, 0x20040000, true);
    view.setUint32(4, 0x101, true);
    view.setUint16(0x100, 0xe7fe, true);
    const p = api.spike_upload(code.length + 32 * 1048576);
    new Uint8Array(api.memory.buffer, p, code.length).set(code);
    new Uint8Array(api.memory.buffer, p + code.length, 32 * 1048576).fill(255);
    assert.equal(api.spike_boot_profile(FIRMWARE_PROFILES[name].id, code.length, 32 * 1048576), 1);
    assert.equal(api.spike_frame_width(), width);
    assert.equal(api.spike_frame_height(), height);
    assert.equal(api.spike_frame_len(), width * height);
    assert.equal(api.spike_guest_frame_len(), guestLength);
    assert.equal(profileDisplay(name).width, width);
    assert.equal(profileDisplay(name).height, height);
    assert.equal(api.spike_restart(), 1);
    assert.equal(api.spike_profile(), FIRMWARE_PROFILES[name].id);
  }
});
test('firmware catalog recognizes all generic boards and keeps physical firmware separate', () => {
  for (const board of Object.keys(FIRMWARE_PROFILES)) {
    const name = board + '_v4.37.0_micro_flash.bin';
    assert.equal(fileProfile(name), board);
    assert.equal(
      describeAsset({ id: 1, name, size: 100, browser_download_url: 'https://example.test' }).board,
      board,
    );
  }
  for (const board of ['asterix', 'obelix', 'getafix']) {
    const asset = describeAsset({
      id: 1,
      name: 'normal_' + board + '_v4.37.0.pbz',
      size: 100,
      browser_download_url: 'https://example.test',
    });
    assert.equal(asset.board, board);
    assert.equal(asset.kind, 'production');
    assert.equal(fileProfile(asset.name), undefined);
  }
});
