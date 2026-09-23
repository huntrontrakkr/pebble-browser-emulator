import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneCorsNetwork } from '../src/app/phone-network.ts';

const RELAY = { endpoint: 'https://svc.example', key: 'k'.repeat(24) };
const CORS_FAILURE = new TypeError('Failed to fetch');

/** Collects the one result the network delivers for a request. */
function harness(fetcher, options = {}) {
  const results = [];
  const net = new PhoneCorsNetwork((id, result) => results.push({ id, result }), options, fetcher);
  return { net, results };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  type: 'basic',
  url: 'https://api.example/forecast',
  redirected: false,
  headers: new Headers({ 'content-type': 'application/json' }),
  clone() {
    return this;
  },
  json: async () => JSON.parse(body),
  body: {
    getReader() {
      let sent = false;
      return {
        async read() {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: new TextEncoder().encode(body) };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  },
});

test('a request the browser refuses is retried through the relay', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init?.headers });
    if (url.startsWith('https://api.example')) throw CORS_FAILURE;
    return ok('{"temperature":17}');
  };
  const { net, results } = harness(fetcher, { relay: RELAY });
  net.handle({
    type: 'network-request',
    request: { id: 1, method: 'GET', url: 'https://api.example/forecast', headers: {} },
  });
  await settle();

  assert.equal(seen.length, 2, 'the direct attempt comes first');
  assert.equal(
    seen[1].url,
    'https://svc.example/v1/app-fetch?url=https%3A%2F%2Fapi.example%2Fforecast',
  );
  assert.equal(seen[1].headers['X-Pebble-Relay-Key'], RELAY.key);
  assert.equal(results.length, 1);
  assert.equal(results[0].result.status, 200);
  assert.equal(results[0].result.body, '{"temperature":17}');
});

test('a request the browser can make itself never reaches the relay', async () => {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    return ok('{"temperature":17}');
  };
  const { net, results } = harness(fetcher, { relay: RELAY });
  net.handle({
    type: 'network-request',
    request: { id: 1, method: 'GET', url: 'https://api.example/forecast', headers: {} },
  });
  await settle();
  assert.deepEqual(seen, ['https://api.example/forecast']);
  assert.equal(results[0].result.status, 200);
});

test('without a relay the refusal is reported as before', async () => {
  const fetcher = async () => {
    throw CORS_FAILURE;
  };
  const { net, results } = harness(fetcher, {});
  net.handle({
    type: 'network-request',
    request: { id: 1, method: 'GET', url: 'https://api.example/forecast', headers: {} },
  });
  await settle();
  assert.equal(results[0].result.error, 'network');
  assert.match(results[0].result.message, /CORS/);
});

test('only plain GET and HEAD over HTTPS are relayed', async () => {
  for (const request of [
    { id: 1, method: 'POST', url: 'https://api.example/x', headers: {}, body: '{}' },
    { id: 2, method: 'GET', url: 'https://api.example/x', headers: {}, body: 'x' },
    { id: 3, method: 'PUT', url: 'https://api.example/x', headers: {} },
    { id: 4, method: 'GET', url: 'http://api.example/x', headers: {} },
  ]) {
    const seen = [];
    const fetcher = async (url) => {
      seen.push(url);
      throw CORS_FAILURE;
    };
    const { net, results } = harness(fetcher, { relay: RELAY });
    net.handle({ type: 'network-request', request });
    await settle();
    assert.equal(seen.length, 1, `${request.method} ${request.url} must not be relayed`);
    assert.equal(results[0].result.error, 'network');
  }
});

test('a relay that cannot reach the host reports why, not an empty success', async () => {
  const fetcher = async (url) => {
    if (url.startsWith('https://api.example')) throw CORS_FAILURE;
    return {
      ...ok('{"error":"api.example resolves only to a non-public address."}', 502),
      status: 502,
      ok: false,
    };
  };
  const { net, results } = harness(fetcher, { relay: RELAY });
  net.handle({
    type: 'network-request',
    request: { id: 1, method: 'GET', url: 'https://api.example/forecast', headers: {} },
  });
  await settle();
  assert.equal(results[0].result.error, 'network');
  assert.match(results[0].result.message, /non-public address/);
});

test('a rejected relay key is reported as the service refusing, not as the host failing', async () => {
  for (const status of [401, 404]) {
    const fetcher = async (url) => {
      if (url.startsWith('https://api.example')) throw CORS_FAILURE;
      return { ...ok('{}', status), status, ok: false };
    };
    const { net, results } = harness(fetcher, { relay: RELAY });
    net.handle({
      type: 'network-request',
      request: { id: 1, method: 'GET', url: 'https://api.example/forecast', headers: {} },
    });
    await settle();
    assert.match(results[0].result.message, /not relaying app requests/, `status ${status}`);
  }
});

test("a target's own 404 or 502 through the relay reaches the app as that response", async () => {
  // The relay marks answers from the target with X-Relay-Status; its own refusals lack it.
  for (const status of [404, 502]) {
    const fetcher = async (url) => {
      if (url.startsWith('https://api.example')) throw CORS_FAILURE;
      const response = { ...ok('{"message":"no such user"}', status), status, ok: false };
      response.headers = new Headers({
        'content-type': 'application/json',
        'x-relay-status': String(status),
      });
      return response;
    };
    const { net, results } = harness(fetcher, { relay: RELAY });
    net.handle({
      type: 'network-request',
      request: { id: 1, method: 'GET', url: 'https://api.example/friends', headers: {} },
    });
    await settle();
    assert.equal(results[0].result.status, status, `status ${status}`);
    assert.equal(results[0].result.body, '{"message":"no such user"}');
  }
});
