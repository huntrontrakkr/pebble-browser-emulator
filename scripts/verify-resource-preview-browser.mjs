// Real upstream store bytes and actual firmware installation. No emulation mocks.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/resource-preview-browser');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.setDefaultTimeout(120000);
const requests = [],
  errors = [],
  results = {};
page.on('request', (r) => requests.push(r.url()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(() => {
  window.resourceQa = { events: [], started: performance.now(), states: [] };
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (
          ['startup-status', 'firmware-ready', 'firmware-loaded', 'installed', 'error'].includes(
            data.type,
          )
        )
          window.resourceQa.events.push({
            type: data.type,
            profile: data.profile,
            name: data.name,
            uuid: data.uuid,
            message: data.message,
            restored: data.restored,
            source: data.source,
            at: performance.now(),
          });
        if (data.type === 'state') {
          window.resourceQa.states.push({ battery: data.state.battery, profile: data.profile });
          if (window.resourceQa.states.length > 10) window.resourceQa.states.shift();
        }
      });
    }
  };
});
const ready = async () => {
  await page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
  await page.waitForFunction(() =>
    window.resourceQa.events.some(
      (e) => e.type === 'installed' && e.uuid === 'f77d3896-63b3-4cc4-b349-f61ac75ca168',
    ),
  );
  const events = await page.evaluate(() => window.resourceQa.events);
  assert.equal(events.filter((e) => e.type === 'error').length, 0, JSON.stringify(events));
  return events;
};
try {
  await page.goto(base);
  assert.equal(await page.evaluate(() => localStorage.getItem('pebble:resource-service:v1')), null);
  await page.getByRole('button', { name: 'Browse watchfaces', exact: true }).click();
  await page.locator('.store-result').first().waitFor();
  results.catalogRows = await page.locator('.store-result').count();
  await page.screenshot({ path: resolve(out, 'store-mobile.png'), fullPage: true });
  await page
    .getByLabel('Store link', { exact: true })
    .fill('https://apps.repebble.com/justthetime_50bdea7ee3ff48308157c046');
  await page.locator('.store-link').getByRole('button', { name: 'Open', exact: true }).click();
  results.first = await ready();
  assert.ok(
    results.first.some(
      (e) => e.type === 'startup-status' && e.restored && e.source === 'published',
    ),
    'first preview uses published checkpoint',
  );
  results.link = page.url();
  assert.match(results.link, /#\/store\/50bdea7ee3ff48308157c046/);
  assert.match(
    results.link,
    /sha256=d0b5d7888ca05b48b629c2d315802184a0e737e57ea20c0067de95ca2e2263b4/,
  );
  assert.ok((await page.evaluate(() => window.resourceQa.states)).some((s) => s.battery === 69));
  assert.ok(
    !requests.some((url) => url.includes('/v1/resource')),
    'no resource service used for store preview',
  );
  await page.screenshot({ path: resolve(out, 'store-running-mobile.png'), fullPage: true });
  // Remote store and resource service are unavailable; retained package and startup state still run.
  await context.route('https://appstore-api.repebble.com/**', (route) => route.abort());
  await context.route('**/v1/resource?**', (route) => route.abort());
  await page.reload();
  results.saved = await ready();
  assert.ok(
    results.saved.some((e) => e.type === 'startup-status' && e.restored && e.source === 'device'),
  );
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByLabel('Use prepared startup state').uncheck();
  await page.getByRole('button', { name: 'Close preferences', exact: true }).click();
  await page.reload();
  results.cold = await ready();
  assert.ok(!results.cold.some((e) => e.type === 'startup-status' && e.restored));
  assert.equal(errors.length, 0, errors.join('\n'));
  results.directRequests = requests.filter((url) => url.includes('appstore-api.repebble.com'));
  results.errors = errors;
  await writeFile(resolve(out, 'result.json'), JSON.stringify(results, null, 2));
  console.log(
    'Store catalog, real PBW preview, pinned link, prepared boot, local-cache reopening and cold-boot fallback passed.',
  );
} catch (error) {
  await writeFile(
    resolve(out, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        results,
        requests,
        events: await page.evaluate(() => window.resourceQa?.events).catch(() => null),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
