// Serves the browser run (bundle.mjs) and opens it in Chromium, printing the page's
// and workers' console and the outcome. Usage: node run.mjs <out> [seconds]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2]);
const seconds = Number(process.argv[3] ?? 300);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};
const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
  try {
    const body = await readFile(join(root, path));
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const url = `http://127.0.0.1:${server.address().port}/harness.html`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
page.on('console', (message) => console.log(`[console] ${message.text()}`.slice(0, 600)));
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
page.on('worker', (worker) => console.log(`[worker] ${worker.url()}`));
await page.goto(url);
let result;
try {
  await page.waitForFunction(() => window.__result, null, { timeout: seconds * 1000 });
  result = await page.evaluate(() => window.__result);
} catch (error) {
  result = {
    ok: false,
    error: `no result: ${error.message}`,
    steps: await page.evaluate(() => document.getElementById('status')?.textContent),
  };
}
console.log('RESULT', JSON.stringify(result, null, 2));
await browser.close();
server.close();
process.exit(result.ok ? 0 : 1);
