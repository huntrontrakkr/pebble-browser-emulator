// Run against the built static site. Uses actual firmware, Workers, and PBW installation.
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const firmware = process.env.PEBBLE_FIRMWARE_DIR;
if (!firmware) throw new Error('Set PEBBLE_FIRMWARE_DIR to the unchanged Emery 4.37.0 image pair.');
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/preview-browser');
await mkdir(out, { recursive: true });
const results = [];
for (const name of (process.env.PEBBLE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await { chromium, firefox, webkit }[name].launch({
    ...(name === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
      ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    ...(name !== 'firefox' ? { isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  const errors = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    window.previewMeasure = {
      workers: [],
      installed: [],
      clockMessages: 0,
      states: 0,
      firstTime: null,
      lastTime: null,
      longTasks: [],
    };
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        window.previewMeasure.workers.push(String(args[0]));
        this.addEventListener('message', ({ data }) => {
          const m = window.previewMeasure;
          if (data.type === 'installed') m.installed.push(data.uuid);
          if (data.type === 'state') m.states++;
          if (data.type === 'clock') {
            m.clockMessages++;
            m.lastTime = data.virtualUs / 1e6;
            m.firstTime ??= m.lastTime;
          }
        });
      }
    };
    if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
      new PerformanceObserver((list) =>
        window.previewMeasure.longTasks.push(...list.getEntries().map((e) => e.duration)),
      ).observe({ type: 'longtask', buffered: true });
  });
  page.setDefaultTimeout(120000);
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Try example', exact: true }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => window.previewMeasure.workers),
      [],
      'Idle preview should start no emulation/build Workers',
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: resolve(out, name + '-first.png'), fullPage: true });
    await page.getByRole('button', { name: 'Try example', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await page.getByLabel('Preview watch setup').waitFor({ state: 'detached' });
    assert.equal(await page.getByLabel('Preview watch setup').count(), 0);
    await page.getByRole('button', { name: 'Try example', exact: true }).click();
    await page
      .getByLabel('Choose both firmware files')
      .setInputFiles([
        resolve(firmware, 'qemu_emery_v4.37.0_micro_flash.bin'),
        resolve(firmware, 'qemu_emery_v4.37.0_spi_flash.bin'),
      ]);
    const began = Date.now();
    await page
      .getByText('Ready. Use the buttons below the watch to interact.', { exact: true })
      .waitFor();
    await page.waitForFunction(() =>
      window.previewMeasure.installed.includes('c61ace0a-d61a-47ce-9d04-f46a78849ec6'),
    );
    const firstBootAndInstallMs = Date.now() - began;
    console.log(name, 'first launch', firstBootAndInstallMs + ' ms');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas[aria-label="Live watch framebuffer"]');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let black = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 0 && pixels[i + 3] === 255) black++;
      return black > 1000 && black < pixels.length / 8;
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: resolve(out, name + '-clock.png'), fullPage: true });
    await page.getByRole('button', { name: 'Copy preview link', exact: true }).click();
    const link = await page.getByLabel('Preview link', { exact: true }).inputValue();
    assert.equal(new URL(link).hash, '#/example/clock');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PBW', exact: true }).click();
    const file = await download;
    await file.saveAs(resolve(out, name + '.pbw'));
    assert.deepEqual(
      await readFile(resolve(out, name + '.pbw')),
      await readFile('public/examples/clock-emery.pbw'),
    );
    const reload = Date.now();
    await page.reload();
    await page
      .getByText('Ready. Use the buttons below the watch to interact.', { exact: true })
      .waitFor();
    const cachedBootAndInstallMs = Date.now() - reload;
    assert.equal(
      await page.getByLabel('Preview watch setup').count(),
      0,
      'Shared link should use the cached firmware',
    );
    await page.evaluate(() => {
      const m = window.previewMeasure;
      m.clockMessages = 0;
      m.states = 0;
      m.firstTime = null;
      m.lastTime = null;
      m.longTasks = [];
    });
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const measurement = await page.evaluate(() => window.previewMeasure);
    const virtualSeconds = measurement.lastTime - measurement.firstTime;
    assert.ok(
      virtualSeconds > 5 && virtualSeconds < 12,
      'Preview should approximately track elapsed time on this host',
    );
    assert.ok(measurement.states < 320, 'Screen snapshots must be rate limited');
    assert.ok(
      !measurement.workers.some((url) => /compiler|archive|linux/.test(url)),
      'Example must not load a compiler',
    );
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    await pause.click();
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
    const paused = await page.evaluate(() => window.previewMeasure.lastTime);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await page.evaluate(() => window.previewMeasure.lastTime), paused);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      requests.filter((url) => new URL(url).origin !== new URL(base).origin),
      [],
      'Local example must make no external requests',
    );
    results.push({
      browser: name,
      version: browser.version(),
      viewport: '390x844',
      firstBootAndInstallMs,
      cachedBootAndInstallMs,
      measurementSeconds: 10,
      virtualSeconds,
      stateMessages: measurement.states,
      clockMessages: measurement.clockMessages,
      mainThreadLongTasks: measurement.longTasks,
      passed: true,
    });
  } catch (error) {
    await writeFile(resolve(out, name + '-failure.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: resolve(out, name + '-failure.png'), fullPage: true });
    results.push({ browser: name, passed: false, error: String(error), errors });
    console.error(name, String(error));
  } finally {
    await browser.close();
  }
  await writeFile(
    resolve(out, 'preview-browser.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        scope:
          'Linux browser engines with a mobile viewport, not measurements on a physical phone. Local firmware import, example install, cancellation, hash link, PBW download, cached reload, screen pacing and pause.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
