// Live upstream smoke test: an archived collection row needs detail hydration and
// an unchanged older PBW must install on the generic Time 2 firmware.
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const output = resolve(process.env.PEBBLE_TRACE_FILE ?? 'tmp/legacy-store-browser.json');
const id = '52bb213af9846878c200015b';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/apps/') || request.url().includes('/api/assets/pbw/'))
      requests.push(request.url());
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Browse watchfaces' }).click();
  const card = page.locator('.store-result').filter({ hasText: 'Modern' });
  const tryButton = card.getByRole('button', { name: 'Try Modern' });
  await tryButton.waitFor();
  const listing = await card.innerText();
  assert.match(listing, /3\.1\.1 · Legacy build/);
  await tryButton.click();
  await page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
  assert.equal(await page.locator('.watch-session h1').innerText(), 'Modern');
  assert.deepEqual(errors, []);
  assert.ok(requests.some((url) => url.includes(`/api/v1/apps/id/${id}`)));
  assert.ok(requests.some((url) => url.includes('/api/assets/pbw/')));
  const frame = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', image.data)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    return { width: canvas.width, height: canvas.height, sha256 };
  });
  const evidence = {
    format: 'pebble-legacy-store-browser-smoke',
    version: 1,
    capturedAt: new Date().toISOString(),
    engine: 'chromium',
    viewport: { width: 390, height: 844 },
    profile: 'qemu_emery',
    appId: id,
    listing,
    title: 'Modern',
    requests,
    frame,
    pageErrors: errors,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Legacy store browse/install passed: ${output}`);
} finally {
  await browser.close();
}
