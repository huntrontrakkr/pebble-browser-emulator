// Compare the deployed site with the exact tested artifact, without executing remote code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.env.PEBBLE_HOSTED_URL);
assert.ok(['http:', 'https:'].includes(base.protocol), 'Expected an HTTP(S) site URL');
assert.ok(base.pathname.endsWith('/'), 'Site URL must include a trailing slash');
assert.ok(!base.search && !base.hash, 'Site URL must not include a query or fragment');
const worker = await readFile('dist/client/sw.js');
const inventory = JSON.parse(worker.toString().match(/^const ASSETS = (.+);$/m)?.[1] ?? 'null');
assert.ok(Array.isArray(inventory) && inventory.length > 0, 'Missing local PWA inventory');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assets = [{ path: 'sw.js', bytes: worker.length, sha256: digest(worker) }, ...inventory];
let checked = 0;
let totalBytes = 0;
async function verify(asset) {
  const url = new URL(asset.path, base);
  assert.ok(
    url.origin === base.origin && url.pathname.startsWith(base.pathname),
    `Asset outside site scope: ${asset.path}`,
  );
  // A successful publication can take a little time to reach every CDN location.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        cache: 'no-cache',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 200, `${asset.path}: HTTP ${response.status}`);
      const type = response.headers.get('content-type')?.split(';')[0].trim();
      if (asset.path.endsWith('.wasm'))
        assert.equal(type, 'application/wasm', `${asset.path}: WebAssembly MIME type`);
      if (/\.(m?js)$/.test(asset.path))
        assert.ok(
          ['text/javascript', 'application/javascript'].includes(type),
          `${asset.path}: JavaScript MIME type (${type})`,
        );
      if (asset.path.endsWith('.html'))
        assert.equal(type, 'text/html', `${asset.path}: HTML MIME type`);
      if (asset.path === 'sw.js')
        assert.ok(
          !/\bimmutable\b/i.test(response.headers.get('cache-control') ?? ''),
          'The service worker must remain updateable',
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.length, asset.bytes, `${asset.path}: published size differs`);
      assert.equal(digest(bytes), asset.sha256, `${asset.path}: published SHA-256 differs`);
      checked++;
      totalBytes += bytes.length;
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      console.log(`Retrying ${asset.path}: ${error.message}`);
      await delay(5000 * (attempt + 1));
    }
  }
}
// Keep download concurrency bounded, including for the larger compiler and phone modules.
for (let offset = 0; offset < assets.length; offset += 4)
  await Promise.all(assets.slice(offset, offset + 4).map(verify));
console.log(`Verified ${checked} published files (${totalBytes} bytes) at ${base.href}`);
