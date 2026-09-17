// Actual browser interaction gate. Supply licensed firmware and a locally built sensor PBW.
import { chromium, firefox, webkit } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/browser-workflow');
const required = (name) => {
  if (!process.env[name]) throw new Error('Set ' + name + '.');
  return resolve(process.env[name]);
};
const firmware = required('PEBBLE_FIRMWARE_DIR');
const pbw = required('PEBBLE_SENSOR_PBW');
const reference = required('PEBBLE_SENSOR_REFERENCE');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expected = hash(await readFile(reference));
const wasmSha256 = hash(
  new Uint8Array(await (await fetch(new URL('wasm/qemu-emery.wasm', base))).arrayBuffer()),
);
const engines = { chromium, firefox, webkit };
const names = (process.env.PEBBLE_BROWSERS ?? 'chromium,firefox,webkit').split(',');
await mkdir(out, { recursive: true });
const results = [];
for (const name of names) {
  if (!engines[name]) throw new Error('Unknown browser engine: ' + name);
  let browser, page;
  const errors = [],
    requests = [];
  try {
    browser = await engines[name].launch({
      headless: true,
      ...(name === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
        : {}),
    });
    page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => requests.push(request.url()));
    page.setDefaultTimeout(90000);
    const click = async (label) => {
      console.log(name, label);
      await page.getByRole('button', { name: label, exact: true }).click();
    };
    await page.goto(base);
    await click('Developer tools');
    await page.getByText('Core ready', { exact: true }).waitFor();
    await page
      .getByLabel('Open micro flash .bin / .elf', { exact: true })
      .setInputFiles(resolve(firmware, 'qemu_emery_v4.37.0_micro_flash.bin'));
    await page
      .getByLabel('Open SPI flash .bin', { exact: true })
      .setInputFiles(resolve(firmware, 'qemu_emery_v4.37.0_spi_flash.bin'));
    await click('Load firmware');
    await click('Run');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (button) =>
          button.textContent.trim() === 'Set acceleration' && !button.matches(':disabled'),
      ),
    );
    await click('Projects');
    await page.getByLabel('Open .pbw', { exact: true }).setInputFiles(pbw);
    await click('Install on watch');
    await page
      .locator('.install-status')
      .filter({
        hasText: 'Installed and launched: e67ab299-1a68-4bd2-a6c7-401bdd056df8',
      })
      .waitFor();
    await click('Inputs');
    await click('Apply health settings');
    await page.getByText('Firmware accepted the health preferences.', { exact: true }).waitFor();
    for (const [label, value] of [
      ['X (mg)', '111'],
      ['Y (mg)', '-222'],
      ['Z (mg)', '-999'],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    await click('Set acceleration');
    await page.getByRole('combobox', { name: /^Direction/ }).selectOption({ label: 'Negative' });
    await click('Send tap');
    await page.getByLabel('Heading (° counterclockwise)', { exact: true }).fill('90');
    await click('Set compass');
    await page.getByLabel('Value', { exact: true }).fill('1234');
    await click('Set health value');
    await page.getByLabel('Heart rate (BPM)', { exact: true }).fill('88');
    await click('Set heart rate');
    await page.getByLabel('X (px)', { exact: true }).fill('30');
    await page.getByLabel('Y (px)', { exact: true }).fill('40');
    await click('Touch / move');
    // Read the actual canvas. No guest state or UI component is patched by this test.
    await page.waitForFunction(
      (expected) => {
        const canvas = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        if (pixels.length !== expected.length * 4) return false;
        for (let i = 0; i < expected.length; i++) {
          const actual =
            (Math.round(pixels[4 * i + 3] / 85) << 6) |
            (Math.round(pixels[4 * i] / 85) << 4) |
            (Math.round(pixels[4 * i + 1] / 85) << 2) |
            Math.round(pixels[4 * i + 2] / 85);
          if (actual !== expected[i]) return false;
        }
        return true;
      },
      [...(await readFile(reference))],
    );
    await click('Pause');
    await page.getByText('Frame comparison', { exact: true }).click();
    const framePanel = page.locator('frame-panel');
    await page.getByLabel('Load reference', { exact: true }).setInputFiles(reference);
    await framePanel.locator('[role="status"]').waitFor({ timeout: 10000 });
    assert.match(await framePanel.innerText(), /Exact match/);
    const download = page.waitForEvent('download');
    await click('Save current frame');
    const saved = await download;
    await saved.saveAs(resolve(out, name + '.pbf'));
    assert.equal(hash((await readFile(resolve(out, name + '.pbf'))).subarray(12)), expected);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const externalRequests = [
      ...new Set(requests.filter((url) => new URL(url).origin !== new URL(base).origin)),
    ];
    assert.deepEqual(externalRequests, [], 'Local firmware workflow made external requests');
    results.push({
      browser: name,
      version: browser.version(),
      passed: true,
      frameSha256: expected,
      errors,
      externalRequests,
    });
    console.log(name, 'passed');
  } catch (error) {
    results.push({
      browser: name,
      version: browser?.version(),
      passed: false,
      error: String(error),
      errors,
    });
    console.error(name, String(error));
    if (page) {
      await writeFile(
        resolve(out, name + '-failed.txt'),
        await page
          .locator('body')
          .innerText()
          .catch(() => 'Page unavailable'),
      );
      await page
        .screenshot({ path: resolve(out, name + '-failed.png'), fullPage: true })
        .catch(() => {});
    }
  } finally {
    await browser?.close();
    await writeFile(
      resolve(out, 'browser-workflow.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          base,
          sensorPbwSha256: hash(await readFile(pbw)),
          wasmSha256,
          referenceSha256: expected,
          results,
          scope:
            'Linux browser engines, Emery 4.37.0, local PBW install and sensor/frame UI. Actual Edge and macOS Safari remain separate gates.',
        },
        null,
        2,
      ) + '\n',
    );
  }
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
