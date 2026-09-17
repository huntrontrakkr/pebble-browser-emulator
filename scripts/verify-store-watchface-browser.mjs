// Acceptance of the original JustTheTime store package; never substitutes app/firmware code.
// Download the pinned PBW separately (see docs/STORE_WATCHFACE_TEST.md).
import { chromium, firefox, webkit } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const pbw = process.env.PEBBLE_STORE_PBW;
assert.ok(pbw, 'Set PEBBLE_STORE_PBW to the original JustTheTime 1.2 store download.');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageSha256 = sha256(await readFile(pbw));
assert.equal(packageSha256, 'd0b5d7888ca05b48b629c2d315802184a0e737e57ea20c0067de95ca2e2263b4');
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/store-watchface-browser');
await mkdir(out, { recursive: true });
const results = [];
const settings = (page) =>
  page.frameLocator('iframe[title="Pebble app settings"]').frameLocator('#configuration-page');
async function openSettings(page) {
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('button', { name: 'Close app settings' }).scrollIntoViewIfNeeded();
  await page
    .frameLocator('iframe[title="Pebble app settings"]')
    .getByRole('button', { name: 'Back', exact: true })
    .waitFor();
  await settings(page).getByRole('button', { name: 'Save Settings', exact: true }).waitFor();
}
async function capture(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
    const rgba = Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
    let white = 0,
      black = 0,
      visible = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (!rgba[i + 3]) continue;
      visible++;
      if (rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255) white++;
      if (!rgba[i] && !rgba[i + 1] && !rgba[i + 2]) black++;
    }
    return {
      width: c.width,
      height: c.height,
      rgba,
      whiteFraction: white / visible,
      blackFraction: black / visible,
    };
  });
}
async function waitForSettledFrame(page) {
  await page.evaluate(() => {
    delete window.storeQa.settledFrame;
  });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
      const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const previous = window.storeQa.settledFrame;
      if (!previous || pixels.some((v, i) => v !== previous.pixels[i])) {
        window.storeQa.settledFrame = { pixels, since: performance.now() };
        return false;
      }
      return performance.now() - previous.since >= 300;
    },
    undefined,
    { polling: 100 },
  );
}
for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium').split(',')) {
  const browser = await { chromium, firefox, webkit }[engine].launch({
    ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
      ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
      : {}),
  });
  try {
    for (const profile of (
      process.env.PEBBLE_PROFILES ?? 'qemu_emery,qemu_flint,qemu_gabbro'
    ).split(',')) {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        ...(engine !== 'firefox' ? { deviceScaleFactor: 2, isMobile: true } : {}),
      });
      page.setDefaultTimeout(90000);
      const errors = [],
        requests = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('request', (r) => {
        if (/^https?:/.test(r.url())) requests.push(r.url());
      });
      await page.addInitScript(() => {
        window.storeQa = { events: [], commands: [] };
        const Original = Worker;
        window.Worker = class extends Original {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({ data }) => {
              if (data.type === 'installed')
                window.storeQa.events.push({ type: data.type, uuid: data.uuid, name: data.name });
              if (['error', 'appmessage'].includes(data.type)) window.storeQa.events.push(data);
              if (data.type === 'event' && data.event.text) window.storeQa.events.push(data);
            });
          }
          postMessage(data, ...args) {
            if (['appmessage', 'configurationClosed', 'ack'].includes(data.type))
              window.storeQa.commands.push(data);
            super.postMessage(data, ...args);
          }
        };
      });
      try {
        console.log(`${engine} ${profile}: installing original store PBW`);
        await page.goto(base);
        await page.locator('preview-panel select').selectOption(profile);
        await page.locator('preview-panel input[accept=".pbw"]').setInputFiles(pbw);
        await page
          .getByText('Ready. Use the watch buttons to interact.', { exact: true })
          .waitFor();
        // Require the actual watchface, rather than a black firmware transition screen.
        await page.waitForFunction(() => {
          const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
          const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let black = 0,
            other = 0;
          for (let i = 0; i < p.length; i += 4)
            if (p[i + 3]) {
              if (!p[i] && !p[i + 1] && !p[i + 2]) black++;
              else other++;
            }
          return black > c.width * c.height * 0.9 && other > 100;
        });
        await waitForSettledFrame(page);
        const before = await capture(page);
        await page.screenshot({
          path: resolve(out, `${engine}-${profile}-before.png`),
          fullPage: true,
        });
        await openSettings(page);
        const f = settings(page);
        await f.getByText('Background', { exact: true }).click();
        await f.locator('.component-color').first().locator('[data-value="16777215"]').click();
        assert.equal(await f.locator('.component-color input').first().inputValue(), '16777215');
        await page.screenshot({
          path: resolve(out, `${engine}-${profile}-settings.png`),
          fullPage: true,
        });
        console.log(`${engine} ${profile}: saving real Clay settings`);
        await f.getByRole('button', { name: 'Save Settings', exact: true }).click();
        await page
          .getByRole('button', { name: 'Close app settings' })
          .waitFor({ state: 'detached' });
        await page.waitForFunction(() =>
          window.storeQa.events.some(
            (e) => e.type === 'event' && e.event.text === 'Sent config data to Pebble',
          ),
        );
        await page.waitForFunction(() => {
          const c = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
          const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let white = 0;
          for (let i = 0; i < p.length; i += 4)
            if (p[i] === 255 && p[i + 1] === 255 && p[i + 2] === 255 && p[i + 3]) white++;
          return white > c.width * c.height * 0.6;
        });
        await waitForSettledFrame(page);
        const after = await capture(page);
        assert.ok(after.whiteFraction > before.whiteFraction + 0.5);
        await page.screenshot({
          path: resolve(out, `${engine}-${profile}-after.png`),
          fullPage: true,
        });
        const state = await page.evaluate(() => window.storeQa);
        const sent = state.commands.filter((c) => c.type === 'appmessage');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].payload['10000'], 16777215);
        assert.ok(
          state.events.some((e) => e.type === 'appmessage' && e.message.kind === 'ack'),
          'Unmodified firmware must acknowledge the message',
        );
        assert.ok(
          state.commands.some(
            (c) => c.type === 'ack' && c.accepted && c.transactionId === sent[0].transactionId,
          ),
        );
        assert.ok(
          state.events.some(
            (e) => e.type === 'installed' && e.uuid === 'f77d3896-63b3-4cc4-b349-f61ac75ca168',
          ),
        );
        assert.deepEqual(
          state.events.filter((e) => e.type === 'error'),
          [],
        );
        await openSettings(page);
        assert.equal(
          await settings(page).locator('.component-color input').first().inputValue(),
          '16777215',
          'Clay must reopen with saved app-scoped settings',
        );
        // The real native companion Back button cancels without another AppMessage.
        await page
          .frameLocator('iframe[title="Pebble app settings"]')
          .locator('canvas')
          .click({ position: { x: 28, y: 32 } });
        await page
          .getByRole('button', { name: 'Close app settings' })
          .waitFor({ state: 'detached' });
        assert.equal(
          await page.evaluate(
            () => window.storeQa.commands.filter((c) => c.type === 'appmessage').length,
          ),
          1,
        );
        assert.equal(
          await page.evaluate(
            () =>
              window.storeQa.commands.filter((c) => c.type === 'configurationClosed').at(-1)
                .response,
          ),
          null,
        );
        assert.deepEqual(errors, []);
        const externalRequests = requests.filter(
          (url) => new URL(url).origin !== new URL(base).origin,
        );
        assert.deepEqual(
          externalRequests,
          [],
          'This offline Clay watchface needs no third-party runtime requests',
        );
        let changedPixels = 0;
        for (let i = 0; i < before.rgba.length; i += 4)
          if (before.rgba.slice(i, i + 4).some((v, j) => v !== after.rgba[i + j])) changedPixels++;
        results.push({
          engine,
          browserVersion: browser.version(),
          profile,
          passed: true,
          packageSha256,
          firmware: '4.37.0',
          width: before.width,
          height: before.height,
          beforeFrameSha256: sha256(Buffer.from(before.rgba)),
          afterFrameSha256: sha256(Buffer.from(after.rgba)),
          changedPixels,
          beforeWhiteFraction: before.whiteFraction,
          afterWhiteFraction: after.whiteFraction,
          appMessage: sent[0].payload,
          firmwareAck: true,
          reopenedSavedSettings: true,
          nativeBackCancelled: true,
          externalRequests,
          errors,
        });
        console.log(`${engine} ${profile}: passed (${changedPixels} changed pixels)`);
      } catch (error) {
        results.push({ engine, profile, passed: false, error: String(error), errors });
        await page
          .screenshot({ path: resolve(out, `${engine}-${profile}-failure.png`), fullPage: true })
          .catch(() => {});
        await writeFile(
          resolve(out, `${engine}-${profile}-failure.json`),
          JSON.stringify(await page.evaluate(() => window.storeQa), null, 2),
        );
        throw error;
      } finally {
        await writeFile(
          resolve(out, 'results.json'),
          JSON.stringify(
            {
              testedAt: new Date().toISOString(),
              base,
              storeListing: 'https://apps.repebble.com/justthetime_50bdea7ee3ff48308157c046',
              storeVersion: '1.2',
              packageVersionLabel: '1.1',
              results,
            },
            null,
            2,
          ) + '\n',
        );
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
