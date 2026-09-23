// Opens the built application (with public/libpebble3 published into it) in Chromium and
// checks that Preview's Phone tab found the upstream phone and names its build.
// Usage: node preview-check.mjs <built site, e.g. dist/client>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2]);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};
const server = createServer(async (request, response) => {
  let path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(join(root, path));
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
// The developer tools load when first opened; the upstream phone is on their Phone tab.
await page.getByRole('button', { name: 'Developer tools' }).click();
await page.locator('nav.tabs button', { hasText: 'Phone' }).click();
const section = page.locator('section.upstream-phone');
let result;
try {
  await section.waitFor({ state: 'attached', timeout: 60000 });
  await page.waitForFunction(
    () => {
      const status = document.querySelector('section.upstream-phone [role=status]');
      return status && status.textContent.trim() !== 'Checking this build…';
    },
    null,
    { timeout: 30000 },
  );
  result = {
    status: (await section.locator('[role=status]').textContent()).trim(),
    build: (await section.locator('dd').first().textContent()).trim(),
  };
} catch (error) {
  result = { error: error.message };
}
console.log('PREVIEW', JSON.stringify(result));
await browser.close();
server.close();
process.exit(
  result.status === 'Not connected' && /coredevices\/mobileapp/.test(result.build) ? 0 : 1,
);
