// Synthetic material inputs, numerical accuracy, and isolated paired render timings.
// No screenshot in this script is claimed to be firmware output or physical calibration.
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { WATCH_MODELS, modelDisplay } from '../src/app/watch-model-specs.ts';
import { TIME2_OPTICS } from '../src/app/watch-optics-profile.ts';
import { renderPixels } from '../src/app/display.ts';
import { cadFixtures, modelServer } from './model-browser-fixtures.mjs';

const fixture = JSON.parse(await readFile('docs/evidence/time2-optics-reference.json', 'utf8'));
assert.equal(fixture.recipeSha256, TIME2_OPTICS.recipeSha256);
const files = await cadFixtures(),
  server = await modelServer();
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/layered-optics');
await mkdir(out, { recursive: true });
const results = [];
const spec = WATCH_MODELS.qemu_emery,
  dimensions = modelDisplay(spec);
const bytes = new Uint8Array(dimensions.width * dimensions.height).fill(255);
const pigment = renderPixels(bytes, { mode: 'model', ambient: 1, backlight: 0 });
try {
  for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium').split(',')) {
    const browser = await { chromium, firefox, webkit }[engine].launch({
      ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
        : {}),
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 460 },
        deviceScaleFactor: 1.5,
        serviceWorkers: 'block',
      });
      await context.route('https://raw.githubusercontent.com/coredevices/hardware/**', (route) =>
        route.fulfill({
          body: files.get(route.request().url()),
          contentType: 'application/octet-stream',
          headers: { 'Access-Control-Allow-Origin': '*' },
        }),
      );
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(server.base + '__model.html');
      await page.waitForFunction(() => window.WatchModel);
      const result = await page.evaluate(
        async ({ spec, dimensions, pigment, samples, benchmark }) => {
          const model = new window.WatchModel(document.querySelector('#host'), spec, () => {});
          model.setActive(false);
          await model.load(new AbortController().signal);
          if (!model.optics) throw new Error(model.opticalNotice() || 'Missing optical material');
          model.setOpticalStyle('layered');
          const raw = new Uint8Array(dimensions.width * dimensions.height).fill(255);
          const rgba = Uint8ClampedArray.from(pigment);
          model.pixels(rgba, raw);
          const shader = model.optics.material;
          if (model.display.material !== shader)
            throw new Error('Layered display was not selected');
          const gl = model.renderer.getContext();
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const gpu = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
          const barrier = new Uint8Array(4);
          const draw = () => {
            model.renderer.render(model.scene, model.camera);
            gl.readPixels(
              Math.floor(gl.drawingBufferWidth / 2),
              Math.floor(gl.drawingBufferHeight / 2),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              barrier,
            );
            return Array.from(barrier);
          };
          const captures = [];
          for (const [name, environment, ambient, backlight, angle] of [
            ['studio', 'studio', 0.8, 0, -35],
            ['daylight', 'daylight', 1, 0, -35],
            ['warm-room', 'warm-room', 0.8, 0, -35],
            ['dark', 'studio', 0, 0, -35],
            ['backlight', 'studio', 0, 1, -35],
            ['side-light', 'studio', 0.8, 0, 85],
          ]) {
            model.setLighting({ environment, ambient, backlight, azimuth: angle });
            const center = draw();
            captures.push({
              name,
              center,
              png: model.renderer.domElement.toDataURL('image/png').split(',')[1],
            });
          }
          const originalPixels = raw.every((v, i) => model.optics.frame.image.data[i] === v);
          const originalPigment = rgba.every((v, i) => model.texture.image.data[i] === v);
          const frameVersion = model.optics.frame.version;
          model.pixels(rgba, raw);
          const noDuplicateUpload = frameVersion === model.optics.frame.version;
          let responseDispose = false;
          model.optics.response.addEventListener('dispose', () => {
            responseDispose = true;
          });

          // Probe the production LUT sampling/index functions against a frozen FP64
          // reference; use a tiny render target area and omit lighting/tone mapping.
          const originalShader = shader.fragmentShader;
          shader.fragmentShader =
            originalShader.slice(0, originalShader.indexOf('void main()')) +
            `
          uniform float uTestView;
          uniform float uTestColumn;
          void main() {
            gl_FragColor = vec4(responseAt(framebufferColor(), uTestView, uTestColumn), 1.0);
            #include <colorspace_fragment>
          }`;
          shader.uniforms.uTestView = { value: 0 };
          shader.uniforms.uTestColumn = { value: 0 };
          shader.needsUpdate = true;
          model.renderer.setPixelRatio(1);
          model.renderer.setSize(32, 32);
          model.camera.aspect = 1;
          model.camera.position.set(0, 0, 110);
          model.camera.lookAt(0, 0, 0);
          model.camera.updateProjectionMatrix();
          const probe = [];
          for (const sample of samples) {
            model.optics.frame.image.data.fill(sample.color | 192);
            model.optics.frame.needsUpdate = true;
            shader.uniforms.uTestView.value = sample.view;
            shader.uniforms.uTestColumn.value =
              sample.kind === 'direct' ? sample.light * 31 : sample.kind === 'diffuse' ? 32 : 33;
            probe.push(draw().slice(0, 3));
          }
          shader.fragmentShader = originalShader;
          delete shader.uniforms.uTestView;
          delete shader.uniforms.uTestColumn;
          shader.needsUpdate = true;
          model.optics.frame.image.data.fill(255);
          model.optics.frame.needsUpdate = true;
          model.renderer.setSize(390, 460);
          model.camera.aspect = 390 / 460;
          model.camera.updateProjectionMatrix();
          model.setLighting({ environment: 'studio', ambient: 0.8, backlight: 0, azimuth: -35 });

          const timings = [];
          if (benchmark) {
            for (let trial = 0; trial < 3; trial++) {
              for (const ratio of [1, 1.5]) {
                model.renderer.setPixelRatio(ratio);
                for (const [view, xyz] of [
                  ['front', [24, 14, 110]],
                  ['straight', [0, 0, 115]],
                  ['side', [95, 10, 45]],
                ]) {
                  model.camera.position.set(...xyz);
                  model.camera.lookAt(0, 0, 0);
                  for (const style of trial % 2
                    ? ['layered', 'standard']
                    : ['standard', 'layered']) {
                    model.setOpticalStyle(style);
                    const elapsed = [];
                    for (let i = 0; i < 25; i++) {
                      const started = performance.now();
                      draw();
                      if (i >= 5) elapsed.push(performance.now() - started);
                    }
                    elapsed.sort((a, b) => a - b);
                    timings.push({
                      trial,
                      ratio,
                      view,
                      style,
                      medianMs: elapsed[Math.floor(elapsed.length / 2)],
                    });
                  }
                }
              }
            }
          }
          model.setSpec({ ...spec, optics: undefined });
          const previousMaterialReleased =
            responseDispose && !model.optics && model.display.material === model.screenMaterial;
          model.dispose();
          return {
            gpu,
            captures,
            originalPixels,
            originalPigment,
            noDuplicateUpload,
            probe,
            timings,
            previousMaterialReleased,
            canvasesAfterDispose: document.querySelectorAll('#host canvas').length,
          };
        },
        {
          spec,
          dimensions,
          pigment: Array.from(pigment),
          samples: fixture.samples,
          benchmark: process.env.PEBBLE_OPTICS_BENCHMARK === '1',
        },
      );
      const srgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
      let maxError = 0,
        sumSquared = 0;
      result.probe.forEach((pixel, i) =>
        pixel.forEach((value, c) => {
          const error = Math.abs(value - srgb(fixture.samples[i].rgb[c]));
          maxError = Math.max(maxError, error);
          sumSquared += error * error;
        }),
      );
      result.shaderError = {
        samples: result.probe.length,
        maxSrgb255: maxError,
        rmsSrgb255: Math.sqrt(sumSquared / (result.probe.length * 3)),
      };
      delete result.probe;
      assert.ok(maxError < 3, `Shader color error ${maxError} exceeds 3/255`);
      const byName = Object.fromEntries(result.captures.map((c) => [c.name, c]));
      assert.ok(byName.dark.center.slice(0, 3).every((v) => v === 0));
      assert.ok(byName.backlight.center.slice(0, 3).every((v) => v > 100));
      assert.notDeepEqual(byName.studio.center, byName['warm-room'].center);
      assert.ok(result.originalPixels && result.originalPigment && result.noDuplicateUpload);
      assert.ok(result.previousMaterialReleased);
      assert.equal(result.canvasesAfterDispose, 0);
      assert.deepEqual(errors, []);
      for (const capture of result.captures) {
        await writeFile(
          resolve(out, `${engine}-${capture.name}.png`),
          Buffer.from(capture.png, 'base64'),
        );
        delete capture.png;
      }

      // A corrupt optional optical asset must leave the ordinary watch usable and
      // explicitly report the fallback, rather than showing a black/frozen screen.
      const failed = await context.newPage();
      await failed.route('**/optics/*.rgba', (route) => route.fulfill({ body: 'corrupt' }));
      await failed.goto(server.base + '__model.html');
      await failed.waitForFunction(() => window.WatchModel);
      const fallback = await failed.evaluate(async (spec) => {
        const model = new window.WatchModel(document.querySelector('#host'), spec, () => {});
        model.setActive(false);
        model.setOpticalStyle('layered');
        await model.load(new AbortController().signal);
        const record = {
          notice: model.opticalNotice(),
          standard: model.display.material === model.screenMaterial,
          caseReady: Boolean(model.geometry),
        };
        model.dispose();
        return record;
      }, spec);
      assert.match(fallback.notice, /Using the standard display/);
      assert.ok(fallback.standard && fallback.caseReady);
      results.push({
        engine,
        browser: browser.version(),
        ...result,
        fallback,
        note: 'Material-only synthetic pixels; numerical assumed-optics reference. Desktop renderer, not phone FPS.',
      });
      await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
      console.log(engine, JSON.stringify(result.shaderError), 'passed');
    } finally {
      await browser.close();
    }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
} finally {
  await server.close();
}
