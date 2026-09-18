// Discovery/download only. Public metadata is data; PBWs are never executed on the host.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { save, sha, pool, integer } from './common.mjs';
import { storePackageUrl } from '../../src/app/store-catalog.ts';
const out = resolve(process.argv[2] ?? 'tmp/compatibility-census');
await mkdir(out, { recursive: true });
// Exclusive lock also prevents overwriting an existing discovery snapshot.
await writeFile(join(out, 'discovery.lock'), String(process.pid), { flag: 'wx' });
await mkdir(join(out, 'catalog'), { recursive: true });
await mkdir(join(out, 'packages'), { recursive: true });
const count = integer(process.env.PEBBLE_CORPUS_COUNT, 100, 1, 100);
async function download(url, maxBytes) {
  let response;
  const signal = AbortSignal.timeout(60000);
  for (let hop = 0; hop < 4; hop++) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      ![
        'appstore-api.repebble.com',
        'assets.repebble.com',
        'pebble-appstore-backend.497e529f13ec4afbfce4dfe3cfd3634d.r2.cloudflarestorage.com',
      ].includes(target.hostname)
    )
      throw new Error('Unapproved download redirect host');
    response = await fetch(target, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    url = new URL(response.headers.get('location'), target).href;
  }
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Download size limit exceeded');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const entries = [];
const sources = await pool(['watchapps-and-companions', 'watchfaces'], 2, async (category) => {
  const url = `https://appstore-api.repebble.com/api/v1/apps/collection/most-loved/${category}?hardware=emery&limit=${count}&offset=0`;
  const bytes = await download(url, 16 * 2 ** 20),
    data = JSON.parse(bytes);
  await writeFile(join(out, 'catalog', category + '.json'), bytes);
  if (!Array.isArray(data.data) || data.data.length !== count)
    throw new Error('Incomplete ranking: ' + category);
  const seen = new Set();
  data.data.forEach((app, index) => {
    if (!/^[a-f0-9]{24}$/.test(app.id) || seen.has(app.id))
      throw new Error('Invalid/duplicate catalog ID');
    seen.add(app.id);
    entries.push({
      id: app.id,
      category,
      rank: index + 1,
      title: app.title,
      hearts: app.hearts,
      version: app.latest_release?.version,
      url: app.latest_release?.pbw_file,
      listing: `https://apps.repebble.com/app_${app.id}`,
      advertisedPlatforms: app.hardware_platforms?.map((p) => p.name) ?? [],
    });
  });
  return { category, url, retrievedAt: new Date().toISOString(), sha256: sha(bytes) };
});
if (new Set(entries.map((e) => e.id)).size !== entries.length)
  throw new Error('Cross-category duplicate ID');
await pool(entries, 6, async (entry) => {
  entry.acquisition = { startedAt: new Date().toISOString(), attempts: [] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = storePackageUrl(entry.url, entry.id);
      const bytes = await download(url, 80 * 2 ** 20);
      const path = `packages/${entry.id}.pbw`;
      await writeFile(join(out, path), bytes);
      Object.assign(entry.acquisition, { path, bytes: bytes.length, sha256: sha(bytes) });
      entry.acquisition.attempts.push({ attempt, finishedAt: new Date().toISOString() });
      break;
    } catch (error) {
      entry.acquisition.attempts.push({
        attempt,
        finishedAt: new Date().toISOString(),
        error: String(error),
        cause: String(error.cause ?? ''),
      });
    }
  }
});
entries.sort((a, b) => a.category.localeCompare(b.category) || a.rank - b.rank);
await save(join(out, 'manifest.json'), {
  format: 'pebble-compatibility-corpus',
  version: 1,
  createdAt: new Date().toISOString(),
  ranking:
    'Official Most Loved collection; public hearts, NOT measured usage or installs; emery discovery filter retained verbatim.',
  sources,
  profiles: ['qemu_emery', 'qemu_flint', 'qemu_gabbro'],
  entries,
});
console.log(
  JSON.stringify({
    entries: entries.length,
    downloaded: entries.filter((e) => e.acquisition.path).length,
    out,
  }),
);
