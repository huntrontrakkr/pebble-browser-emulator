// Pinned upstream CAD remains a local test input, never a redistributed asset.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import assert from 'node:assert/strict';
import { WATCH_MODELS, modelUrl } from '../src/app/watch-model-specs.ts';

export async function cadFixtures(directory = process.env.PEBBLE_CAD_DIR ?? 'tmp/model-cad') {
  await mkdir(directory, { recursive: true });
  const files = new Map();
  for (const spec of Object.values(WATCH_MODELS)) {
    const path = resolve(directory, spec.profile + '.stl');
    let bytes;
    try {
      bytes = await readFile(path);
    } catch {
      const response = await fetch(modelUrl(spec));
      assert.ok(response.ok, 'Pinned CAD download');
      bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.sha256);
      await writeFile(path, bytes);
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.sha256);
    files.set(modelUrl(spec), bytes);
  }
  return files;
}

export async function modelServer(directory = 'dist/client') {
  const root = resolve(directory);
  let chunk;
  for (const file of await readdir(root)) {
    if (
      file.startsWith('chunk-') &&
      file.endsWith('.js') &&
      (await readFile(resolve(root, file), 'utf8')).includes('as WatchModel')
    )
      chunk = file;
  }
  assert.ok(chunk, 'Production WatchModel chunk exists');
  const mime = {
    '.js': 'text/javascript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/__model.html') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          // The optimized lazy chunk shares exports with the main entry. Give
          // Angular a valid, inactive host so importing it does not log NG05104.
          `<html><body style="margin:0"><app-root style="display:none"></app-root><div id="host" style="width:390px;height:460px"></div><script type="module">window.WatchModel = (await import('./${chunk}')).WatchModel;</script></body></html>`,
        );
        return;
      }
      const path = resolve(root, decodeURIComponent(url.pathname.slice(1)) || 'index.html');
      assert.ok(path.startsWith(root + sep));
      const data = await readFile(path);
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => server.close(done)),
  };
}
