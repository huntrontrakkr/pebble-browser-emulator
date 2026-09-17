// Real browser + bundled firmware acceptance; no simulated firmware responses.
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/demo-browser');
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
await mkdir(out, { recursive: true });
const results = [];
for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium').split(',')) {
  const browser = await { chromium, firefox, webkit }[engine].launch({
    ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
      ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
      : {}),
  });
  for (const profile of (process.env.PEBBLE_PROFILES ?? 'qemu_emery,qemu_flint,qemu_gabbro').split(
    ',',
  )) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      window.demoQa = { events: [], commands: [], virtualUs: 0, samples: 0, battery: -1 };
      const Original = Worker;
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            const q = window.demoQa;
            if (['error', 'demo-applied', 'installed', 'session'].includes(data.type))
              q.events.push(data);
            if (data.type === 'clock') q.virtualUs = data.virtualUs;
            if (data.type === 'signal') q.samples++;
            if (data.type === 'state') {
              q.battery = data.state.battery;
              q.frame = data.state.framebuffer;
            }
          });
        }
        postMessage(data, ...args) {
          if (['inputs', 'demo-settings', 'demo-notification'].includes(data.type))
            window.demoQa.commands.push(data);
          super.postMessage(data, ...args);
        }
      };
    });
    const advance = async (seconds = 1) => {
      const now = await page.evaluate(() => window.demoQa.virtualUs);
      await page.waitForFunction(
        (target) => window.demoQa.virtualUs >= target,
        now + seconds * 1e6,
      );
    };
    const snap = (name) =>
      page.screenshot({ path: resolve(out, `${engine}-${profile}-${name}.png`), fullPage: true });
    try {
      const began = Date.now();
      await page.goto(`${base}#/example/clock?watch=${profile}`);
      await page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
      console.log(engine, profile, 'ready');
      const launchMs = Date.now() - began;
      await advance(2);
      assert.equal(await page.evaluate(() => window.demoQa.battery), 69);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const applied = await page.evaluate(() =>
        window.demoQa.events.find((e) => e.type === 'demo-applied'),
      );
      assert.equal(applied.notifications, 2);
      assert.equal(applied.calendar, 2);
      assert.equal(applied.heartRate, profile === 'qemu_emery');
      const bounds = await Promise.all(
        ['Back', 'Up', 'Select', 'Down'].map((name) =>
          page.getByRole('button', { name, exact: true }).boundingBox(),
        ),
      );
      assert.ok(
        bounds[0].x < bounds[2].x && bounds[1].y < bounds[2].y && bounds[2].y < bounds[3].y,
      );
      assert.ok(bounds.every((b) => b.width >= 44 && b.height >= 44));
      await snap('clock');
      await page.getByRole('button', { name: 'Down', exact: true }).click({ delay: 150 });
      await advance(1);
      await snap('calendar');
      await page.getByRole('button', { name: 'Back', exact: true }).click({ delay: 150 });
      await advance(1);
      // Pointer capture must release a held button even outside its hit area.
      const up = await page.getByRole('button', { name: 'Up', exact: true }).boundingBox();
      await page.mouse.move(up.x + up.width / 2, up.y + up.height / 2);
      await page.mouse.down();
      await page.mouse.move(up.x - 100, up.y);
      await page.mouse.up();
      assert.equal(
        await page.evaluate(
          () => window.demoQa.commands.filter((c) => c.type === 'inputs').at(-1).buttons,
        ),
        0,
      );
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      assert.equal(
        await page.getByLabel('Demo battery percent', { exact: true }).inputValue(),
        '69',
      );
      await snap('settings');
      await page.getByLabel('Demo battery percent', { exact: true }).fill('42');
      await page.getByLabel('Motion', { exact: true }).selectOption('walking');
      await page.getByRole('button', { name: 'Save & apply', exact: true }).click();
      await page.waitForFunction(
        () => window.demoQa.events.filter((e) => e.type === 'demo-applied').length === 2,
      );
      console.log(engine, profile, 'settings applied');
      assert.equal(await page.evaluate(() => window.demoQa.battery), 42);
      await page.getByRole('button', { name: 'Send now', exact: true }).first().click();
      await page.waitForFunction(() =>
        window.demoQa.events.some((e) => e.type === 'demo-applied' && e.popup),
      );
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await advance(3);
      await snap('notification');
      if (profile === 'qemu_gabbro') {
        const reference = await readFile('docs/evidence/notification-gabbro-fixed-native.bin');
        const frame = await page.evaluate(() => Array.from(window.demoQa.frame));
        const hash = (bytes) =>
          createHash('sha256')
            .update(
              bytes.filter(
                (_, i) =>
                  i >= 260 * 24 &&
                  ((i % 260) - 129.5) ** 2 + (Math.floor(i / 260) - 129.5) ** 2 < 130 ** 2,
              ),
            )
            .digest('hex');
        // Compare the visible round display below its status clock. Off-display corners can
        // retain pixels from the preceding app; keep every visible icon/title/body/action pixel.
        assert.equal(
          hash(Buffer.from(frame)),
          hash(reference),
          'The actual notification must match native QEMU after the introduction completes',
        );
      }
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      // Explicitly opt in to the lazy renderer and official CAD download.
      if (process.env.PEBBLE_SKIP_3D !== '1') {
        await page.getByRole('button', { name: '3D watch', exact: true }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('.model-host canvas') &&
            !document.querySelector('.model-status'),
        );
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const before = await page.getByRole('button', { name: 'Up', exact: true }).boundingBox();
        const stage = await page.locator('.model-host canvas').boundingBox();
        await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
        await page.mouse.down();
        await page.mouse.move(stage.x + stage.width / 2 + 35, stage.y + stage.height / 2 + 8, {
          steps: 8,
        });
        await page.mouse.up();
        await page.waitForFunction(
          (x) =>
            Math.abs(
              document.querySelector('.watch-control[aria-label="Up"]').getBoundingClientRect().x -
                x,
            ) > 3,
          before.x,
        );
        await page.getByRole('button', { name: 'Reset view', exact: true }).click();
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        await snap('model');
        assert.equal(await page.locator('.watch-control:not(.control-hidden)').count(), 4);
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByLabel('Enable demo data', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save & apply', exact: true }).click();
      await page.waitForFunction(() =>
        window.demoQa.events.some(
          (e) => e.type === 'demo-applied' && e.calendar === 0 && e.notifications === 0,
        ),
      );
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      const samples = await page.evaluate(() => window.demoQa.samples);
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await advance(1);
      assert.equal(
        await page.evaluate(() => window.demoQa.samples),
        samples,
        'Disabling demo must stop synthetic input',
      );
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pebble.demo.v1')));
      assert.equal(stored.battery, 42);
      assert.equal(stored.enabled, false);
      const faults = await page.evaluate(() =>
        window.demoQa.events.filter((e) => e.type === 'error'),
      );
      assert.deepEqual(faults, []);
      assert.deepEqual(errors, []);
      results.push({ engine, profile, launchMs, applied, buttons: bounds, errors });
      console.log(engine, profile, 'passed', launchMs + 'ms');
    } catch (e) {
      await snap('failure');
      await writeFile(
        resolve(out, `${engine}-${profile}-failure.json`),
        JSON.stringify({ errors, data: await page.evaluate(() => window.demoQa) }, null, 2),
      );
      throw e;
    } finally {
      await page.close();
    }
  }
  await browser.close();
}
await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
