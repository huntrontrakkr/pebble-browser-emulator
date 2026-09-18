import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createResourceService } from './service.mjs';
import { DiskResourceCache } from './disk-cache.mjs';
const port = Number(process.env.RESOURCE_PORT ?? 4318);
const origins = (
  process.env.RESOURCE_ALLOWED_ORIGINS ??
  'http://localhost:4201,http://127.0.0.1:4201,http://localhost:4202,http://127.0.0.1:4202'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const handler = createResourceService({
  origins,
  cache: new DiskResourceCache(process.env.RESOURCE_CACHE_DIR ?? 'tmp/resource-service-cache'),
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
server.listen(port, '127.0.0.1', () =>
  console.log(`Optional download service: http://127.0.0.1:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
