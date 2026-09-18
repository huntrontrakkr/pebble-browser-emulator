// Paired, isolated 3D renderer benchmark. Pattern pixels are test input, not firmware output.
// PEBBLE_MODEL_BASELINE must be an earlier production dist/client directory.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { WATCH_MODELS, modelDisplay } from '../src/app/watch-model-specs.ts';
import { cadFixtures, modelServer } from './model-browser-fixtures.mjs';

assert.ok(
  process.env.PEBBLE_MODEL_BASELINE,
  'Set PEBBLE_MODEL_BASELINE to an earlier production build',
);
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/model-benchmark');
await mkdir(out, { recursive: true });
const cad = await cadFixtures();
const servers = {
  before: await modelServer(process.env.PEBBLE_MODEL_BASELINE),
  after: await modelServer(process.env.PEBBLE_MODEL_CANDIDATE ?? 'dist/client'),
};
const browser = await chromium.launch();
const samples = [],
  images = new Map();
try {
  // Alternating order reduces systematic first-run bias. Fresh context = cold CAD cache.
  for (const trial of Array.from(
    { length: Number(process.env.PEBBLE_MODEL_TRIALS ?? 3) },
    (_, i) => i,
  ))
    for (const variant of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 460 },
        deviceScaleFactor: 1.5,
      });
      await context.route('https://raw.githubusercontent.com/coredevices/hardware/**', (route) => {
        const body = cad.get(route.request().url());
        assert.ok(body);
        return route.fulfill({
          body,
          contentType: 'application/octet-stream',
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(servers[variant].base + '__model.html');
      await page.waitForFunction(() => window.WatchModel);
      for (const spec of Object.values(WATCH_MODELS)) {
        const record = await page.evaluate(
          async ({ spec, dimensions, capture }) => {
            const longTasks = [];
            const observer = new PerformanceObserver((list) =>
              longTasks.push(
                ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
              ),
            );
            observer.observe({ type: 'longtask' });
            const setupStart = performance.now();
            const model = new window.WatchModel(document.querySelector('#host'), spec, () => {});
            const setupMs = performance.now() - setupStart;
            model.setActive(false);
            const loadStart = performance.now();
            await model.load(new AbortController().signal);
            const loadMs = performance.now() - loadStart;
            await new Promise((r) => setTimeout(r, 50));
            observer.disconnect();
            const pixels = new Uint8ClampedArray(dimensions.width * dimensions.height * 4);
            for (let i = 0; i < pixels.length; i += 4) {
              const n = i / 4,
                x = n % dimensions.width,
                y = Math.floor(n / dimensions.width);
              pixels[i] = x % 24 < 12 ? 20 : 220;
              pixels[i + 1] = y % 32 < 16 ? 150 : 50;
              pixels[i + 2] = 128;
              pixels[i + 3] = 255;
            }
            model.pixels(pixels);
            model.renderer.setSize(390, 460);
            model.camera.aspect = 390 / 460;
            model.camera.updateProjectionMatrix();
            const gl = model.renderer.getContext();
            const barrier = new Uint8Array(4);
            const views = [];
            for (const [name, position] of [
              ['front', [24, 14, 110]],
              ['straight', [0, 0, 115]],
              ['side', [95, 10, 45]],
              ['back', [0, 5, -115]],
            ]) {
              model.camera.position.set(...position);
              model.camera.lookAt(0, 0, 0);
              const durations = [];
              for (let i = 0; i < 25; i++) {
                const start = performance.now();
                model.renderer.render(model.scene, model.camera);
                // WebGL finish() need not wait for Chromium's GPU-process command
                // queue. A readback makes this completed rendering, not submission.
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, barrier);
                if (i >= 5) durations.push(performance.now() - start);
              }
              durations.sort((a, b) => a - b);
              const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
              if (capture)
                gl.readPixels(
                  0,
                  0,
                  gl.drawingBufferWidth,
                  gl.drawingBufferHeight,
                  gl.RGBA,
                  gl.UNSIGNED_BYTE,
                  data,
                );
              let raw = '';
              if (capture)
                for (let i = 0; i < data.length; i += 16384)
                  raw += String.fromCharCode(...data.subarray(i, i + 16384));
              views.push({
                name,
                renderMedianMs: durations[Math.floor(durations.length / 2)],
                rgba: capture ? btoa(raw) : undefined,
                png: capture
                  ? model.renderer.domElement.toDataURL('image/png').split(',')[1]
                  : undefined,
              });
            }
            const memoryBytes =
              model.geometry.attributes.position.array.byteLength +
              model.geometry.attributes.normal.array.byteLength +
              (model.geometry.index?.array.byteLength ?? 0);
            model.camera.position.set(24, 14, 110);
            model.camera.lookAt(0, 0, 0);
            model.setActive(true);
            model.controls.dispatchEvent({ type: 'start' });
            const interactionPixelRatio = model.renderer.getPixelRatio();
            const interactionSamples = [];
            for (let i = 0; i < 25; i++) {
              const start = performance.now();
              model.renderer.render(model.scene, model.camera);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, barrier);
              if (i >= 5) interactionSamples.push(performance.now() - start);
            }
            interactionSamples.sort((a, b) => a - b);
            const interactionRenderMedianMs =
              interactionSamples[Math.floor(interactionSamples.length / 2)];
            const debug = gl.getExtension('WEBGL_debug_renderer_info');
            const gpu = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
            const triangles =
              (model.geometry.index?.count ?? model.geometry.attributes.position.count) / 3;
            const screenUnchanged = pixels.every(
              (value, index) => value === model.texture.image.data[index],
            );
            const mainThreadLongTasks = longTasks.filter(
              (task) => task.start + task.duration > loadStart && task.start < loadStart + loadMs,
            );
            model.dispose();
            return {
              interactionPixelRatio,
              interactionRenderMedianMs,
              gpu,
              setupMs,
              loadMs,
              triangles,
              memoryBytes,
              mainThreadLongTasks,
              views,
              screenUnchanged,
            };
          },
          { spec, dimensions: modelDisplay(spec), capture: trial === 0 },
        );
        assert.equal(record.screenUnchanged, true);
        for (const view of record.views) {
          if (view.rgba)
            images.set(`${variant}:${spec.profile}:${view.name}`, Buffer.from(view.rgba, 'base64'));
          if (view.png)
            await writeFile(
              resolve(out, `${variant}-${spec.profile}-${view.name}.png`),
              Buffer.from(view.png, 'base64'),
            );
          delete view.rgba;
          delete view.png;
        }
        samples.push({ variant, trial, profile: spec.profile, ...record });
        console.log(variant, trial, spec.profile, record.triangles, 'triangles');
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  const comparisons = [];
  for (const spec of Object.values(WATCH_MODELS))
    for (const view of ['front', 'straight', 'side', 'back']) {
      const before = images.get(`before:${spec.profile}:${view}`),
        after = images.get(`after:${spec.profile}:${view}`);
      assert.equal(before.length, after.length);
      let intersection = 0,
        union = 0,
        difference = 0;
      for (let i = 0; i < before.length; i += 4) {
        const a = before[i + 3] > 127,
          b = after[i + 3] > 127;
        if (a || b) union++;
        if (a && b) {
          intersection++;
          for (let k = 0; k < 3; k++) difference += Math.abs(before[i + k] - after[i + k]);
        }
      }
      const silhouetteIoU = intersection / union,
        meanAbsoluteRgbDifference = difference / (intersection * 3);
      comparisons.push({ profile: spec.profile, view, silhouetteIoU, meanAbsoluteRgbDifference });
      assert.ok(silhouetteIoU > 0.995, 'Less than 0.5% silhouette disagreement');
      if (process.env.PEBBLE_MODEL_COMPARE_IMAGES !== '0') {
        assert.ok(meanAbsoluteRgbDifference < 3, 'Mean RGB error below 3/255');
      }
    }
  const result = {
    browser: browser.version(),
    viewport: { width: 390, height: 460, deviceScaleFactor: 1.5 },
    note: 'Software/headless desktop renderer timings, not physical phone FPS. Pattern pixels are renderer test input.',
    checks: { silhouette: true, rgb: process.env.PEBBLE_MODEL_COMPARE_IMAGES !== '0' },
    samples,
    comparisons,
  };
  await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(comparisons, null, 2));
} finally {
  await browser.close();
  await servers.before.close();
  await servers.after.close();
}
