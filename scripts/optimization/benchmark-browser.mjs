// Browser-worker confirmation, separate from the Node score used during discovery.
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [baseline, candidate, assets, output] = process.argv.slice(2);
if (!output)
  throw new Error('Usage: benchmark-browser.mjs BASELINE_WASM CANDIDATE_WASM FIRMWARE_DIR OUTPUT');
const worker = `import {workload} from '/workload.mjs';
onmessage=async({data})=>{try{
 const {side,profile,id}=data;
 const bytes=await Promise.all([fetch('/'+side+'.wasm').then(r=>r.arrayBuffer()),fetch('/'+profile+'_v4.37.0_micro_flash.bin').then(r=>r.arrayBuffer()),fetch('/'+profile+'_v4.37.0_spi_flash.bin').then(r=>r.arrayBuffer())]);
 const module=await WebAssembly.compile(bytes[0]);
 const samples=[];
 for(let round=-1;round<3;round++){
  const api=(await WebAssembly.instantiate(module,{})).exports;
  const result=workload(api,new Uint8Array(bytes[1]),new Uint8Array(bytes[2]),id);
  const trace=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(result.checkpoints))))).map(x=>x.toString(16).padStart(2,'0')).join('');
  if(round>=0)samples.push({phases:result.phases,schedulerSteps:result.schedulerSteps,memoryBytes:result.memoryBytes,traceSha256:trace});
 }
 postMessage({samples});
}catch(e){postMessage({error:String(e)})}};`;
const files = new Map([
  ['/baseline.wasm', [baseline, 'application/wasm']],
  ['/candidate.wasm', [candidate, 'application/wasm']],
  ['/workload.mjs', [new URL('./core-workload.mjs', import.meta.url), 'text/javascript']],
]);
for (const profile of ['qemu_flint', 'qemu_emery', 'qemu_gabbro'])
  for (const role of ['micro', 'spi']) {
    const name = `${profile}_v4.37.0_${role}_flash.bin`;
    files.set('/' + name, [resolve(assets, name), 'application/octet-stream']);
  }
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Core benchmark</title>');
    } else if (request.url === '/worker.mjs') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(worker);
    } else if (files.has(request.url)) {
      const [path, type] = files.get(request.url);
      response.setHeader('Content-Type', type);
      response.end(await readFile(path));
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch {
    response.writeHead(500);
    response.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium').split(',')) {
    const browser = await { chromium, firefox, webkit }[engine].launch({
      ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
        : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      for (const profile of (
        process.env.PEBBLE_PROFILES ?? 'qemu_flint,qemu_emery,qemu_gabbro'
      ).split(',')) {
        const id = { qemu_flint: 1, qemu_emery: 2, qemu_gabbro: 3 }[profile];
        const bySide = {};
        // Reverse order by profile to reduce a systematic first/second-run bias.
        for (const side of id % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          bySide[side] = await page.evaluate(
            (data) =>
              new Promise((resolve, reject) => {
                const w = new Worker('/worker.mjs', { type: 'module' });
                const timer = setTimeout(() => {
                  w.terminate();
                  reject(new Error('Core benchmark exceeded 90 seconds'));
                }, 90000);
                w.onerror = (e) => {
                  clearTimeout(timer);
                  w.terminate();
                  reject(new Error(e.message));
                };
                w.onmessage = ({ data }) => {
                  clearTimeout(timer);
                  w.terminate();
                  data.error ? reject(new Error(data.error)) : resolve(data.samples);
                };
                w.postMessage(data);
              }),
            { side, profile, id },
          );
        }
        const expected = bySide.baseline[0].traceSha256;
        for (const sample of [...bySide.baseline, ...bySide.candidate])
          assert.equal(sample.traceSha256, expected);
        const total = (s) => s.phases.boot + s.phases.buttons;
        const speedup = median(bySide.baseline.map(total)) / median(bySide.candidate.map(total));
        results.push({
          engine,
          browserVersion: browser.version(),
          profile,
          speedup,
          traceSha256: expected,
          ...bySide,
        });
        console.log(JSON.stringify({ engine, profile, speedup, traceEqual: true }));
      }
    } finally {
      await browser.close();
    }
  }
  const hash = async (p) =>
    createHash('sha256')
      .update(await readFile(p))
      .digest('hex');
  await writeFile(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        scope:
          'Actual Linux browser Workers; core-only throughput, not UI FPS or physical-phone measurement',
        baselineSha256: await hash(baseline),
        candidateSha256: await hash(candidate),
        results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await new Promise((r) => server.close(r));
}
