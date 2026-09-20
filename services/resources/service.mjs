// Portable HTTP handler. Browser emulation does not depend on this optional service.
import { isPublicResource } from '../../src/app/resource-fetch.ts';
const MAX_BYTES = 32 * 1048576;
const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

export class MemoryResourceCache {
  constructor(maximum = 16 * 1048576) {
    this.maximum = maximum;
    this.entries = new Map();
  }
  async get(url) {
    return this.entries.get(url);
  }
  async blob(hash) {
    return [...this.entries.values()].find((e) => e.sha256 === hash);
  }
  async put(url, entry) {
    if (entry.bytes.length > this.maximum) return;
    this.entries.delete(url);
    this.entries.set(url, entry);
    while (
      this.entries.size > 256 ||
      [...this.entries.values()].reduce((n, e) => n + e.bytes.length, 0) > this.maximum
    )
      this.entries.delete(this.entries.keys().next().value);
  }
}
/** Length-independent comparison, so a wrong key leaks no timing signal. */
function matchesKey(offered, expected) {
  if (typeof offered !== 'string' || offered.length !== expected.length) return false;
  let differences = 0;
  for (let i = 0; i < expected.length; i++)
    differences |= offered.charCodeAt(i) ^ expected.charCodeAt(i);
  return differences === 0;
}
function redirectAllowed(value, original) {
  const url = new URL(value),
    source = new URL(original);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    return false;
  if (isPublicResource(value)) return url.hostname === source.hostname;
  if (source.hostname === 'github.com' && url.hostname === 'release-assets.githubusercontent.com')
    return true;
  return (
    source.hostname === 'appstore-api.repebble.com' &&
    url.hostname ===
      'pebble-appstore-backend.497e529f13ec4afbfce4dfe3cfd3634d.r2.cloudflarestorage.com'
  );
}
async function boundedBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new Error('Resource exceeds the download limit.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('Resource exceeds the download limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function createResourceService({
  request = globalThis.fetch,
  cache = new MemoryResourceCache(),
  origins = [],
  now = Date.now,
  maximum = MAX_BYTES,
  timeoutMs = 30000,
  maxActive = 2,
  // Relaying watchface API calls is off unless a deployment supplies both a key
  // and a relay, so a service that is merely started cannot become an open one.
  relay = null,
  relayKey = '',
  relayMaxBytes = 1048576,
  relayTimeoutMs = 20000,
} = {}) {
  const relayEnabled = typeof relay === 'function' && relayKey.length >= 16;
  let active = 0;
  // A separate budget: relayed calls must not spend the download allowance.
  let relayTokens = 60,
    relayRefillAt = now();
  // One shared service budget; no client-controlled IP headers or unbounded limiter map.
  let tokens = 120,
    refillAt = now();
  return async function handle(incoming) {
    const origin = incoming.headers.get('origin');
    const allowed = !origin || origins.includes(origin);
    const headers = new Headers({
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    });
    if (origin && allowed) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Expose-Headers', 'X-Resource-SHA256, X-Resource-Cache, ETag');
    }
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' },
      });
    if (!allowed) return json({ error: 'Origin is not enabled for this service.' }, 403);
    if (incoming.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers });
    }
    if (!['GET', 'HEAD'].includes(incoming.method))
      return json({ error: 'Only public downloads are supported.' }, 405);
    const path = new URL(incoming.url);
    if (path.pathname === '/v1/status')
      return json({
        protocol: 'pebble-resources-v1',
        maximumBytes: maximum,
        capabilities: [
          'public-downloads',
          'content-hashes',
          'cache',
          ...(relayEnabled ? ['app-relay'] : []),
        ],
        execution: 'browser',
      });
    if (path.pathname === '/v1/app-fetch') {
      if (!relayEnabled) return json({ error: 'This service does not relay app requests.' }, 404);
      if (!matchesKey(incoming.headers.get('x-pebble-relay-key'), relayKey))
        return json({ error: 'A valid relay key is required.' }, 401);
      const target = path.searchParams.get('url');
      if (!target || target.length > 4096 || path.searchParams.getAll('url').length !== 1)
        return json({ error: 'One url parameter is required.' }, 400);
      relayTokens = Math.min(60, relayTokens + Math.max(0, now() - relayRefillAt) / 2000);
      relayRefillAt = now();
      if (relayTokens < 1 || active >= maxActive) {
        headers.set('Retry-After', '2');
        return json({ error: 'Service is busy. Retry shortly.' }, 429);
      }
      relayTokens--;
      active++;
      try {
        const result = await relay(target, {
          method: incoming.method === 'HEAD' ? 'HEAD' : 'GET',
          headers: { accept: incoming.headers.get('accept') ?? '*/*' },
          maxBytes: relayMaxBytes,
          timeoutMs: relayTimeoutMs,
        });
        for (const [name, value] of Object.entries(result.headers))
          if (name === 'content-type') headers.set('Content-Type', String(value));
        headers.set('X-Relay-Status', String(result.status));
        return new Response(incoming.method === 'HEAD' ? null : result.body, {
          status: result.status,
          headers,
        });
      } catch (error) {
        // The reason is reported; a refused request is never dressed as a reply.
        return json({ error: String(error?.message ?? error) }, 502);
      } finally {
        active--;
      }
    }
    const blob = path.pathname.match(/^\/v1\/blobs\/([a-f0-9]{64})$/);
    let url;
    if (!blob) {
      if (path.pathname !== '/v1/resource') return json({ error: 'Unknown endpoint.' }, 404);
      url = path.searchParams.get('url');
      if (
        !url ||
        url.length > 4096 ||
        !isPublicResource(url) ||
        path.searchParams.getAll('url').length !== 1 ||
        [...path.searchParams.keys()].some((k) => k !== 'url')
      )
        return json({ error: 'Unsupported public resource URL.' }, 400);
    }
    tokens = Math.min(120, tokens + Math.max(0, now() - refillAt) / 1000);
    refillAt = now();
    if (tokens < 1 || active >= maxActive) {
      headers.set('Retry-After', '2');
      return json({ error: 'Service is busy. Retry shortly.' }, 429);
    }
    tokens--;
    active++;
    try {
      let entry = blob ? await cache.blob(blob[1]) : await cache.get(url);
      let hit = !!entry;
      if (blob && !entry) return json({ error: 'This cached version is unavailable.' }, 404);
      if (!blob && (!entry || entry.expires <= now())) {
        const signal = AbortSignal.any([incoming.signal, AbortSignal.timeout(timeoutMs)]);
        let current = url,
          response;
        for (let hop = 0; hop < 6; hop++) {
          response = await request(current, {
            method: 'GET',
            signal,
            redirect: 'manual',
            credentials: 'omit',
            headers: {
              Accept:
                new URL(url).hostname === 'api.github.com' ? 'application/vnd.github+json' : '*/*',
              'User-Agent': 'PebbleBrowserEmulator-ResourceService/1',
            },
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || !redirectAllowed(new URL(location, current).href, url))
            return json({ error: 'The upstream redirect is not an approved resource host.' }, 502);
          current = new URL(location, current).href;
          response = undefined;
        }
        if (!response) return json({ error: 'Too many upstream redirects.' }, 502);
        if (!response.ok) {
          await response.body?.cancel();
          return json(
            { error: `Upstream returned ${response.status}.` },
            response.status === 404 ? 404 : 502,
          );
        }
        // Never serve remote HTML or execute repository code on our origin.
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        if (/text\/html|application\/xhtml/i.test(contentType)) {
          await response.body?.cancel();
          return json({ error: 'HTML pages are not supported by the download service.' }, 415);
        }
        const bytes = await boundedBytes(response, maximum);
        signal.throwIfAborted();
        const sha256 = await digest(bytes);
        const metadata =
          ['api.github.com', 'appstore-api.repebble.com'].includes(new URL(url).hostname) &&
          !new URL(url).pathname.includes('/assets/');
        entry = {
          bytes,
          sha256,
          source: url,
          saved: now(),
          expires: now() + (metadata ? 60000 : 3600000),
          cacheable: !/private|no-store/i.test(response.headers.get('cache-control') ?? ''),
        };
        // Respect explicit upstream restrictions on shared caching.
        if (entry.cacheable) await cache.put(url, entry).catch(() => {});
        hit = false;
      }
      if (!entry || entry.bytes.length > maximum || (await digest(entry.bytes)) !== entry.sha256)
        return json({ error: 'Cached resource failed integrity verification.' }, 502);
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', 'attachment');
      headers.set('Content-Length', String(entry.bytes.length));
      headers.set('X-Resource-SHA256', entry.sha256);
      headers.set('X-Resource-Cache', hit ? 'hit' : 'miss');
      headers.set('ETag', `"${entry.sha256}"`);
      headers.set(
        'Cache-Control',
        entry.cacheable === false
          ? 'no-store'
          : blob
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=60',
      );
      return new Response(incoming.method === 'HEAD' ? null : entry.bytes, { headers });
    } catch (error) {
      return json(
        {
          error: incoming.signal.aborted
            ? 'Download canceled.'
            : String(error?.message ?? 'Download failed.').slice(0, 200),
        },
        502,
      );
    } finally {
      active--;
    }
  };
}

// Optional edge entry point; the frontend remains independently deployable.
let edge;
export default {
  fetch(request, env = {}) {
    edge ??= createResourceService({
      origins: String(env.RESOURCE_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxActive: 1,
    });
    return edge(request);
  },
};
