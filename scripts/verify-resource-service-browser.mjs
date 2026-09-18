// Real GitHub release downloads through the optional local service, using the UI.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const endpoint = process.env.PEBBLE_RESOURCE_SERVICE ?? 'http://127.0.0.1:4318';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/resource-service-browser');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(120000);
const downloads = [],
  errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('response', (response) => {
  if (response.url().startsWith(endpoint + '/v1/resource?'))
    downloads.push({ url: response.url(), status: response.status(), headers: response.headers() });
});
await page.addInitScript(() => {
  window.firmwareQa = [];
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (['firmware-loaded', 'error'].includes(data.type)) window.firmwareQa.push(data);
      });
    }
  };
});
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByLabel('Service URL', { exact: true }).fill(endpoint);
  await page.getByLabel('Use a download service', { exact: true }).check();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByText('Download service is reachable.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Developer tools', exact: true }).click();
  await page.getByLabel('Release tag', { exact: true }).fill('v4.37.0');
  await page.getByRole('button', { name: 'Find release', exact: true }).click();
  await page.getByRole('button', { name: 'Load selected firmware', exact: true }).click();
  await page
    .getByText('Firmware downloaded and loaded.', { exact: true })
    .waitFor({ state: 'attached' });
  await page.waitForFunction(() => window.firmwareQa.some((e) => e.type === 'firmware-loaded'));
  assert.equal(downloads.length, 2, JSON.stringify(downloads));
  for (const response of downloads) {
    assert.equal(response.status, 200);
    assert.match(response.headers['x-resource-sha256'], /^[a-f0-9]{64}$/);
    assert.match(
      new URL(response.url).searchParams.get('url'),
      /\/qemu_emery_v4\.37\.0_(micro|spi)_flash\.bin$/,
    );
  }
  // With both upstream downloads and service unavailable, checksummed local files still load.
  await page.route('https://github.com/**/releases/download/**', (route) => route.abort());
  await page.route(endpoint + '/**', (route) => route.abort());
  await page.evaluate(() => (window.firmwareQa = []));
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByLabel('Use a download service', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Close preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Developer tools', exact: true }).click();
  await page.getByRole('button', { name: 'Firmware', exact: true }).click();
  await page.getByRole('button', { name: 'Load selected firmware', exact: true }).click();
  await page.waitForFunction(() => window.firmwareQa.some((e) => e.type === 'firmware-loaded'));
  assert.equal(downloads.length, 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  const events = await page.evaluate(() => window.firmwareQa);
  assert.equal(events.filter((e) => e.type === 'error').length, 0, JSON.stringify(events));
  await page.screenshot({ path: resolve(out, 'firmware-download.png'), fullPage: true });
  await writeFile(
    resolve(out, 'result.json'),
    JSON.stringify({ downloads, cachedWithoutService: events, errors }, null, 2),
  );
  console.log(
    'Real firmware pair downloaded through opt-in service; cached pair loads with service disabled and upstream unavailable.',
  );
} catch (error) {
  await writeFile(
    resolve(out, 'failure.json'),
    JSON.stringify(
      { error: String(error), downloads, errors, body: await page.locator('body').innerText() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
