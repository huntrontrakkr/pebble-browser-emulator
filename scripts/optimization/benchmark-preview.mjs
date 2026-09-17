// Full preview comparison; the busy-UI phase is deliberate synthetic contention.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const [baselineDir, candidateDir, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: benchmark-preview.mjs BASELINE_SITE CANDIDATE_SITE OUTPUT');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
async function serve(directory) {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    try {
      if (!path.startsWith(root + sep)) throw new Error('Outside fixture');
      const bytes = await readFile(path);
      response.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
const baseline = await serve(baselineDir),
  candidate = await serve(candidateDir);
const browser = await chromium.launch();
const results = [];
async function measure(side, round) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const q = (window.previewBench = {
      virtualUs: 0,
      runningPhone: false,
      errors: [],
      received: {},
      sent: {},
      frameBytes: 0,
      draws: 0,
      imageAllocations: 0,
    });
    const OriginalWorker = Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          q.received[data.type] = (q.received[data.type] ?? 0) + 1;
          if (data.type === 'clock') q.virtualUs = data.virtualUs;
          if (data.type === 'state') q.frameBytes += data.state.framebuffer?.byteLength ?? 0;
          if (data.type === 'status' && data.status === 'Running') q.runningPhone = true;
          if (data.type === 'error') q.errors.push(data.message);
        });
      }
      postMessage(data, ...args) {
        q.sent[data.type] = (q.sent[data.type] ?? 0) + 1;
        super.postMessage(data, ...args);
      }
    };
    const draw = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'Live watch framebuffer') q.draws++;
      return draw.apply(this, args);
    };
    const OriginalImage = ImageData;
    const createImage = CanvasRenderingContext2D.prototype.createImageData;
    CanvasRenderingContext2D.prototype.createImageData = function (...args) {
      q.imageAllocations++;
      return createImage.apply(this, args);
    };
    window.ImageData = new Proxy(OriginalImage, {
      construct(target, args) {
        q.imageAllocations++;
        return Reflect.construct(target, args);
      },
    });
  });
  try {
    await page.goto(
      (side === 'baseline' ? baseline : candidate).url + '#/example/clock?watch=qemu_emery',
    );
    await page.getByText('Ready. Use the watch buttons to interact.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.previewBench.runningPhone);
    await page.waitForTimeout(1000);
    const phases = {};
    for (const busy of [false, true]) {
      phases[busy ? 'busyUi' : 'idleUi'] = await page.evaluate(async (busy) => {
        const q = window.previewBench;
        q.received = {};
        q.sent = {};
        q.frameBytes = 0;
        q.draws = 0;
        q.imageAllocations = 0;
        const virtualStart = q.virtualUs,
          began = performance.now();
        for (let i = 0; i < 5; i++) {
          if (busy) {
            const end = performance.now() + 750;
            while (performance.now() < end) {}
          }
          await new Promise((r) => setTimeout(r, busy ? 250 : 1000));
        }
        return {
          wallMs: performance.now() - began,
          virtualSeconds: (q.virtualUs - virtualStart) / 1e6,
          received: q.received,
          sent: q.sent,
          frameBytes: q.frameBytes,
          draws: q.draws,
          imageAllocations: q.imageAllocations,
        };
      }, busy);
      await page.waitForTimeout(500);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.previewBench.errors), []);
    const result = { side, round, ...phases };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await context.close();
  }
}
try {
  for (let round = 0; round < 3; round++)
    for (const side of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
      results.push(await measure(side, round));
  await writeFile(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        browser: browser.version(),
        scope:
          'Chromium on desktop Linux, mobile viewport. Three alternating paired runs of unchanged Clock plus default demo inputs on qemu_emery 4.37.0. Five-second samples; busy UI blocks 750 ms each second. Not a physical-phone measurement.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
  await Promise.all([baseline, candidate].map(({ server }) => new Promise((r) => server.close(r))));
}
