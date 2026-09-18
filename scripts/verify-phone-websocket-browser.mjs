// Real browser Worker + QuickJS + native WebSocket round-trip; local fixture only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/phone-websocket-browser');
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['src/app/phone.worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: resolve(out, 'worker.mjs'),
});
const assets = new Map([
  ['/worker.mjs', [await readFile(resolve(out, 'worker.mjs')), 'text/javascript']],
  ['/quickjs.wasm', [await readFile('public/wasm/quickjs.wasm'), 'application/wasm']],
  ['/', [Buffer.from('<!doctype html><title>Phone WebSocket integration</title>'), 'text/html']],
]);
let connections = 0;
const live = new Set();
const server = createServer((req, res) => {
  const a = assets.get(req.url);
  if (!a) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': a[1] });
  res.end(a[0]);
});
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/socket' || head.length) {
    socket.destroy();
    return;
  }
  connections++;
  live.add(socket);
  socket.on('close', () => live.delete(socket));
  socket.on('error', () => {});
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept +
      '\r\nSec-WebSocket-Protocol: phone-test\r\n\r\n',
  );
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const n = pending[1] & 127,
        op = pending[0] & 15;
      if (!(pending[1] & 128) || n > 125) {
        socket.destroy();
        return;
      }
      if (pending.length < n + 6) return;
      const mask = pending.subarray(2, 6),
        data = Buffer.from(pending.subarray(6, 6 + n));
      for (let i = 0; i < n; i++) data[i] ^= mask[i % 4];
      pending = pending.subarray(6 + n);
      const frame = Buffer.concat([Buffer.from([128 | op, n]), data]);
      if (op === 8) {
        socket.end(frame);
        return;
      }
      if (op === 1 || op === 2) socket.write(frame);
      else socket.destroy();
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`,
  results = [];
try {
  for (const engine of (process.env.PEBBLE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
    const browser = await { chromium, firefox, webkit }[engine].launch({
      ...(engine === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
        : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      await page.evaluate(() => {
        window.events = [];
        window.phone = new Worker('/worker.mjs', { type: 'module' });
        phone.onmessage = (e) => events.push(e.data);
      });
      const before = connections;
      await page.evaluate(
        ({ base }) =>
          phone.postMessage({
            type: 'start',
            appId: 'socket-fixture',
            name: 'socket-fixture.js',
            wasmUrl: base + '/quickjs.wasm',
            connected: true,
            nowMs: 0,
            network: { mode: 'cors' },
            source: `var socket=new WebSocket('${base.replace('http:', 'ws:')}/socket',['phone-test']);socket.binaryType='arraybuffer';socket.onopen=()=>{console.log('OPEN',socket.protocol);socket.send('echo');socket.send(new Uint8Array([3,5,8]));};var received=0;socket.onmessage=e=>{console.log(typeof e.data==='string'?e.data:Array.from(new Uint8Array(e.data)).join(','));if(++received===2)socket.close(4001,'done');};socket.onclose=e=>console.log('CLOSE',e.code,e.reason,e.wasClean);socket.onerror=()=>console.log('ERROR');`,
          }),
        { base },
      );
      await page.waitForFunction(
        () => events.some((m) => m.event?.text === 'CLOSE 4001 done true'),
        {},
        { timeout: 30000 },
      );
      const captured = await page.evaluate(() => events);
      assert.equal(connections - before, 1);
      assert.deepEqual(
        captured.filter((m) => m.event?.type === 'log').map((m) => m.event.text),
        ['OPEN phone-test', 'echo', '3,5,8', 'CLOSE 4001 done true'],
      );
      assert.equal(captured.filter((m) => m.type === 'error').length, 0);
      const mark = captured.length;
      await page.evaluate(
        ({ base }) =>
          phone.postMessage({
            type: 'start',
            appId: 'offline-fixture',
            name: 'offline.js',
            wasmUrl: base + '/quickjs.wasm',
            network: { mode: 'disabled' },
            source: `var s=new WebSocket('${base.replace('http:', 'ws:')}/socket');s.onopen=()=>console.log('BAD');s.onerror=()=>console.log('OFFLINE');s.onclose=e=>console.log('OFFLINE CLOSE',e.code);`,
          }),
        { base },
      );
      await page.waitForFunction(
        (mark) => events.slice(mark).some((m) => m.event?.text === 'OFFLINE CLOSE 1006'),
        mark,
      );
      assert.equal(connections - before, 1);
      await page.evaluate(
        ({ base }) =>
          phone.postMessage({
            type: 'start',
            appId: 'stale-fixture',
            name: 'stale.js',
            wasmUrl: base + '/quickjs.wasm',
            network: { mode: 'cors' },
            source: `var s=new WebSocket('${base.replace('http:', 'ws:')}/socket',['phone-test']);s.onopen=()=>console.log('HOLD');s.onclose=()=>console.log('STALE');s.onmessage=()=>console.log('STALE');`,
          }),
        { base },
      );
      await page.waitForFunction(() => events.some((m) => m.event?.text === 'HOLD'));
      await page.evaluate(
        ({ base }) =>
          phone.postMessage({
            type: 'start',
            appId: 'fresh-fixture',
            name: 'fresh.js',
            wasmUrl: base + '/quickjs.wasm',
            network: { mode: 'disabled' },
            source: `console.log('FRESH');`,
          }),
        { base },
      );
      await page.waitForFunction(() => events.some((m) => m.event?.text === 'FRESH'));
      const deadline = Date.now() + 3000;
      while (live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(live.size, 0, 'Restart closes the previous phone socket.');
      assert.equal(await page.evaluate(() => events.some((m) => m.event?.text === 'STALE')), false);
      await page.evaluate(() => phone.postMessage({ type: 'stop' }));
      results.push({
        engine,
        liveTextAndBinary: true,
        cleanClose: true,
        offlineBlocked: true,
        restartQuarantined: true,
        events: await page.evaluate(() => events),
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  for (const socket of live) socket.destroy();
  await new Promise((r) => server.close(r));
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}
console.log(JSON.stringify(results.map(({ events, ...r }) => r)));
