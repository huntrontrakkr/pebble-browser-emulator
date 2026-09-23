// Preview's upstream phone, driven only through the built site's own controls in Chromium:
// start the example (Clock) on the released firmware, connect the upstream phone on the
// Phone tab, install the package through it, open App configuration, change a setting in
// the app's own page and save. Passes when libpebble3 reports Clock running, Clock's
// PebbleKit JS logs the watch's acknowledgement and the watch's framebuffer changes.
//
// With PEBBLE_STORE_PBW (the pinned JustTheTime 1.2 store download, docs/STORE_WATCHFACE_TEST.md)
// it does the same for that store watchface and its Clay settings page.
// Usage: node preview-e2e.mjs <built site, e.g. dist/client> [profiles]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const root = resolve(process.argv[2]);
const profiles = (process.argv[3] ?? 'qemu_emery').split(',');
const CLOCK = 'c61ace0a-d61a-47ce-9d04-f46a78849ec6';
const STORE = 'f77d3896-63b3-4cc4-b349-f61ac75ca168';
const STORE_SHA256 = 'd0b5d7888ca05b48b629c2d315802184a0e737e57ea20c0067de95ca2e2263b4';
const store = process.env.PEBBLE_STORE_PBW;
if (store) {
  const hash = createHash('sha256')
    .update(await readFile(store))
    .digest('hex');
  if (hash !== STORE_SHA256)
    throw new Error(`PEBBLE_STORE_PBW is not the pinned download (${hash})`);
}

const { url, close } = await serve(root);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

/** Fraction of visible framebuffer pixels that are pure black and pure white. */
const frame = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
    const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let black = 0,
      white = 0,
      visible = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (!p[i + 3]) continue;
      visible++;
      if (!p[i] && !p[i + 1] && !p[i + 2]) black++;
      if (p[i] === 255 && p[i + 1] === 255 && p[i + 2] === 255) white++;
    }
    return { black: black / visible, white: white / visible };
  });

/** Waits until the framebuffer has not changed for 500 ms. */
const settled = (page) =>
  page.waitForFunction(
    () => {
      const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
      const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const last = window.previewE2e.frame;
      if (!last || pixels.some((v, i) => v !== last.pixels[i])) {
        window.previewE2e.frame = { pixels, since: performance.now() };
        return false;
      }
      return performance.now() - last.since >= 500;
    },
    undefined,
    { polling: 100, timeout: 60000 },
  );

const console_ = (page, text, timeout = 60000) =>
  page.waitForFunction(
    (text) => window.previewE2e.console.some((line) => line.includes(text)),
    text,
    { timeout },
  );

async function run(profile, app) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(120000);
  // Uncaught exceptions fail the run. Console errors are reported only: libpebble3
  // logs some watch replies it does not understand at error level.
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)));
  // Records what the phone worker reports, as the page's own log does.
  await page.addInitScript(() => {
    window.previewE2e = { console: [] };
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data?.type === 'pkjs-console')
            window.previewE2e.console.push(`[${data.app}] ${data.text}`);
        });
      }
    };
  });
  const steps = [];
  const step = (text) => (steps.push(text), console.log(`${profile} ${app.name}: ${text}`));
  try {
    await page.goto(url);
    await page.locator('preview-panel select').selectOption(profile);
    if (app.file) await page.locator('preview-panel input[accept=".pbw"]').setInputFiles(app.file);
    else await page.getByRole('button', { name: 'Try example' }).click();
    await page
      .getByText('Ready. Use the watch buttons to interact.', { exact: true })
      .waitFor({ timeout: 300000 });
    step('running on the built-in phone');

    await page.getByRole('button', { name: 'Developer tools' }).click();
    await page.locator('nav.tabs button', { hasText: 'Phone' }).click();
    const section = page.locator('section.upstream-phone');
    const status = section.locator('[role=status]');
    await section.getByRole('button', { name: 'Connect upstream phone' }).click();
    await page.waitForFunction(
      () =>
        /^(Connected|Failed)/.test(
          document.querySelector('section.upstream-phone [role=status]')?.textContent.trim(),
        ),
      undefined,
      { timeout: 120000 },
    );
    if ((await status.textContent()).trim() !== 'Connected')
      throw new Error(await status.textContent());
    step('upstream phone connected');

    await section.getByRole('button', { name: /^Install .* through it$/ }).click();
    await page.waitForFunction(
      () =>
        /^(Installed|Failed)/.test(
          document.querySelector('section.upstream-phone [role=status]')?.textContent.trim(),
        ),
      undefined,
      { timeout: 180000 },
    );
    if (!/^Installed/.test((await status.textContent()).trim()))
      throw new Error(await status.textContent());
    await page.waitForFunction(
      ([uuid]) => document.querySelector('section.upstream-phone')?.textContent.includes(uuid),
      [app.uuid],
      { timeout: 60000 },
    );
    step(`installed through libpebble3; watch reports ${app.uuid} running`);
    await settled(page);
    const before = await frame(page);

    await section.getByRole('button', { name: 'App configuration', exact: true }).click();
    const settings = page
      .frameLocator('iframe[title="Pebble app settings"]')
      .frameLocator('#configuration-page');
    await app.change(settings);
    step('settings saved in the app page');
    await console_(page, app.acknowledged, 60000);
    step(`PebbleKit JS: ${app.acknowledged}`);
    await page.waitForFunction(
      ([before, key]) => {
        const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
        const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let hits = 0,
          visible = 0;
        for (let i = 0; i < p.length; i += 4) {
          if (!p[i + 3]) continue;
          visible++;
          const v = key === 'white' ? 255 : 0;
          if (p[i] === v && p[i + 1] === v && p[i + 2] === v) hits++;
        }
        return hits / visible > before + 0.3;
      },
      [before[app.becomes], app.becomes],
      { timeout: 30000 },
    );
    await settled(page);
    const after = await frame(page);
    step(
      `framebuffer ${app.becomes} ${before[app.becomes].toFixed(2)} → ${after[app.becomes].toFixed(2)}`,
    );
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    return { profile, app: app.name, ok: true, steps, consoleErrors };
  } catch (error) {
    await page
      .screenshot({ path: `preview-e2e-${profile}-${app.name}.png`, fullPage: true })
      .catch(() => {});
    return {
      profile,
      app: app.name,
      ok: false,
      error: error.message.split('\n')[0],
      steps,
      console: await page.evaluate(() => window.previewE2e.console.slice(-20)).catch(() => []),
      errors,
      consoleErrors,
    };
  } finally {
    await page.close();
  }
}

const clock = {
  name: 'Clock',
  uuid: CLOCK,
  acknowledged: 'Clock settings acknowledged by watch',
  // Clock starts on a white background; its dark mode is black.
  becomes: 'black',
  async change(settings) {
    await settings.locator('#DARK_MODE').check();
    await settings.getByRole('button', { name: 'Save' }).click();
  },
};
const justTheTime = {
  name: 'JustTheTime',
  uuid: STORE,
  file: store,
  acknowledged: 'Sent config data to Pebble',
  becomes: 'white',
  async change(settings) {
    await settings.getByText('Background', { exact: true }).click();
    await settings.locator('.component-color').first().locator('[data-value="16777215"]').click();
    await settings.getByRole('button', { name: 'Save Settings', exact: true }).click();
  },
};

const results = [];
for (const profile of profiles) {
  results.push(await run(profile, clock));
  if (store) results.push(await run(profile, justTheTime));
}
console.log('PREVIEW E2E', JSON.stringify(results, null, 2));
await browser.close();
close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
