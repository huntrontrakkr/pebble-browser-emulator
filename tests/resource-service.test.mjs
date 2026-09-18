import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResourceFetch,
  normalizeResourceSettings,
  isPublicResource,
} from '../src/app/resource-fetch.ts';
import { createResourceService, MemoryResourceCache } from '../services/resources/service.mjs';
import { DiskResourceCache } from '../services/resources/disk-cache.mjs';
import {
  parsePreviewLink,
  previewLink,
  storePreview,
  repositoryPreview,
} from '../src/app/preview-links.ts';
import { bytesHash } from '../src/app/resource-cache.ts';
import { storePage, storeAppId, storePackageUrl } from '../src/app/store-catalog.ts';

const origin = 'https://emulator.example';
const artifact =
  'https://github.com/coredevices/PebbleOS/releases/download/v4.37.0/qemu_emery_v4.37.0_micro_flash.bin';
const request = (url) =>
  new Request(`https://resources.example/v1/resource?url=${encodeURIComponent(url)}`, {
    headers: { Origin: origin },
  });
const off = { enabled: false, endpoint: '' },
  on = { enabled: true, endpoint: 'https://resources.example' };

test('disabled resource assistance never contacts a service; direct success never relays', async () => {
  const calls = [];
  const direct = createResourceFetch(
    () => on,
    async (url) => {
      calls.push(String(url));
      return new Response('ok');
    },
  );
  assert.equal(await (await direct(artifact)).text(), 'ok');
  assert.deepEqual(calls, [artifact]);
  const failing = createResourceFetch(
    () => off,
    async (url) => {
      calls.push(String(url));
      throw new TypeError('Failed to fetch');
    },
  );
  await assert.rejects(failing(artifact), /fetch/);
  assert.deepEqual(calls, [artifact, artifact]);
});

test('relay is opt-in and never retries cancellation, guest URLs or authenticated requests', async () => {
  const calls = [];
  const fetcher = createResourceFetch(
    () => on,
    async (url, init) => {
      calls.push([String(url), init]);
      if (String(url).startsWith(on.endpoint)) return new Response('download');
      throw new TypeError('CORS');
    },
  );
  assert.equal(await (await fetcher(artifact)).text(), 'download');
  assert.equal(new URL(calls[1][0]).searchParams.get('url'), artifact);
  assert.equal(calls[1][1].credentials, 'omit');
  const before = calls.length;
  await assert.rejects(fetcher('https://weather.example/data'));
  await assert.rejects(fetcher(artifact, { headers: { Authorization: 'Bearer private' } }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetcher(artifact, { signal: controller.signal }), /abort/i);
  assert.equal(calls.length, before + 3);
});

test('service settings reject credentials and mixed remote HTTP; no endpoint comes from preview URLs', () => {
  for (const endpoint of [
    'http://public.example',
    'https://user:pass@example.com',
    'https://example.com/?token=secret',
    'javascript:alert(1)',
  ])
    assert.throws(() => normalizeResourceSettings({ enabled: true, endpoint }));
  assert.equal(
    normalizeResourceSettings({ enabled: true, endpoint: 'http://127.0.0.1:4318/' }).endpoint,
    'http://127.0.0.1:4318',
  );
  assert.throws(() => parsePreviewLink('#/example/clock?service=https://evil.example'));
  for (const url of [
    'https://localhost/private',
    'http://github.com/a/b/releases/download/x/y',
    'https://github.com/a/b/issues',
    'https://api.github.com@127.0.0.1/repos/a/b',
  ])
    assert.equal(isPublicResource(url), false);
});

test('public service follows only approved redirects and returns real verified bytes', async () => {
  const calls = [],
    cache = new MemoryResourceCache();
  const handler = createResourceService({
    origins: [origin],
    cache,
    request: async (url, init) => {
      calls.push([url, init]);
      return url === artifact
        ? new Response(null, {
            status: 302,
            headers: {
              Location: 'https://release-assets.githubusercontent.com/file?signature=test',
            },
          })
        : new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'Content-Type': 'application/octet-stream' },
          });
    },
  });
  const first = await handler(request(artifact));
  assert.equal(first.status, 200);
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3]);
  const hash = first.headers.get('x-resource-sha256');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(first.headers.get('access-control-allow-origin'), origin);
  const second = await handler(request(artifact));
  assert.equal(second.headers.get('x-resource-cache'), 'hit');
  assert.equal(calls.length, 2);
  const immutable = await handler(new Request(`https://resources.example/v1/blobs/${hash}`));
  assert.equal(immutable.status, 200);
  assert.match(immutable.headers.get('cache-control'), /immutable/);
  assert.ok(
    calls.every(
      ([, init]) => init.redirect === 'manual' && !new Headers(init.headers).has('authorization'),
    ),
  );
});

test('service rejects unapproved origins, private redirects, HTML, oversized bodies and write methods', async () => {
  const denied = createResourceService({
    request: async () => {
      throw new Error('must not fetch');
    },
  });
  assert.equal((await denied(request(artifact))).status, 403);
  for (const location of [
    'http://127.0.0.1/secret',
    'https://169.254.169.254/latest',
    'https://untrusted.example/file',
    'https://github.com@127.0.0.1/',
  ]) {
    let calls = 0;
    const handler = createResourceService({
      origins: [origin],
      request: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { Location: location } });
      },
    });
    assert.equal((await handler(request(artifact))).status, 502);
    assert.equal(calls, 1);
  }
  const html = createResourceService({
    origins: [origin],
    request: async () =>
      new Response('<script>bad</script>', { headers: { 'Content-Type': 'text/html' } }),
  });
  assert.equal((await html(request(artifact))).status, 415);
  const big = createResourceService({
    origins: [origin],
    maximum: 2,
    request: async () => new Response('abc'),
  });
  assert.equal((await big(request(artifact))).status, 502);
  assert.equal(
    (await big(new Request('https://resources.example/v1/resource', { method: 'POST' }))).status,
    405,
  );
});

test('disk cache has bounded storage and immutable hash lookups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pebble-resources-'));
  try {
    const cache = new DiskResourceCache(directory, 3);
    const a = {
      bytes: Uint8Array.of(1, 2),
      sha256: 'a'.repeat(64),
      saved: 1,
      expires: 99,
      source: 'a',
    };
    await cache.put('a', a);
    assert.deepEqual((await cache.blob(a.sha256)).bytes, a.bytes);
    await cache.put('b', { ...a, sha256: 'b'.repeat(64), saved: 2 });
    assert.equal(await cache.get('a'), undefined);
    assert.ok(await cache.get('b'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uncacheable upstream data stays uncacheable and a relay abort remains an abort', async () => {
  let upstream = 0;
  const handler = createResourceService({
    origins: [origin],
    request: async () => {
      upstream++;
      return new Response('public bytes', { headers: { 'Cache-Control': 'no-store' } });
    },
  });
  for (let i = 0; i < 2; i++)
    assert.equal((await handler(request(artifact))).headers.get('cache-control'), 'no-store');
  assert.equal(upstream, 2);
  const controller = new AbortController();
  const fetcher = createResourceFetch(
    () => on,
    async (url) => {
      if (String(url).startsWith(on.endpoint)) {
        controller.abort();
        throw controller.signal.reason;
      }
      return new Response(null, { status: 503 });
    },
  );
  await assert.rejects(fetcher(artifact, { signal: controller.signal }), /abort/i);
});

const id = '50bdea7ee3ff48308157c046';
const pbw = `https://appstore-api.repebble.com/api/assets/pbw/${id}/1.2/1b2bf26b-122f-43f5-842f-1f852487a16f.pbw`;
const app = {
  id,
  title: 'JustTheTime',
  author: 'Noah',
  latest_release: { version: '1.2', pbw_file: pbw },
  hardware_platforms: [
    { name: 'emery', images: { screenshot: 'https://assets.repebble.com/a.png' } },
  ],
};
test('store links pin original packages and remain portable under a static subdirectory', async () => {
  const target = parsePreviewLink(`#/store/${id}`),
    calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return url === pbw ? new Response('real package') : Response.json({ data: [app] });
  };
  const result = await storePreview(target, new AbortController().signal, () => {}, fetcher);
  assert.equal(result.title, 'JustTheTime');
  assert.equal(result.target.pbw, pbw);
  assert.match(result.target.sha256, /^[a-f0-9]{64}$/);
  const link = previewLink('https://example.test/emulator/', result.target);
  assert.equal(new URL(link).pathname, '/emulator/');
  assert.deepEqual(parsePreviewLink(new URL(link).hash), result.target);
  await storePreview(
    result.target,
    new AbortController().signal,
    () => {},
    async (url) => {
      assert.equal(url, pbw);
      return new Response('real package');
    },
  );
  await assert.rejects(
    storePreview(
      result.target,
      new AbortController().signal,
      () => {},
      async () => new Response('changed'),
    ),
    /checksum/,
  );
  assert.equal(calls.length, 2);
  assert.equal(storeAppId(`https://apps.repebble.com/justthetime_${id}`), id);
  assert.throws(() => storeAppId(`https://evil.example/${id}`));
  assert.throws(() =>
    parsePreviewLink(
      `#/store/${id}?pbw=https://evil.example/file.pbw&version=1&sha256=${'a'.repeat(64)}`,
    ),
  );
});

test('store catalog respects selected watch and reports unusable entries without executing metadata', async () => {
  const page = await storePage(
    'qemu_emery',
    'all',
    20,
    new AbortController().signal,
    async (url) => {
      assert.match(url, /hardware=emery&limit=20&offset=20/);
      return Response.json({
        data: [app, { ...app, id: 'bad' }, { ...app, hardware_platforms: [{ name: 'chalk' }] }],
        links: { nextPage: '/ignored' },
      });
    },
  );
  assert.equal(page.apps.length, 1);
  assert.equal(page.unavailable, 1);
  assert.equal(page.incompatible, 1);
  assert.equal(page.count, 3, 'pagination advances over unsupported upstream entries too');
  assert.equal(page.more, true);
});
test('store download validation accepts the current, rebuilt and archived store layouts', () => {
  for (const path of [
    `/api/assets/apps/${id}/releases/3.8-rbl1.pbw`,
    `/api/assets/pbw/539d23e7138d66c704000077.pbw`,
  ]) {
    const url = 'https://appstore-api.repebble.com' + path;
    assert.equal(storePackageUrl(url, id), url);
    assert.equal(isPublicResource(url), true);
  }
  assert.throws(() =>
    storePackageUrl(
      `https://appstore-api.repebble.com/api/assets/apps/${'a'.repeat(24)}/releases/3.pbw`,
      id,
    ),
  );
});

test('a pinned GitHub release verifies bytes without depending on the catalog', async () => {
  const bytes = new TextEncoder().encode('package fixture'),
    sha256 = await bytesHash(bytes);
  const target = parsePreviewLink(
    `#/github/example/clock?release=v1&asset=clock.pbw&sha256=${sha256}`,
  );
  const result = await repositoryPreview(
    target,
    new AbortController().signal,
    () => {},
    async (url) => {
      assert.equal(url, 'https://github.com/example/clock/releases/download/v1/clock.pbw');
      return new Response(bytes);
    },
  );
  assert.deepEqual(result.package.bytes, bytes);
  await assert.rejects(
    repositoryPreview(
      target,
      new AbortController().signal,
      () => {},
      async () => new Response('changed'),
    ),
    /checksum/,
  );
});

test('store apps use their own category and untrusted titles remain plain text', async () => {
  const page = await storePage(
    'qemu_emery',
    'all',
    0,
    new AbortController().signal,
    async (url) => {
      assert.match(url, /\/watchapps-and-companions\?/);
      return Response.json({ data: [app] });
    },
    'watchapps-and-companions',
  );
  assert.equal(page.apps[0].id, id);
  const target = {
    kind: 'store',
    profile: 'qemu_emery',
    appId: id,
    pbw,
    version: '1.2',
    sha256: 'a'.repeat(64),
    title: '<img src=x onerror=alert(1)>',
  };
  assert.deepEqual(
    parsePreviewLink(new URL(previewLink('https://example.test/', target)).hash),
    target,
  );
  assert.throws(() => parsePreviewLink(`#/github/example/clock?title=Hello`));
});
