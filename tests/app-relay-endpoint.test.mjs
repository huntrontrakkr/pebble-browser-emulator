import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceService } from '../services/resources/service.mjs';

const KEY = 'k'.repeat(32);
const ORIGIN = 'https://emulator.example';
const ask = (handler, path, { key, origin = ORIGIN, method = 'GET' } = {}) =>
  handler(
    new Request(`https://service.example${path}`, {
      method,
      headers: { origin, ...(key === undefined ? {} : { 'x-pebble-relay-key': key }) },
    }),
  );

const relayReturning = (body, headers = { 'content-type': 'application/json' }) => {
  const calls = [];
  const relay = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, headers, body: Buffer.from(body), url };
  };
  return { relay, calls };
};

test('the relay stays off unless a deployment supplies a key and a relay', async () => {
  const { relay } = relayReturning('{}');
  for (const options of [
    {},
    { relay },
    { relayKey: KEY },
    { relay, relayKey: 'short' }, // too short to be a credential
  ]) {
    const handler = createResourceService({ origins: [ORIGIN], ...options });
    const response = await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: KEY });
    assert.equal(response.status, 404, `must stay off for ${JSON.stringify(Object.keys(options))}`);
    const status = await (await ask(handler, '/v1/status')).json();
    assert.ok(!status.capabilities.includes('app-relay'), 'must not advertise a relay it lacks');
  }
});

test('an enabled relay advertises itself and requires the key', async () => {
  const { relay, calls } = relayReturning('{"temperature":17}');
  const handler = createResourceService({ origins: [ORIGIN], relay, relayKey: KEY });

  const status = await (await ask(handler, '/v1/status')).json();
  assert.ok(status.capabilities.includes('app-relay'));

  assert.equal((await ask(handler, '/v1/app-fetch?url=https://api.example/x')).status, 401);
  assert.equal(
    (await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: 'wrong' })).status,
    401,
  );
  assert.equal(
    (await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: 'K'.repeat(32) })).status,
    401,
  );
  assert.equal(calls.length, 0, 'no request may reach upstream without the key');

  const ok = await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: KEY });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '{"temperature":17}');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example/x');
  assert.equal(calls[0].options.method, 'GET');
});

test('an origin outside the list is refused before the key is considered', async () => {
  const { relay, calls } = relayReturning('{}');
  const handler = createResourceService({ origins: [ORIGIN], relay, relayKey: KEY });
  const response = await ask(handler, '/v1/app-fetch?url=https://api.example/x', {
    key: KEY,
    origin: 'https://somewhere.else',
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('a refused upstream request is reported, never disguised as a reply', async () => {
  const relay = async () => {
    throw new Error('api.example resolves only to a non-public address.');
  };
  const handler = createResourceService({ origins: [ORIGIN], relay, relayKey: KEY });
  const response = await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: KEY });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /non-public address/);
});

test('the url parameter is required and singular', async () => {
  const { relay } = relayReturning('{}');
  const handler = createResourceService({ origins: [ORIGIN], relay, relayKey: KEY });
  for (const path of [
    '/v1/app-fetch',
    '/v1/app-fetch?url=',
    '/v1/app-fetch?url=https://a.example/&url=https://b.example/',
  ])
    assert.equal((await ask(handler, path, { key: KEY })).status, 400, path);
});

test('relayed calls have their own budget and do not spend the download allowance', async () => {
  const { relay } = relayReturning('{}');
  const handler = createResourceService({
    origins: [ORIGIN],
    relay,
    relayKey: KEY,
    now: () => 0, // frozen clock: nothing refills during the run
  });
  let refusals = 0;
  for (let i = 0; i < 70; i++) {
    const response = await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: KEY });
    if (response.status === 429) refusals++;
  }
  assert.ok(refusals > 0, 'a burst must eventually be refused');
  // The download path keeps its own tokens, so relaying cannot exhaust it.
  const status = await ask(handler, '/v1/status');
  assert.equal(status.status, 200);
});

test('browsers may send the relay key: the preflight allows its header', async () => {
  // The key travels in X-Pebble-Relay-Key, so a page's request is preflighted. Without
  // this header in the answer, browsers refuse every relayed request before it is sent.
  const { relay } = relayReturning('{}');
  const handler = createResourceService({ origins: [ORIGIN], relay, relayKey: KEY });
  const preflight = await ask(handler, '/v1/app-fetch?url=https://api.example/x', {
    method: 'OPTIONS',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-pebble-relay-key/i);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
});

test('a page can read which status came from the target', async () => {
  const { relay } = relayReturning('{"gone":true}');
  const handler = createResourceService({ origins: [ORIGIN], relay, relayKey: KEY });
  const response = await ask(handler, '/v1/app-fetch?url=https://api.example/x', { key: KEY });
  assert.equal(response.headers.get('x-relay-status'), '200');
  assert.match(response.headers.get('access-control-expose-headers') ?? '', /x-relay-status/i);
});
