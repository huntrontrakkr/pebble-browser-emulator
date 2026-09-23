// The optional app relay (services/resources, /v1/app-fetch) from a real browser page.
// Starts its own page server and a keyed relay for that page's origin, then makes the
// relayed request as the phone's network does (phone-network.ts: the key header, CORS,
// no credentials). The relay's answer must reach the page, whatever the target said:
// the key header makes browsers preflight, and a preflight answer that does not allow
// it blocks every relayed request before it is sent. No outside service is needed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const freePort = () =>
  new Promise((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const page = createServer((_, response) =>
  response.writeHead(200, { 'content-type': 'text/html' }).end('<title>relay</title>'),
);
await new Promise((ready) => page.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${page.address().port}`;
const key = randomBytes(24).toString('hex');
const relayPort = await freePort();
const endpoint = `http://127.0.0.1:${relayPort}`;
const relay = spawn(process.execPath, ['services/resources/server.mjs'], {
  env: {
    ...process.env,
    RESOURCE_PORT: String(relayPort),
    RESOURCE_RELAY_KEY: key,
    RESOURCE_ALLOWED_ORIGINS: origin,
    RESOURCE_CACHE_DIR: 'tmp/app-relay-browser-cache',
  },
  stdio: 'ignore',
});
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
try {
  for (let tries = 0; ; tries++) {
    try {
      const status = await (await fetch(`${endpoint}/v1/status`)).json();
      assert.ok(status.capabilities.includes('app-relay'), 'the relay is enabled');
      break;
    } catch (error) {
      if (tries > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const tab = await browser.newPage();
  await tab.goto(origin);
  const ask = (withKey) =>
    tab.evaluate(
      async ({ endpoint, key }) => {
        try {
          const target = new URL(`${endpoint}/v1/app-fetch`);
          target.searchParams.set('url', 'https://example.com/');
          const response = await fetch(target, {
            method: 'GET',
            headers: { 'X-Pebble-Relay-Key': key },
            mode: 'cors',
            credentials: 'omit',
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
          });
          return { status: response.status };
        } catch (error) {
          return { threw: String(error) };
        }
      },
      { endpoint, key: withKey },
    );
  const relayed = await ask(key);
  assert.equal(
    relayed.threw,
    undefined,
    `the page must receive the relay's answer: ${relayed.threw}`,
  );
  const refused = await ask('not-the-key-not-the-key');
  assert.equal(refused.status, 401, 'a wrong key is refused, and the page can read that');
  console.log(`relay reached from the page: status ${relayed.status}; wrong key 401`);
} finally {
  await browser.close();
  relay.kill();
  page.close();
}
