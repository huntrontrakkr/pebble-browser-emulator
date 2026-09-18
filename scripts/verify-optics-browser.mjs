// Renderer-only optical behavior checks. White pixels are explicit test input;
// this is not a physical-display calibration or a fabricated firmware image.
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { WATCH_MODELS, modelDisplay } from '../src/app/watch-model-specs.ts';
import { renderPixels } from '../src/app/display.ts';
import { cadFixtures, modelServer } from './model-browser-fixtures.mjs';
const files = await cadFixtures(),
  server = await modelServer();
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/optics-browser');
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
      viewport: { width: 390, height: 460 },
      deviceScaleFactor: 1.5,
    });
    await context.route('https://raw.githubusercontent.com/coredevices/hardware/**', (route) =>
      route.fulfill({
        body: files.get(route.request().url()),
        contentType: 'application/octet-stream',
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.goto(server.base + '__model.html');
      await page.waitForFunction(() => window.WatchModel);
      for (const spec of Object.values(WATCH_MODELS)) {
        const dimensions = modelDisplay(spec);
        const pigment = renderPixels(
          new Uint8Array(dimensions.width * dimensions.height).fill(0xff),
          { mode: 'model', ambient: 1, backlight: 0 },
        );
        const result = await page.evaluate(
          async ({ spec, pigment }) => {
            const model = new window.WatchModel(document.querySelector('#host'), spec, () => {});
            model.setActive(false);
            await model.load(new AbortController().signal);
            const pixels = Uint8ClampedArray.from(pigment);
            model.pixels(pixels);
            model.renderer.setSize(390, 460);
            model.camera.aspect = 390 / 460;
            model.camera.updateProjectionMatrix();
            const gl = model.renderer.getContext();
            const width = gl.drawingBufferWidth,
              height = gl.drawingBufferHeight;
            const captures = [];
            const capture = (name, environment, ambient, backlight, azimuth = -35) => {
              model.setLighting({ environment, ambient, backlight, azimuth });
              model.renderer.render(model.scene, model.camera);
              const data = new Uint8Array(width * height * 4);
              gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
              let total = 0,
                count = 0,
                hash = 2166136261;
              for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
              for (let i = 0; i < data.length; i += 4)
                if (data[i + 3] > 127) {
                  total += (data[i] + data[i + 1] + data[i + 2]) / 3;
                  count++;
                }
              const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
              captures.push({
                name,
                mean: total / count,
                center: Array.from(data.subarray(center, center + 3)),
                hash: hash >>> 0,
                png: model.renderer.domElement.toDataURL('image/png').split(',')[1],
              });
            };
            capture('studio', 'studio', 0.8, 0);
            capture('daylight', 'daylight', 1, 0);
            capture('warm-room', 'warm-room', 0.8, 0);
            capture('side-light', 'studio', 0.8, 0, 85);
            capture('dark', 'studio', 0, 0);
            capture('backlight', 'studio', 0, 1);
            model.camera.position.set(65, -35, 85);
            model.camera.lookAt(0, 0, 0);
            capture('glancing', 'studio', 0.8, 0);
            const unchangedPixels = pixels.every((v, i) => model.texture.image.data[i] === v);
            const environments = model.environments.size;
            const triangles = model.geometry.index.count / 3;
            const textures = model.renderer.info.memory.textures;
            model.dispose();
            return { captures, unchangedPixels, environments, triangles, textures };
          },
          { spec, pigment: Array.from(pigment) },
        );
        for (const capture of result.captures) {
          await writeFile(
            resolve(out, `${engine}-${spec.profile}-${capture.name}.png`),
            Buffer.from(capture.png, 'base64'),
          );
          delete capture.png;
        }
        const byName = Object.fromEntries(result.captures.map((c) => [c.name, c]));
        assert.ok(
          byName.dark.mean < 1,
          'No display or case emission with ambient and backlight off',
        );
        assert.ok(
          byName.backlight.center.every((v) => v > 100),
          'Backlight illuminates the LCD in darkness',
        );
        assert.equal(
          new Set(result.captures.map((c) => c.hash)).size,
          7,
          'Lighting presets, direction and backlight change the rendered result',
        );
        assert.equal(result.unchangedPixels, true);
        assert.equal(result.environments, 3);
        assert.ok(
          result.textures <= 5,
          'Three reflection maps, native-resolution display and Three.js BRDF lookup',
        );
        results.push({ engine, browser: browser.version(), profile: spec.profile, ...result });
        console.log(engine, spec.profile, 'lighting passed');
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
} finally {
  await server.close();
}
