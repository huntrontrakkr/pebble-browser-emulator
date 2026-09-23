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
