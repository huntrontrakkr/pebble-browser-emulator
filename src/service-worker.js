/* BUILD_INVENTORY */
const scope = new URL(self.registration.scope);
const prefix = `pebble-offline:${scope.pathname}:`;
const cacheName = prefix + VERSION;
const urlFor = (path) => new URL(path, scope).href;
const inventory = new Map(ASSETS.map((asset) => [urlFor(asset.path), asset]));
const shell = (asset) =>
  (!asset.path.includes('/') && /\.(html|css|js|svg|webmanifest)$/.test(asset.path)) ||
  asset.path.startsWith('icons/');
const profiles = ['qemu_emery', 'qemu_flint', 'qemu_gabbro'];
const marker = (profile) => urlFor('__offline_profile__/' + profile);
function downloads(profile) {
  const platform = profile.slice(5);
  return ASSETS.filter(
    (asset) =>
      shell(asset) ||
      asset.path.startsWith('wasm/') ||
      asset.path.startsWith('phone-app/') ||
      asset.path === 'checkpoints/index.json' ||
      asset.path === `checkpoints/${profile}.pbcp` ||
      asset.path === `examples/clock-${platform}.pbw` ||
      (asset.path.startsWith('firmware/') &&
        (!asset.path.endsWith('.gz') || asset.path.includes('/' + profile + '_'))),
  );
}
async function matchesBytes(bytes, asset) {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return bytes.byteLength === asset.bytes && hash === asset.sha256;
}
async function matchesAsset(response, asset) {
  return matchesBytes(await response.clone().arrayBuffer(), asset);
}
async function verifiedResponse(asset, signal, progress) {
  const response = await fetch(urlFor(asset.path), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok || response.redirected)
    throw new Error('A download is unavailable. Please try again online.');
  if (!response.body) throw new Error('The download is empty. Please try again online.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(asset.bytes);
  let length = 0,
    lastProgress = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > asset.bytes)
        throw new Error('The site has changed. Update the app before downloading for offline use.');
      bytes.set(value, length);
      length += value.length;
      if (Date.now() - lastProgress >= 200) {
        progress?.(length);
        lastProgress = Date.now();
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  if (length !== asset.bytes || !(await matchesBytes(bytes, asset)))
    throw new Error('The site has changed. Update the app before downloading for offline use.');
  // Fetch has already decoded any HTTP compression. Cache the verified decoded body.
  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  return new Response(bytes, { status: response.status, headers });
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      try {
        const previous = await Promise.all(
          (await caches.keys())
            .filter((key) => key.startsWith(prefix) && key !== cacheName)
            .map((key) => caches.open(key)),
        );
        const selected = [];
        for (const profile of profiles)
          if ((await Promise.all(previous.map((old) => old.match(marker(profile))))).some(Boolean))
            selected.push(profile);
        const required = new Set([...ASSETS.filter(shell), ...selected.flatMap(downloads)]);
        for (const asset of required) {
          let response;
          for (const old of previous) {
            const saved = await old.match(urlFor(asset.path));
            if (saved && (await matchesAsset(saved, asset))) {
              response = saved;
              break;
            }
          }
          await cache.put(urlFor(asset.path), response ?? (await verifiedResponse(asset)));
        }
        for (const profile of selected) await cache.put(marker(profile), new Response('1'));
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
      // Preserve explicit offline choices, then wait for the user or every old tab to close.
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin) return;
  url.search = '';
  url.hash = '';
  if (url.href === scope.href) url.pathname += 'index.html';
  const asset = inventory.get(url.href);
  if (!asset) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const saved = await cache.match(urlFor(asset.path));
      if (saved) return saved;
      try {
        const response = await verifiedResponse(asset);
        // Storage failure must not prevent online use.
        await cache.put(urlFor(asset.path), response.clone()).catch(() => {});
        return response;
      } catch (error) {
        return new Response(String(error.message), {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    })(),
  );
});
const tasks = new Map();
async function status() {
  const cache = await caches.open(cacheName);
  const saved = new Set((await cache.keys()).map((request) => request.url));
  return {
    version: VERSION,
    bytes: ASSETS.filter((a) => saved.has(urlFor(a.path))).reduce((n, a) => n + a.bytes, 0),
    profiles: Object.fromEntries(
      profiles.map((profile) => [
        profile,
        {
          ready: downloads(profile).every((a) => saved.has(urlFor(a.path))),
          bytes: downloads(profile).reduce((n, a) => n + a.bytes, 0),
        },
      ]),
    ),
  };
}
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !event.source?.id) return;
  const key = event.source.id + ':' + data.id;
  if (data.type === 'CANCEL_CACHE') {
    tasks.get(key)?.abort();
    return;
  }
  const port = event.ports[0];
  if (!port) return;
  event.waitUntil(
    (async () => {
      try {
        if (data.type === 'STATUS') port.postMessage({ done: true, value: await status() });
        else if (data.type === 'CACHE_PROFILE') {
          if (!profiles.includes(data.profile)) throw new Error('Choose a supported watch.');
          if ([...tasks.keys()].some((k) => k.startsWith(event.source.id + ':')))
            throw new Error('A download is already running.');
          const controller = new AbortController();
          tasks.set(key, controller);
          try {
            const cache = await caches.open(cacheName),
              assets = downloads(data.profile);
            const total = assets.reduce((n, a) => n + a.bytes, 0);
            let completed = 0;
            for (const asset of assets) {
              controller.signal.throwIfAborted();
              if (!(await cache.match(urlFor(asset.path))))
                await cache.put(
                  urlFor(asset.path),
                  await verifiedResponse(asset, controller.signal, (bytes) =>
                    port.postMessage({ progress: Math.round(((completed + bytes) / total) * 100) }),
                  ),
                );
              completed += asset.bytes;
              port.postMessage({ progress: Math.round((completed / total) * 100) });
            }
            controller.signal.throwIfAborted();
            await cache.put(marker(data.profile), new Response('1'));
            port.postMessage({ done: true, value: await status() });
          } finally {
            tasks.delete(key);
          }
        } else if (data.type === 'CLEAR_DOWNLOADS') {
          if (tasks.size) throw new Error('Finish or cancel downloads first.');
          const cache = await caches.open(cacheName);
          for (const asset of ASSETS.filter((a) => !shell(a)))
            await cache.delete(urlFor(asset.path));
          for (const profile of profiles) await cache.delete(marker(profile));
          port.postMessage({ done: true, value: await status() });
        } else if (data.type === 'APPLY_UPDATE') {
          const tabs = (
            await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          ).filter((c) => c.frameType !== 'nested' && c.url.startsWith(scope.href));
          if (tabs.length > 1) throw new Error('Close the other emulator tabs before updating.');
          port.postMessage({ done: true });
          await self.skipWaiting();
        } else throw new Error('Unknown offline request.');
      } catch (error) {
        port.postMessage({
          done: true,
          error: error.name === 'AbortError' ? 'Download canceled.' : String(error.message),
        });
      } finally {
        port.close();
      }
    })(),
  );
});
