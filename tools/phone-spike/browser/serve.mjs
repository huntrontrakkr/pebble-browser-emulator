// A static server for the spike's browser runs: serves `root` on both loopback names.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** `handle` may answer a request first and return true. */
export async function serve(root, handle = () => false) {
  const server = createServer(async (request, response) => {
    if (handle(request, response)) return;
    let path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (path.endsWith('/')) path += 'index.html';
    try {
      const body = await readFile(join(root, path));
      response.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready) => server.listen(0, ready));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  };
}
