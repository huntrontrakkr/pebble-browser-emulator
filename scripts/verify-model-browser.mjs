// Actual firmware switching plus isolated renderer lifetime/cancellation checks.
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { WATCH_MODELS, modelUrl } from '../src/app/watch-model-specs.ts';
import { cadFixtures, modelServer } from './model-browser-fixtures.mjs';

const files = await cadFixtures();
const server = await modelServer();
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/model-browser');
await mkdir(out, { recursive: true });
const results = [];
try {
  for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium').split(',')) {
    const browser = await { chromium, firefox, webkit }[engine].launch({
      ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      serviceWorkers: 'block',
    });
    const requests = [],
      errors = [];
    await context.route(
      'https://raw.githubusercontent.com/coredevices/hardware/**',
      async (route) => {
        requests.push(route.request().url());
        const bytes = files.get(route.request().url());
        assert.ok(bytes, 'Only pinned CAD requested');
        await route.fulfill({
          body: bytes,
          contentType: 'application/octet-stream',
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      window.modelQa = { profiles: [], geometries: [], touches: [] };
      const Original = Worker;
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'firmware-loaded') window.modelQa.profiles.push(data.profile);
            if (data.type === 'signal' && data.signal.kind === 'touch')
              window.modelQa.touches.push(data.signal);
            if (data.geometry) {
              const g = data.geometry;
              window.modelQa.geometries.push({
                sourceTriangles: g.sourceTriangles,
                triangles: g.indices.length / 3,
                bytes: g.positions.byteLength + g.normals.byteLength + g.indices.byteLength,
                estimatedError: g.estimatedError,
              });
            }
          });
        }
      };
    });
    const ready = () =>
      page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
    const modelReady = () =>
      page.waitForFunction(
        () =>
          document.querySelector('.model-host canvas') && !document.querySelector('.model-status'),
      );
    try {
      await page.goto(server.base + '#/example/clock?watch=qemu_flint');
      await ready();
      await page.getByRole('button', { name: '3D watch', exact: true }).click();
      await modelReady();
      // The canvas can hold a correct render and still show nothing, because the
      // control overlay is a sibling drawn on top of it. Assert that no element
      // or pseudo-element in the stage paints over the middle of the model.
      assert.deepEqual(
        await page.evaluate(() => {
          const canvas = document.querySelector('.model-host canvas');
          const box = canvas.getBoundingClientRect();
          const midX = box.left + box.width / 2;
          const midY = box.top + box.height / 2;
          const opaque = (style) => {
            const parts = /^rgba?\(([^)]+)\)$/.exec(style.backgroundColor);
            if (!parts) return false;
            // rgb() carries no alpha and is opaque; rgba() with alpha 0 is not,
            // and 0 must not be read as "missing".
            const alpha = Number.parseFloat(parts[1].split(',')[3]);
            return Number.isNaN(alpha) ? true : alpha > 0.05;
          };
          const over = [];
          for (const element of document.querySelector('.display-stage').querySelectorAll('*')) {
            if (element === canvas || element.contains(canvas)) continue;
            const rect = element.getBoundingClientRect();
            if (rect.left > midX || rect.right < midX) continue;
            if (rect.top > midY || rect.bottom < midY) continue;
            for (const pseudo of [null, '::before', '::after']) {
              const style = getComputedStyle(element, pseudo);
              if (pseudo && style.content === 'none') continue;
              if (opaque(style)) over.push((element.className || element.tagName) + (pseudo ?? ''));
            }
          }
          return over;
        }),
        [],
        'Nothing may paint over the middle of the rendered watch model',
      );
      const canvas = await page.locator('.model-host canvas').elementHandle();
      for (const profile of ['qemu_gabbro', 'qemu_emery', 'qemu_flint']) {
        const select = page.getByRole('combobox', { name: 'Watch', exact: true });
        if (!(await select.isVisible()))
          await page.getByText('Choose something else', { exact: true }).click();
        await select.selectOption(profile);
        await page.waitForFunction((p) => window.modelQa.profiles.at(-1) === p, profile);
        await ready();
        await modelReady();
        assert.equal(
          await canvas.evaluate((node) => node === document.querySelector('.model-host canvas')),
          true,
          'WebGL canvas survives model switching',
        );
        assert.ok((await canvas.getAttribute('aria-label')).includes(WATCH_MODELS[profile].name));
        await page.waitForFunction(
          () => document.querySelectorAll('.watch-control:not(.control-hidden)').length === 4,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (profile === 'qemu_emery') {
          const optics = page.getByRole('combobox', { name: 'Display optics', exact: true });
          assert.equal(await optics.inputValue(), 'layered');
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
          const settled = () =>
            page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
          await settled();
          const framebuffer = () =>
            page
              .locator('canvas[aria-label="Live watch framebuffer"]')
              .evaluate((canvas) => canvas.toDataURL());
          const native = await framebuffer();
          await page
            .locator('.model-host')
            .screenshot({ path: resolve(out, `${engine}-clock-layered.png`) });
          await optics.selectOption('standard');
          await settled();
          assert.equal(
            await framebuffer(),
            native,
            'Changing the optical model preserves every framebuffer pixel',
          );
          await page
            .locator('.model-host')
            .screenshot({ path: resolve(out, `${engine}-clock-standard.png`) });
          await optics.selectOption('layered');
          await settled();
          assert.equal(await framebuffer(), native);
          await page.getByRole('button', { name: 'Run', exact: true }).click();
        } else {
          assert.equal(
            await page.getByRole('combobox', { name: 'Display optics', exact: true }).count(),
            0,
          );
        }
        if (profile !== 'qemu_flint') {
          const start = await page.evaluate(() => window.modelQa.touches.length);
          await page.getByRole('button', { name: 'Touch screen', exact: true }).click();
          await page.locator('.model-host canvas').scrollIntoViewIfNeeded();
          const box = await page.locator('.model-host canvas').boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForFunction((n) => window.modelQa.touches.length >= n + 2, start);
          const contact = await page.evaluate((n) => window.modelQa.touches.slice(n), start);
          assert.equal(contact[0].down, true);
          assert.equal(contact.at(-1).down, false);
          assert.ok(contact[0].x > 0 && contact[0].y > 0);
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          await page.getByRole('button', { name: 'Rotate watch', exact: true }).click();
          await page.getByRole('button', { name: 'Run', exact: true }).click();
        } else {
          assert.equal(
            await page.getByRole('button', { name: 'Touch screen', exact: true }).count(),
            0,
          );
        }
        await page.screenshot({ path: resolve(out, `${engine}-${profile}.png`), fullPage: true });
        console.log(engine, profile, 'automatic switch ready');
      }
      assert.equal(requests.length, 3, 'Switching back reuses geometry');
      const geometries = await page.evaluate(() => window.modelQa.geometries);
      assert.equal(geometries.length, 3);
      await page.reload();
      await ready();
      await page.getByRole('button', { name: '3D watch', exact: true }).click();
      await modelReady();
      assert.equal(requests.length, 3, 'Reload uses the persisted simplified mesh');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      const settled = () =>
        page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      await settled();
      const nativePixels = () =>
        page
          .locator('canvas[aria-label="Live watch framebuffer"]')
          .evaluate((canvas) => canvas.toDataURL());
      const beforeLighting = await nativePixels();
      await page.getByRole('combobox', { name: 'Lighting environment' }).selectOption('warm-room');
      await page.getByRole('slider', { name: 'Light direction', exact: true }).fill('45');
      await settled();
      assert.equal(
        await nativePixels(),
        beforeLighting,
        'Lighting controls do not rewrite framebuffer/pigment pixels',
      );
      await page.screenshot({
        path: resolve(out, `${engine}-lighting-controls.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );

      // Exercise races, duplicate pixels and hidden rendering without firmware timing noise.
      await page.goto(server.base + '__model.html');
      await page.waitForFunction(() => window.WatchModel);
      const renderer = await page.evaluate(async (specs) => {
        const frames = () =>
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const model = new window.WatchModel(
          document.querySelector('#host'),
          specs.qemu_flint,
          () => {},
        );
        await model.load(new AbortController().signal);
        const original = model.renderer.domElement;
        let renders = 0;
        const render = model.renderer.render.bind(model.renderer);
        model.renderer.render = (...args) => {
          renders++;
          return render(...args);
        };
        const pixels = new Uint8ClampedArray(144 * 168 * 4).fill(255);
        model.pixels(pixels);
        await frames();
        renders = 0;
        const version = model.texture.version;
        for (let i = 0; i < 20; i++) model.pixels(pixels);
        await frames();
        const duplicateRenders = renders,
          duplicateUploads = model.texture.version - version;
        model.setSpec(specs.qemu_emery);
        const old = new AbortController();
        const obsolete = model.load(old.signal).then(
          () => 'resolved',
          (e) => e.name,
        );
        old.abort();
        model.setSpec(specs.qemu_gabbro);
        await model.load(new AbortController().signal);
        const obsoleteResult = await obsolete;
        const sameCanvas = original === model.renderer.domElement;
        const roundVertices = model.geometry.index.count;
        const touchRays = [];
        for (const [profile, width, height] of [
          ['qemu_emery', 200, 228],
          ['qemu_gabbro', 260, 260],
        ]) {
          model.setSpec(specs[profile]);
          for (const angle of [0, 0.45]) {
            model.camera.position.set(110 * Math.sin(angle), 14, 110 * Math.cos(angle));
            model.controls.update();
            model.camera.updateMatrixWorld(true);
            model.display.updateMatrixWorld(true);
            for (const [u, v] of [
              [0.25, 0.7],
              [0.65, 0.3],
            ]) {
              const screen = specs[profile].screen;
              const p = model.camera.position
                .clone()
                .set((u - 0.5) * screen.width, (0.5 - v) * screen.height, 0);
              model.display.localToWorld(p);
              p.project(model.camera);
              const rect = original.getBoundingClientRect();
              const hit = model.touchPoint(
                rect.left + ((p.x + 1) * rect.width) / 2,
                rect.top + ((1 - p.y) * rect.height) / 2,
              );
              touchRays.push({ profile, angle, hit, expected: { x: u * width, y: v * height } });
            }
          }
        }
        model.setTouchMode(true);
        const touchDisablesOrbit = !model.controls.enabled;
        model.setTouchMode(false);
        const rotationRestored = model.controls.enabled;
        model.pixels(new Uint8ClampedArray(260 * 260 * 4).fill(192));
        await frames();
        model.controls.dispatchEvent({ type: 'start' });
        const movingPixelRatio = model.renderer.getPixelRatio();
        await new Promise((resolve) => setTimeout(resolve, 220));
        const settledPixelRatio = model.renderer.getPixelRatio();
        model.setActive(false);
        renders = 0;
        model.pixels(new Uint8ClampedArray(260 * 260 * 4).fill(64));
        await frames();
        const hiddenRenders = renders;
        model.setActive(true);
        await frames();
        const resumed = renders > 0;
        model.dispose();
        return {
          duplicateRenders,
          duplicateUploads,
          obsoleteResult,
          sameCanvas,
          roundVertices,
          hiddenRenders,
          resumed,
          canvasesAfterDispose: document.querySelectorAll('#host canvas').length,
          movingPixelRatio,
          settledPixelRatio,
          touchRays,
          touchDisablesOrbit,
          rotationRestored,
        };
      }, WATCH_MODELS);
      assert.equal(renderer.duplicateRenders, 0);
      assert.equal(renderer.duplicateUploads, 0);
      assert.equal(renderer.obsoleteResult, 'AbortError');
      assert.equal(renderer.sameCanvas, true);
      assert.equal(renderer.roundVertices / 3, geometries[1].triangles);
      assert.equal(renderer.hiddenRenders, 0);
      assert.equal(renderer.resumed, true);
      assert.equal(renderer.movingPixelRatio, 1);
      assert.equal(renderer.settledPixelRatio, 1.5);
      assert.equal(renderer.canvasesAfterDispose, 0);
      for (const ray of renderer.touchRays) {
        assert.ok(ray.hit, 'Ray hits the actual display at both view angles');
        assert.ok(Math.abs(ray.hit.x - ray.expected.x) <= 1);
        assert.ok(Math.abs(ray.hit.y - ray.expected.y) <= 1);
      }
      assert.ok(renderer.touchDisablesOrbit && renderer.rotationRestored);
      assert.deepEqual(errors, []);
      results.push({
        engine,
        browser: browser.version(),
        profiles: Object.keys(WATCH_MODELS),
        geometries,
        cadRequests: requests.length,
        renderer,
        errors,
      });
    } finally {
      await browser.close();
    }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await server.close();
}
