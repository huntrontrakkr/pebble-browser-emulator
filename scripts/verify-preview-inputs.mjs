// Production UI + real firmware. Only failure cases below inject host Worker faults;
// signal delivery is observed at the actual board/UART, not treated as app consumption.
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { modelServer } from './model-browser-fixtures.mjs';
const server = await modelServer();
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/preview-inputs');
await mkdir(out, { recursive: true });
const results = [];
try {
  for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium').split(',')) {
    const browser = await { chromium, firefox, webkit }[engine].launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
      });
      page.setDefaultTimeout(60000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.addInitScript(() => {
        window.qa = { signals: [], installed: 0, workers: [], blockInstall: false, blocked: false };
        const Original = Worker;
        window.Worker = class extends Original {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({ data }) => {
              if (data.type === 'firmware-loaded') window.qa.watch = this;
              if (data.type === 'installed') window.qa.installed++;
              if (data.type === 'signal') window.qa.signals.push(data);
              if (data.type === 'state') window.qa.state = data;
            });
          }
          postMessage(data, ...rest) {
            if (data.type === 'install' && window.qa.blockInstall) {
              window.qa.blockInstall = false;
              window.qa.blocked = true;
              return; // Simulate a non-responsive Worker after a real boot and demo setup.
            }
            return super.postMessage(data, ...rest);
          }
        };
      });
      const installed = (count) => page.waitForFunction((n) => window.qa.installed >= n, count);
      await page.goto(server.base + '#/example/clock');
      await installed(1);
      await page.evaluate(() => {
        window.qa.signals = [];
      });
      await page.getByRole('button', { name: 'Shake wrist', exact: true }).click();
      await page.waitForFunction(
        () =>
          window.qa.signals.filter(
            (s) => s.signal.kind === 'acceleration' && s.stage === 'written to UART',
          ).length >= 31,
      );
      const shake = await page.evaluate(() =>
        window.qa.signals.filter((s) => s.stage === 'written to UART'),
      );
      assert.equal(shake.filter((s) => s.signal.kind === 'tap').length, 1);
      const acceleration = shake.filter((s) => s.signal.kind === 'acceleration');
      assert.ok(
        acceleration.some((s) => s.signal.x > 1000) && acceleration.some((s) => s.signal.x < -1000),
      );
      assert.ok(
        acceleration.every((s) => s.actualUs >= s.scheduledUs && s.actualUs - s.scheduledUs < 1000),
      );
      await page.getByRole('button', { name: 'Wrist tap', exact: true }).click();
      await page.waitForFunction(
        () =>
          window.qa.signals.filter((s) => s.signal.kind === 'tap' && s.stage === 'written to UART')
            .length === 2,
      );
      const screen = page.locator('canvas[aria-label="Live watch framebuffer"]');
      const box = await screen.boundingBox();
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.75, { steps: 4 });
      await page.mouse.up();
      await page.waitForFunction(() =>
        window.qa.signals.some((s) => s.signal.kind === 'touch' && !s.signal.down),
      );
      const contacts = await page.evaluate(() =>
        window.qa.signals.filter((s) => s.signal.kind === 'touch').map((s) => s.signal),
      );
      assert.deepEqual(contacts[0], { kind: 'touch', down: true, x: 50, y: 171 });
      assert.equal(contacts.at(-1).down, false);
      assert.ok(contacts.some((s) => s.down && s.x >= 139));
      await page.mouse.down();
      await page.evaluate(() => dispatchEvent(new Event('blur')));
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          window.qa.signals.filter((s) => s.signal.kind === 'touch').at(-1)?.signal.down === false,
      );
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.waitForFunction(() => !window.qa.state.state.running);
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('button')].find(
            (b) => b.textContent.trim() === 'Shake wrist',
          )?.disabled,
      );
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      // A crashed worker must release Loading/Run controls and allow a fresh restart.
      await page.evaluate(() =>
        window.qa.watch.dispatchEvent(
          new ErrorEvent('error', { message: 'Injected worker crash' }),
        ),
      );
      await page.getByText('Injected worker crash', { exact: true }).waitFor();
      await page.screenshot({ path: resolve(out, engine + '-crash.png'), fullPage: true });

      assert.ok(await page.getByRole('button', { name: 'Run', exact: true }).isDisabled());
      await page.getByRole('button', { name: 'Restart preview', exact: true }).click();
      await installed(2);
      // Progress timeout uses wall time even if the firmware clock cannot advance.
      await page.clock.install();
      await page.evaluate(() => {
        window.qa.blockInstall = true;
      });
      await page.getByRole('button', { name: 'Restart preview', exact: true }).click();
      await page.waitForFunction(() => window.qa.blocked);
      await page.clock.fastForward(45001);
      await page
        .getByText(
          'The app made no installation progress for 45 seconds. Restart the preview or choose another app.',
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Cancel preview', exact: true }).count(),
        0,
      );
      await page.getByRole('button', { name: 'Restart preview', exact: true }).click();
      await installed(3);
      assert.equal(await page.locator('.error').filter({ hasText: '45 seconds' }).count(), 0);
      // Existing board abstractions decide whether direct contact is available.
      for (const [profile, touch] of [
        ['qemu_gabbro', true],
        ['qemu_flint', false],
      ]) {
        await page.goto(server.base + '#/example/clock?watch=' + profile);
        await installed(profile === 'qemu_gabbro' ? 4 : 5);
        assert.equal(await screen.evaluate((e) => e.classList.contains('touch-enabled')), touch);
        if (touch) {
          const round = await screen.boundingBox();
          const count = await page.evaluate(
            () => window.qa.signals.filter((s) => s.signal.kind === 'touch').length,
          );
          await page.mouse.click(round.x + 2, round.y + 2);
          await page.waitForTimeout(100);
          assert.equal(
            await page.evaluate(
              () => window.qa.signals.filter((s) => s.signal.kind === 'touch').length,
            ),
            count,
          );
        }
      }
      assert.deepEqual(errors, []);
      results.push({
        engine,
        browser: browser.version(),
        shakeSamples: acceleration.length,
        contacts,
        crashRecovery: true,
        progressTimeoutRecovery: true,
        roundCornersRejected: true,
        duoTouchDisabled: true,
        errors,
      });
    } finally {
      await browser.close();
    }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await server.close();
}
