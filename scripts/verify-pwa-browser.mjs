// Real production build, service worker, offline firmware boot and companion settings.
// A subdirectory server and a new worker version exercise scoped installation and safe updates.
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('dist/client');
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/pwa-browser');
await mkdir(out, { recursive: true });
let revision = 1;
let serverOffline = false;
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};
const server = createServer(async (request, response) => {
  if (serverOffline) {
    request.socket.destroy();
    return;
  }
  try {
    const url = new URL(request.url, 'http://localhost');
    assert.ok(url.pathname.startsWith('/emulator/'));
    const path = resolve(
      root,
      decodeURIComponent(url.pathname.slice('/emulator/'.length)) || 'index.html',
    );
    assert.ok(path.startsWith(root + sep));
    let bytes = await readFile(path);
    if (path === resolve(root, 'sw.js'))
      bytes = Buffer.from(
        bytes
          .toString()
          .replace(/const VERSION = "([^"]+)";/, `const VERSION = "$1-qa-${revision}";`),
      );
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/emulator/`;
const results = [];
try {
  for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium,webkit').split(',')) {
    revision = 1;
    serverOffline = false;
    const browser = await { chromium, firefox, webkit }[engine].launch({
      ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      ...(engine !== 'firefox' ? { isMobile: true, deviceScaleFactor: 2 } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    const configurationReturns = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.includes('/phone-app/return'))
        configurationReturns.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    const shot = (name) =>
      page.screenshot({ path: resolve(out, `${engine}-${name}.png`), fullPage: true });
    const ready = () =>
      page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
    const preferences = () =>
      page.getByRole('button', { name: 'Preferences', exact: true }).click();
    const done = () => page.getByRole('button', { name: 'Close preferences', exact: true }).click();
    const settings = () =>
      page.frameLocator('iframe[title="Pebble app settings"]').frameLocator('#configuration-page');
    // WPE 26.6's protocol offline mode rejects even a minimal SW-only navigation.
    // Cut off the real server instead for WebKit; do not substitute cached responses.
    const offlineMode = engine === 'webkit' ? 'server sockets disabled' : 'browser network offline';
    const setOffline = async (value) => {
      if (engine === 'webkit') serverOffline = value;
      else await context.setOffline(value);
      if (value)
        assert.equal(
          await page.evaluate(async (base) => {
            try {
              await fetch(base + 'uncached-offline-probe', { cache: 'no-store' });
              return false;
            } catch {
              return true;
            }
          }, base),
          true,
          'An uncached network request must fail',
        );
    };
    try {
      await page.goto(base);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await shot('first');
      let installability;
      if (engine === 'chromium') {
        const cdp = await context.newCDPSession(page);
        installability = await cdp.send('Page.getInstallabilityErrors');
        assert.deepEqual(installability.installabilityErrors, []);
        await cdp.detach();
      }
      await preferences();
      await page.getByRole('button', { name: 'Download for offline use', exact: true }).click();
      await page
        .getByText('This watch and its example are ready offline.', { exact: true })
        .waitFor();
      const downloadSize = await page.locator('.offline-state').innerText();
      await shot('offline-preferences');
      await done();
      await page.getByRole('button', { name: 'Try example', exact: true }).click();
      await ready();
      await page
        .getByRole('button', { name: 'App configuration', exact: true })
        .waitFor({ state: 'visible' });
      const configBounds = await page
        .getByRole('button', { name: 'App configuration', exact: true })
        .boundingBox();
      assert.ok(
        configBounds.y + configBounds.height <= 844,
        'Configuration must be reachable in the first mobile viewport',
      );
      for (const name of ['Back', 'Up', 'Select', 'Down']) {
        const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(
          bounds.width >= 44 && bounds.height >= 44,
          `${name} needs a finger-sized hit area`,
        );
      }
      await shot('watch');
      await page.getByRole('button', { name: 'App configuration', exact: true }).click();
      await settings().getByRole('button', { name: 'Save', exact: true }).waitFor();
      assert.equal(
        await page.locator('.phone-surface').evaluate((el) => el.matches(':modal')),
        true,
      );
      await shot('phone');
      await settings().getByLabel('Dark background').check();
      await settings().getByRole('button', { name: 'Save', exact: true }).click();
      await page
        .getByRole('button', { name: 'Close app settings', exact: true })
        .waitFor({ state: 'detached' });
      assert.deepEqual(configurationReturns, [], 'Local settings must not request a callback page');
      await preferences();
      await page.getByLabel('Theme', { exact: true }).selectOption('dark');
      await done();
      await shot('dark');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await shot('desktop');
      await page.getByRole('button', { name: 'App configuration', exact: true }).click();
      await settings().getByRole('button', { name: 'Save', exact: true }).waitFor();
      assert.equal(
        await page.locator('.phone-surface').evaluate((el) => el.matches(':modal')),
        false,
      );
      await shot('desktop-phone');
      await page.getByRole('button', { name: 'Close app settings', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });

      await setOffline(true);
      await page.reload();
      await ready();
      await page.getByRole('button', { name: 'App configuration', exact: true }).click();
      await settings().getByRole('button', { name: 'Save', exact: true }).waitFor();
      assert.equal(await settings().getByLabel('Dark background').isChecked(), true);
      await shot('offline-phone');
      await page.getByRole('button', { name: 'Close app settings', exact: true }).click();
      await page.goto(base);
      // The landing page restores the last session once the firmware and the
      // package are both already stored, so offline it comes back on its own
      // and the saved-watchface button is not needed to reach the watch.
      await ready();
      assert.equal(await page.locator('.watch-session h1').innerText(), 'Clock');
      await shot('offline-saved-watchface');
      await setOffline(false);

      const other = await context.newPage();
      await other.goto(base);
      await other.waitForFunction(() => !!navigator.serviceWorker.controller);
      const initialController = await page.evaluate(
        () => navigator.serviceWorker.controller.scriptURL,
      );
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });
      revision = 2;
      await page.evaluate(async () => {
        await (await navigator.serviceWorker.getRegistration()).update();
      });
      await page.getByRole('button', { name: 'Review update', exact: true }).waitFor();
      assert.equal(navigations, 0, 'Update availability cannot restart a running watch');
      assert.equal(
        await page.getByRole('button', { name: 'Pause', exact: true }).isVisible(),
        true,
      );
      assert.equal(
        await page.evaluate(() => navigator.serviceWorker.controller.scriptURL),
        initialController,
      );
      await page.getByRole('button', { name: 'Review update', exact: true }).click();
      await page.getByRole('button', { name: 'Restart & update', exact: true }).click();
      await page
        .getByText('Close the other emulator tabs before updating.', { exact: true })
        .waitFor();
      assert.equal(navigations, 0);
      await other.close();
      await page.getByRole('button', { name: 'Restart & update', exact: true }).click();
      await page.waitForFunction(async () => {
        const keys = await caches.keys();
        return (
          keys.some((key) => key.endsWith('-qa-2')) && !keys.some((key) => key.endsWith('-qa-1'))
        );
      });
      await page.getByRole('button', { name: 'Preferences', exact: true }).waitFor();
      await preferences();
      await page.getByText(/Ready offline ·/).waitFor();
      await shot('updated');
      await done();
      await setOffline(true);
      await page.reload();
      // Same restore after the worker update: the stored session comes back
      // without a request, which is what makes the update safe offline.
      await ready();
      assert.deepEqual(errors, []);
      results.push({
        engine,
        browser: browser.version(),
        passed: true,
        downloadSize,
        offlineMode,
        installability,
        errors,
        assertions: [
          'subdirectory scope',
          'mobile controls in viewport',
          '44px watch buttons',
          'native mobile configuration dialog',
          'desktop side panel',
          'offline firmware boot',
          'offline companion settings',
          'saved PBW reopen',
          'explicit update',
          'other tab guard',
          'offline choice survives update',
        ],
      });
      console.log(engine, 'PWA acceptance passed', downloadSize);
    } catch (error) {
      await shot('failure').catch(() => {});
      await writeFile(
        resolve(out, engine + '-frames.json'),
        JSON.stringify(
          await Promise.all(
            page.frames().map(async (frame) => ({
              url: frame.url(),
              body: await frame
                .locator('body')
                .innerText()
                .catch(() => ''),
            })),
          ),
          null,
          2,
        ),
      );
      await writeFile(
        resolve(out, engine + '-failure.txt'),
        await page.locator('body').innerText(),
      );
      results.push({ engine, passed: false, error: String(error), errors });
      console.error(engine, error);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(
  resolve(out, 'pwa-browser.json'),
  JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2) + '\n',
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
