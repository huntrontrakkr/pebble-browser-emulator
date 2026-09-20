import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createResourceService } from './service.mjs';
import { DiskResourceCache } from './disk-cache.mjs';
import { relayRequest } from './app-proxy.mjs';
const port = Number(process.env.RESOURCE_PORT ?? 4318);
const origins = (
  process.env.RESOURCE_ALLOWED_ORIGINS ??
  'http://localhost:4201,http://127.0.0.1:4201,http://localhost:4202,http://127.0.0.1:4202'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Relaying watchface API calls stays off until a deployment sets a key. A key
// shipped to browsers deters casual abuse and can be rotated; it is not a
// secret, so the size, time and rate bounds are what actually limit damage.
const relayKey = process.env.RESOURCE_RELAY_KEY ?? '';
const handler = createResourceService({
  origins,
  cache: new DiskResourceCache(process.env.RESOURCE_CACHE_DIR ?? 'tmp/resource-service-cache'),
  relay: relayKey ? relayRequest : null,
  relayKey,
});
const server = createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    const request = new Request(new URL(req.url, `http://127.0.0.1:${port}`), {
      method: req.method,
      headers: req.headers,
      signal: controller.signal,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('Resource service failed.');
  }
});
const host = process.env.RESOURCE_HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Optional download service: http://${host}:${port}`);
  console.log(`App relay: ${relayKey ? 'enabled' : 'disabled (set RESOURCE_RELAY_KEY)'}`);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
