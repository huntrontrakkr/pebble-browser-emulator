import test from 'node:test';
import assert from 'node:assert/strict';
import { libPebbleNetworkHost } from '../src/app/libpebble-network.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = (host, value) =>
  new Promise((resolve) =>
    host.request(JSON.stringify(value), (json) => resolve(JSON.parse(json))),
  );

test('requests are refused unless the session allows the network', async () => {
  let fetched = 0;
  const fetcher = async () => (fetched++, new Response('no'));
  const off = libPebbleNetworkHost({ mode: 'disabled' }, { fetcher });
  const get = { method: 'GET', url: 'https://example.test/', headers: {}, body: null };
  assert.deepEqual(await request(off, get), {
    error: 'disabled',
    message: 'Phone network access is off in this session.',
  });
  const fixtures = libPebbleNetworkHost({ mode: 'fixtures' }, { fetcher });
  assert.match((await request(fixtures, get)).message, /built-in phone/);
  assert.equal(fetched, 0);
});

test('responses come back as the exact bytes, status and headers', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      credentials: init.credentials,
    });
    return new Response(Uint8Array.of(0xe2, 0x82, 0xac, 0xff), {
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Test': 'yes' },
    });
  };
  const host = libPebbleNetworkHost({ mode: 'cors' }, { fetcher });
  const result = await request(host, {
    method: 'post',
    url: 'https://example.test/echo',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  });
  assert.equal(result.status, 201);
  assert.equal(result.statusText, 'Created');
  assert.equal(result.headers['x-test'], 'yes');
  assert.deepEqual([...Buffer.from(result.bodyBase64, 'base64')], [0xe2, 0x82, 0xac, 0xff]);
  assert.deepEqual(seen, [
    {
      url: 'https://example.test/echo',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      credentials: 'omit',
    },
  ]);
});

test('failures, cancellation and a changed setting each settle a request once', async () => {
  const refused = libPebbleNetworkHost(
    { mode: 'cors' },
    { fetcher: async () => Promise.reject(new TypeError('Failed to fetch')) },
  );
  const failure = await request(refused, {
    method: 'GET',
    url: 'https://x.test/',
    headers: {},
    body: null,
  });
  assert.equal(failure.error, 'network');
  assert.match(failure.message, /Failed to fetch/);

  const hanging = libPebbleNetworkHost({ mode: 'cors' }, { fetcher: () => new Promise(() => {}) });
  const outcomes = [];
  const id = hanging.request(
    JSON.stringify({ method: 'GET', url: 'https://x.test/', headers: {}, body: null }),
    (json) => outcomes.push(JSON.parse(json).error),
  );
  hanging.cancel(id);
  hanging.cancel(id);
  hanging.request(
    JSON.stringify({ method: 'GET', url: 'https://x.test/', headers: {}, body: null }),
    (json) => outcomes.push(JSON.parse(json).error),
  );
  hanging.configure({ mode: 'disabled' });
  await settle();
  assert.deepEqual(outcomes, ['abort', 'abort']);
});

class FakeSocket {
  static last;
  readyState = 0;
  protocol = '';
  extensions = '';
  bufferedAmount = 0;
  sent = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.last = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = [code, reason];
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
  }
  open(protocol) {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.();
  }
}

test('WebSockets carry text and bytes both ways and close once', async () => {
  const host = libPebbleNetworkHost(
    { mode: 'cors' },
    { socketFactory: (url, protocols) => new FakeSocket(url, protocols) },
  );
  const events = [];
  const id = host.openSocket('wss://echo.test/socket', 'chat, v2', (json) =>
    events.push(JSON.parse(json)),
  );
  assert.equal(FakeSocket.last, undefined, 'the socket opens after the constructor returns');
  await settle();
  const socket = FakeSocket.last;
  assert.equal(socket.url, 'wss://echo.test/socket');
  assert.deepEqual(socket.protocols, ['chat', 'v2']);
  socket.open('chat');
  host.sendSocket(id, 'hello', false);
  host.sendSocket(id, Buffer.from([1, 2, 255]).toString('base64'), true);
  assert.equal(socket.sent[0], 'hello');
  assert.deepEqual([...socket.sent[1]], [1, 2, 255]);
  socket.onmessage({ data: 'hi' });
  socket.onmessage({ data: Uint8Array.of(9, 8).buffer });
  host.closeSocket(id, 1000, 'done');
  assert.deepEqual(socket.closed, [1000, 'done']);
  assert.deepEqual(events, [
    { type: 'open', protocol: 'chat' },
    { type: 'message', text: 'hi' },
    { type: 'message', base64: 'CQg=' },
    { type: 'close', code: 1000, reason: 'done', wasClean: true },
  ]);
});

test('a refused WebSocket reports an error, then a close', async () => {
  const host = libPebbleNetworkHost({ mode: 'disabled' });
  const events = [];
  host.openSocket('wss://echo.test/', '', (json) => events.push(JSON.parse(json)));
  await settle();
  assert.deepEqual(events, [
    { type: 'error', message: 'Phone network access is off in this session.' },
    { type: 'close', code: 1006, reason: '', wasClean: false },
  ]);
});

class FakeSyncRequest {
  static fail = false;
  static made = [];
  headers = {};
  constructor() {
    FakeSyncRequest.made.push(this);
  }
  open(method, url, async) {
    Object.assign(this, { method, url, async });
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    if (FakeSyncRequest.fail) throw new Error('NetworkError: Failed to execute send');
    this.body = body;
    this.status = 200;
    this.statusText = 'OK';
    this.response = Uint8Array.of(104, 105).buffer;
  }
  getAllResponseHeaders() {
    return 'content-type: text/plain\r\nset-cookie: a=b\r\nx-probe-server: yes\r\n';
  }
}

test('synchronous requests block on the browser request and follow the same rules', () => {
  const get = JSON.stringify({
    method: 'get',
    url: 'https://sync.test/a',
    headers: { 'X-A': '1' },
    body: null,
  });
  const host = libPebbleNetworkHost({ mode: 'cors' }, { syncRequest: () => new FakeSyncRequest() });
  assert.deepEqual(JSON.parse(host.requestSync(get)), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/plain', 'x-probe-server': 'yes' },
    bodyBase64: 'aGk=',
  });
  const made = FakeSyncRequest.made.at(-1);
  assert.deepEqual(
    [made.method, made.url, made.async, made.headers, made.responseType, made.timeout],
    ['GET', 'https://sync.test/a', false, { 'X-A': '1' }, 'arraybuffer', 30000],
  );

  FakeSyncRequest.fail = true;
  const refused = JSON.parse(host.requestSync(get));
  FakeSyncRequest.fail = false;
  assert.equal(refused.error, 'network');
  assert.match(refused.message, /Failed to execute send/);

  const off = libPebbleNetworkHost(
    { mode: 'disabled' },
    { syncRequest: () => new FakeSyncRequest() },
  );
  assert.equal(JSON.parse(off.requestSync(get)).error, 'disabled');
  const nowhere = libPebbleNetworkHost({ mode: 'cors' });
  assert.match(JSON.parse(nowhere.requestSync(get)).message, /need the phone worker/);
  assert.match(
    JSON.parse(
      host.requestSync(
        JSON.stringify({ method: 'GET', url: 'file:///etc/passwd', headers: {}, body: null }),
      ),
    ).message,
    /Only HTTP/,
  );
});

test('binary request bodies reach the browser as bytes, on both paths', async () => {
  const seen = [];
  const fetcher = async (url, init) => (seen.push(init.body), new Response('ok'));
  const host = libPebbleNetworkHost(
    { mode: 'cors' },
    { fetcher, syncRequest: () => new FakeSyncRequest() },
  );
  const binary = {
    method: 'PUT',
    url: 'https://bytes.test/',
    headers: {},
    body: null,
    bodyBase64: Buffer.from([0, 255, 128]).toString('base64'),
  };
  assert.equal((await request(host, binary)).status, 200);
  assert.ok(seen[0] instanceof Uint8Array);
  assert.deepEqual([...seen[0]], [0, 255, 128]);
  host.requestSync(JSON.stringify(binary));
  assert.deepEqual([...FakeSyncRequest.made.at(-1).body], [0, 255, 128]);
});

test('a binary body counts toward the request size limit', async () => {
  const host = libPebbleNetworkHost(
    { mode: 'cors' },
    { fetcher: async () => new Response('ok'), requestLimits: { requestBytes: 1024 } },
  );
  const result = await request(host, {
    method: 'POST',
    url: 'https://bytes.test/',
    headers: {},
    body: null,
    bodyBase64: Buffer.alloc(4096).toString('base64'),
  });
  assert.equal(result.error, 'network');
  assert.match(result.message, /size limit/);
});

test('activity reports each request without its query string', async () => {
  const activity = [];
  const host = libPebbleNetworkHost(
    { mode: 'cors' },
    {
      fetcher: async () => new Response('four', { status: 200 }),
      onActivity: (entry) => activity.push(entry),
    },
  );
  await request(host, {
    method: 'get',
    url: 'https://api.weather.test/v1/now?lat=1&appid=SECRET#x',
    headers: {},
    body: null,
  });
  const off = libPebbleNetworkHost(
    { mode: 'disabled' },
    { onActivity: (entry) => activity.push(entry) },
  );
  await request(off, {
    method: 'GET',
    url: 'https://api.weather.test/v1/now',
    headers: {},
    body: null,
  });
  assert.deepEqual(activity, [
    {
      kind: 'request',
      method: 'GET',
      target: 'https://api.weather.test/v1/now',
      synchronous: false,
      status: 200,
      bytes: 4,
    },
    {
      kind: 'request',
      method: 'GET',
      target: 'https://api.weather.test/v1/now',
      synchronous: false,
      error: 'disabled: Phone network access is off in this session.',
    },
  ]);
  assert.ok(!JSON.stringify(activity).includes('SECRET'));
});

test('a host the browser refuses is relayed when the session has a relay, and marked so', async () => {
  const relay = { endpoint: 'https://relay.test', key: 'k'.repeat(32) };
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, key: init.headers['X-Pebble-Relay-Key'] });
    if (!url.startsWith(relay.endpoint)) throw new TypeError('Failed to fetch');
    const response = new Response('{"temp":20}', { status: 200 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const activity = [];
  const host = libPebbleNetworkHost(
    { mode: 'cors', relay },
    { fetcher, onActivity: (entry) => activity.push(entry) },
  );
  const result = await request(host, {
    method: 'GET',
    url: 'https://no-cors.test/forecast?key=SECRET',
    headers: {},
    body: null,
  });
  assert.equal(result.status, 200);
  assert.equal(
    seen[1].url,
    'https://relay.test/v1/app-fetch?url=https%3A%2F%2Fno-cors.test%2Fforecast%3Fkey%3DSECRET',
  );
  assert.equal(seen[1].key, relay.key);
  assert.deepEqual(activity, [
    {
      kind: 'request',
      method: 'GET',
      target: 'https://no-cors.test/forecast',
      synchronous: false,
      status: 200,
      relayed: true,
      bytes: 11,
    },
  ]);
});
