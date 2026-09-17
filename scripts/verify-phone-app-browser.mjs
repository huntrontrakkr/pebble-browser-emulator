// Actual Kotlin/Wasm companion, sandboxed HTML, QuickJS Worker and unchanged watch firmware.
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/phone-app-browser');
await mkdir(out, { recursive: true });
const results = [];
const frameState = async (page) =>
  page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let black = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] === 0 && pixels[i + 3] === 255) black++;
    return {
      blackFraction: black / (c.width * c.height),
      frame: Array.from(window.phoneQa.frame ?? []),
    };
  });
const settingsFrame = (page) =>
  page.frameLocator('iframe[title="Pebble app settings"]').frameLocator('#configuration-page');
async function openSettings(page) {
  await page.getByRole('button', { name: 'App configuration', exact: true }).click();
  await settingsFrame(page).getByRole('button', { name: 'Save', exact: true }).waitFor();
  // Compose renders its canvas on demand and clips to the visible browser viewport.
  await page.getByRole('button', { name: 'Close app settings' }).scrollIntoViewIfNeeded();
  await page
    .frameLocator('iframe[title="Pebble app settings"]')
    .getByRole('button', { name: 'Back', exact: true })
    .waitFor();
}
for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await { chromium, firefox, webkit }[engine].launch({
    ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
      ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
      : {}),
  });
  for (const profile of (
    process.env.PEBBLE_PROFILES ??
    (engine === 'chromium' ? 'qemu_emery,qemu_flint,qemu_gabbro' : 'qemu_emery')
  ).split(',')) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      ...(engine !== 'firefox' ? { deviceScaleFactor: 2, isMobile: true } : {}),
    });
    page.setDefaultTimeout(90000);
    const errors = [],
      requests = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => requests.push(r.url()));
    await page.addInitScript(() => {
      window.phoneQa = { commands: [], events: [], frame: null };
      const Original = Worker;
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (['appmessage', 'event', 'error', 'installed'].includes(data.type))
              window.phoneQa.events.push(data);
            if (data.type === 'state' && data.state.framebuffer)
              window.phoneQa.frame = data.state.framebuffer;
          });
        }
        postMessage(data, ...args) {
          if (['appmessage', 'configurationClosed'].includes(data.type))
            window.phoneQa.commands.push(data);
          super.postMessage(data, ...args);
        }
      };
    });
    try {
      await page.goto(base);
      assert.equal(
        requests.some((u) => u.includes('/phone-app/')),
        false,
        'Companion must load only on demand',
      );
      await page.goto(`${base}#/example/clock?watch=${profile}`);
      await page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
      await page.waitForFunction(() => window.phoneQa.frame?.length > 0);
      // Wait until the installed face is displayed rather than a firmware transition frame.
      await page.waitForFunction(() => {
        const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
        const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < p.length; i += 4) if (!p[i]) n++;
        return n > 1000 && n < c.width * c.height * 0.4;
      });
      const before = await frameState(page);
      const started = Date.now();
      await openSettings(page);
      const settingsLoadMs = Date.now() - started;
      const panel = page.frameLocator('iframe[title="Pebble app settings"]');
      const bounds = await panel
        .locator('#configuration-page')
        .evaluate((el) => ({ top: el.offsetTop, width: el.clientWidth, viewport: innerWidth }));
      assert.ok(
        bounds.top >= 60 && bounds.top <= 80,
        'Native header height must use CSS pixels at DPR 2',
      );
      assert.equal(bounds.width, bounds.viewport);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await settingsFrame(page)
          .locator('body')
          .evaluate(() => {
            try {
              return parent.document.body != null;
            } catch {
              return false;
            }
          }),
        false,
        'Config cannot access host DOM',
      );
      const savedCommands = await page.evaluate(() => window.phoneQa.commands.length);
      // Even a sender that knows the nonce cannot impersonate the actual child window.
      await page.evaluate(() => {
        const f = document.querySelector('iframe[title="Pebble app settings"]');
        const session = new URL(f.src).searchParams.get('session');
        window.postMessage(
          { type: 'configuration-result', session, response: 'forged' },
          location.origin,
        );
      });
      await settingsFrame(page).getByLabel('Dark background').check();
      await page.screenshot({
        path: resolve(out, `${engine}-${profile}-settings.png`),
        fullPage: true,
      });
      assert.equal(await page.evaluate(() => window.phoneQa.commands.length), savedCommands);
      // A bundled form must save without navigating back to a static server.
      // The initial callback has not been cached; the old implementation fails here.
      await page.context().setOffline(true);
      await settingsFrame(page).getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: 'Close app settings' }).waitFor({ state: 'detached' });
      await page.waitForFunction(() =>
        window.phoneQa.events.some(
          (e) => e.type === 'event' && e.event.text === 'Clock settings acknowledged by watch',
        ),
      );
      await page.context().setOffline(false);
      assert.deepEqual(
        requests.filter((url) => url.includes('/phone-app/return')),
        [],
      );
      await page.waitForFunction(() => {
        const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
        const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < p.length; i += 4) if (!p[i]) n++;
        return n > c.width * c.height * 0.6;
      });
      const after = await frameState(page);
      assert.ok(after.blackFraction > before.blackFraction + 0.4);
      const commands = await page.evaluate(() => window.phoneQa.commands);
      const message = commands.find((c) => c.type === 'appmessage');
      assert.deepEqual(message.payload, { 0: 1, 1: 1, 2: 1 });
      assert.deepEqual(
        JSON.parse(commands.find((c) => c.type === 'configurationClosed').response),
        { DARK_MODE: 1, SHOW_DATE: 1, SHOW_BATTERY: 1 },
      );
      await openSettings(page);
      assert.equal(await settingsFrame(page).getByLabel('Dark background').isChecked(), true);
      await settingsFrame(page).getByLabel('Dark background').uncheck();
      await settingsFrame(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Close app settings' }).waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(
          () => window.phoneQa.commands.filter((c) => c.type === 'appmessage').length,
        ),
        1,
        'Cancel sends no settings AppMessage',
      );
      await openSettings(page);
      // Exercise the actual Kotlin/Compose Back control, not the host's Close button.
      await page
        .frameLocator('iframe[title="Pebble app settings"]')
        .locator('canvas')
        .click({ position: { x: 28, y: 32 } });
      await page.getByRole('button', { name: 'Close app settings' }).waitFor({ state: 'detached' });
      await page.reload();
      await page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
      await page.waitForFunction(() =>
        window.phoneQa.events.some(
          (e) => e.type === 'event' && e.event.text === 'Clock settings acknowledged by watch',
        ),
      );
      await page.waitForFunction(() => {
        const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
        const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let black = 0;
        for (let i = 0; i < p.length; i += 4) if (!p[i]) black++;
        return black > c.width * c.height * 0.6;
      });
      await openSettings(page);
      assert.equal(await settingsFrame(page).getByLabel('Dark background').isChecked(), true);
      assert.ok((await frameState(page)).blackFraction > 0.6);
      await page.getByRole('button', { name: 'Close app settings' }).click();
      assert.deepEqual(errors, []);
      assert.deepEqual(
        requests.filter(
          (u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'),
        ),
        [],
        'Local settings flow makes no external requests',
      );
      const sha = (frame) => createHash('sha256').update(Uint8Array.from(frame)).digest('hex');
      results.push({
        engine,
        browser: browser.version(),
        profile,
        passed: true,
        viewport: '390x844',
        settingsLoadMs,
        beforeFrame: sha(before.frame),
        afterFrame: sha(after.frame),
        beforeBlackFraction: before.blackFraction,
        afterBlackFraction: after.blackFraction,
        appMessage: message.payload,
        assertions: [
          'lazy loading',
          'native header at device scale',
          'sandbox isolation',
          'forged sender rejected',
          'decoded return',
          'local save with network disconnected and no callback request',
          'real firmware ACK',
          'frame changes',
          'cancel',
          'native Back',
          'persistent reopen/reload',
        ],
      });
      console.log(engine, profile, 'passed', settingsLoadMs + 'ms settings load');
    } catch (error) {
      console.error(engine, profile, error);
      await page
        .screenshot({ path: resolve(out, `${engine}-${profile}-failure.png`), fullPage: true })
        .catch(() => {});
      await writeFile(
        resolve(out, `${engine}-${profile}-failure.txt`),
        await page.locator('body').innerText(),
      );
      results.push({ engine, profile, passed: false, error: String(error), errors });
    } finally {
      await page.close();
    }
  }
  await browser.close();
}
await writeFile(
  resolve(out, 'phone-app-browser.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        'Desktop Linux browser engines at mobile viewport. Actual source-ported companion, Clock HTML and PKJS, unchanged 4.37.0 firmware. Not physical-phone performance or full Android app emulation.',
      upstream: JSON.parse(await readFile('phone-app/upstream.json', 'utf8')),
      results,
    },
    null,
    2,
  ) + '\n',
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
