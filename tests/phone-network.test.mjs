import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../src/app/virtual-phone.ts';
import { PhoneCorsNetwork } from '../src/app/phone-network.ts';
import { withTestLimits } from './phone-limits.mjs';
const module = await getQuickJS();
const make = (options = {}) =>
  new VirtualPhone(module, { appId: 'weather-test', nowMs: 1000, ...withTestLimits(options) });
const logs = (vm) =>
  vm
    .drainEvents()
    .filter((e) => e.type === 'log')
    .map((e) => e.text);
const fixtures = (values) => ({ mode: 'fixtures', fixtures: values });
const weather = 'https://weather.example/forecast';

test('XHR weather request has async states, headers and JSON, at deterministic virtual time', () => {
  const vm = make({
    network: fixtures([
      {
        url: weather,
        response: {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{"temperature":23}',
        },
        delayMs: 50,
      },
    ]),
  });
  try {
    vm.start(
      `var xhr=new XMLHttpRequest();xhr.onreadystatechange=function(){console.log('state',xhr.readyState)};xhr.onload=function(){console.log('loaded',this.status,JSON.parse(this.responseText).temperature,this.getResponseHeader('CONTENT-TYPE'),Date.now());};xhr.onloadend=()=>console.log('end');xhr.open('GET','${weather}',true);xhr.send();console.log('returned');`,
    );
    const start = vm.drainEvents();
    assert.deepEqual(
      start.filter((e) => e.type === 'log').map((e) => e.text),
      ['state 1', 'returned'],
    );
    assert.equal(start.find((e) => e.type === 'network-request').request.method, 'GET');
    vm.advanceTime(1049);
    assert.deepEqual(logs(vm), []);
    vm.advanceTime(1050);
    assert.deepEqual(logs(vm), [
      'state 2',
      'state 3',
      'state 4',
      'loaded 200 23 application/json 1050',
      'end',
    ]);
  } finally {
    vm.dispose();
  }
});

test('fetch supports POST text, response headers, HTTP failures and one-shot body consumption', () => {
  const vm = make({
    network: fixtures([
      {
        url: weather,
        method: 'POST',
        body: 'units=C',
        response: {
          status: 503,
          statusText: 'Unavailable',
          headers: { 'x-test': 'ok' },
          body: '{"retry":true}',
        },
      },
    ]),
  });
  try {
    vm.start(
      `fetch('${weather}',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'units=C'}).then(async r=>{console.log(r.status,r.ok,r.headers.get('X-Test'));var c=r.clone();console.log((await r.json()).retry,await c.text());try{await r.text()}catch(e){console.log(e.name)}});`,
    );
    const events = vm.drainEvents();
    assert.equal(events.find((e) => e.type === 'network-request').request.body, 'units=C');
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      ['503 false ok', 'true {"retry":true}', 'TypeError'],
    );
  } finally {
    vm.dispose();
  }
});

test('unmatched fixtures and disabled networking reject without fake success or host access', () => {
  for (const network of [undefined, fixtures([])]) {
    const vm = make({ network });
    try {
      vm.start(
        `fetch('${weather}').then(()=>console.log('BAD'),e=>console.log(e.name));var xhr=new XMLHttpRequest();xhr.onerror=()=>console.log('error',xhr.status);xhr.onload=()=>console.log('BAD');xhr.open('GET','${weather}');xhr.send();console.log(typeof process,typeof document,typeof __phoneEmit);`,
      );
      assert.deepEqual(logs(vm), ['undefined undefined undefined', 'TypeError', 'error 0']);
    } finally {
      vm.dispose();
    }
  }
});

test('XHR timeout and abort cancel pending requests and ignore late replies', () => {
  const vm = make({ network: { mode: 'cors' } });
  try {
    vm.start(
      `var a=new XMLHttpRequest();a.timeout=10;a.ontimeout=()=>console.log('timeout',a.readyState,a.status);a.onload=()=>console.log('BAD');a.open('GET','${weather}');a.send();var b=new XMLHttpRequest();b.onabort=()=>console.log('abort',b.readyState,b.status);b.open('GET','${weather}');b.send();b.abort();console.log('after',b.readyState);`,
    );
    const events = vm.drainEvents(),
      requests = events.filter((e) => e.type === 'network-request');
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      ['abort 4 0', 'after 0'],
    );
    assert.equal(
      vm.deliverNetworkResponse(requests[1].request.id, {
        status: 200,
        body: 'late',
      }),
      false,
    );
    vm.advanceTime(1010);
    const ended = vm.drainEvents();
    assert.deepEqual(
      ended.filter((e) => e.type === 'log').map((e) => e.text),
      ['timeout 4 0'],
    );
    assert.equal(ended.filter((e) => e.type === 'network-cancel').length, 1);
    assert.equal(
      vm.deliverNetworkResponse(requests[0].request.id, {
        status: 200,
        body: 'late',
      }),
      false,
    );
  } finally {
    vm.dispose();
  }
});

test('AbortController rejects fetch with the supplied reason and emits cancellation once', () => {
  const vm = make({ network: { mode: 'cors' } });
  try {
    vm.start(
      `var c=new AbortController();fetch('${weather}',{signal:c.signal}).catch(e=>console.log(e.name));c.abort();c.abort();fetch('${weather}',{signal:c.signal}).catch(e=>console.log(e.name));`,
    );
    const events = vm.drainEvents();
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      ['AbortError', 'AbortError'],
    );
    assert.equal(events.filter((e) => e.type === 'network-request').length, 1);
    assert.equal(events.filter((e) => e.type === 'network-cancel').length, 1);
  } finally {
    vm.dispose();
  }
});

test('network limits bound pending, request/response data and timeout; HTTP 404 is still XHR load', () => {
  const vm = make({
    network: { mode: 'cors' },
    limits: {
      pendingNetworkRequests: 1,
      networkRequestBytes: 200,
      networkResponseBytes: 20,
      networkTimeoutMs: 20,
    },
  });
  try {
    vm.start(
      `fetch('${weather}').then(r=>r.text()).then(console.log,e=>console.log(e.name));fetch('${weather}').catch(e=>console.log('pending',e.message));fetch('${weather}',{method:'POST',body:'x'.repeat(201)}).catch(e=>console.log('size',e.name));`,
    );
    const events = vm.drainEvents(),
      request = events.find((e) => e.type === 'network-request').request;
    assert.equal(request.timeoutMs, 20);
    assert.equal(
      vm.deliverNetworkResponse(request.id, {
        status: 200,
        body: 'x'.repeat(21),
      }),
      true,
    );
    assert.deepEqual(logs(vm), ['TypeError']);
  } finally {
    vm.dispose();
  }
  const http = make({
    network: fixtures([{ url: weather, response: { status: 404, body: 'missing' } }]),
  });
  try {
    http.start(
      `var x=new XMLHttpRequest();x.open('GET','${weather}');x.onload=()=>console.log(x.status,x.responseText);x.onerror=()=>console.log('BAD');x.send();`,
    );
    assert.deepEqual(logs(http), ['404 missing']);
  } finally {
    http.dispose();
  }
});

test('XHR JSON invalid response becomes null; synchronous and credentialed operations fail explicitly', () => {
  const vm = make({
    network: fixtures([{ url: weather, response: { status: 200, body: 'invalid json' } }]),
  });
  try {
    vm.start(
      `var x=new XMLHttpRequest();x.open('GET','${weather}');x.responseType='json';x.onload=()=>console.log(x.response===null);x.send();for(var f of [()=>new XMLHttpRequest().open('GET','${weather}',false),()=>{var q=new XMLHttpRequest();q.responseType='arraybuffer';},()=>{var q=new XMLHttpRequest();q.open('GET','${weather}');q.withCredentials=true;q.send();}])try{f()}catch(e){console.log('unsupported')}`,
    );
    assert.deepEqual(logs(vm), ['unsupported', 'unsupported', 'true']);
  } finally {
    vm.dispose();
  }
});

test('binary XHR fixtures preserve exact bytes, Blob MIME and responseText restrictions', () => {
  const bodyBase64 = Buffer.from([0, 255, 128, 10]).toString('base64');
  const vm = make({
    network: fixtures([
      {
        url: weather,
        response: { status: 200, headers: { 'Content-Type': 'image/png' }, bodyBase64 },
      },
    ]),
  });
  try {
    vm.start(
      `for(const type of ['arraybuffer','blob']){const x=new XMLHttpRequest();x.open('GET','${weather}');x.responseType=type;x.onload=()=>{console.log(type,x.status,x.response instanceof ArrayBuffer?Array.from(new Uint8Array(x.response)).join(','):x.response.size+':'+x.response.type);try{x.responseText}catch(e){console.log(e.message)}};x.send();}`,
    );
    const events = vm.drainEvents();
    assert.deepEqual(
      events.filter((e) => e.type === 'network-request').map((e) => e.request.responseType),
      ['arraybuffer', 'blob'],
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      [
        'arraybuffer 200 0,255,128,10',
        'responseText is unavailable for this response type.',
        'blob 200 4:image/png',
        'responseText is unavailable for this response type.',
      ],
    );
  } finally {
    vm.dispose();
  }
});

test('browser CORS adapter streams binary bytes without text replacement and enforces limits', async () => {
  const bytes = Uint8Array.from([0, 255, 128, 10]);
  const vm = make({ network: { mode: 'cors' } });
  const host = new PhoneCorsNetwork(
    (id, result) => vm.deliverNetworkResponse(id, result),
    {},
    async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  );
  try {
    vm.start(
      `var x=new XMLHttpRequest();x.open('GET','${weather}');x.responseType='arraybuffer';x.onload=()=>console.log(Array.from(new Uint8Array(x.response)).join(','));x.send();`,
    );
    for (const event of vm.drainEvents()) host.handle(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(logs(vm), ['0,255,128,10']);
  } finally {
    host.dispose();
    vm.dispose();
  }
  const limited = make({
    network: fixtures([
      {
        url: weather,
        response: { status: 200, bodyBase64: Buffer.alloc(256 * 1024 + 1).toString('base64') },
      },
    ]),
  });
  try {
    limited.start(
      `var x=new XMLHttpRequest();x.open('GET','${weather}');x.responseType='arraybuffer';x.onerror=()=>console.log('limit');x.send();`,
    );
    assert.deepEqual(logs(limited), ['limit']);
  } finally {
    limited.dispose();
  }
});

test('phone timeline token has an explicit success path and absent-token failure; incoming payload is an ordinary safe object', () => {
  for (const [token, expected] of [
    ['', 'failure'],
    ['test-token', 'success test-token'],
  ]) {
    const vm = make({ timelineToken: token, messageKeys: { KIEZELPAY_STATUS_CHECK: 7 } });
    try {
      vm.start(
        `window.addEventListener('beforeunload',()=>console.log('unload'));Pebble.addEventListener('ready',()=>Pebble.getTimelineToken(t=>console.log('success',t),()=>console.log('failure')));Pebble.addEventListener('appmessage',e=>console.log(e.payload.hasOwnProperty('KIEZELPAY_STATUS_CHECK'),Object.getPrototypeOf(e.payload)===Object.prototype));`,
      );
      vm.injectAppMessage({ 7: 1 });
      assert.deepEqual(logs(vm), [expected, 'true true']);
      vm.dispose();
      assert.deepEqual(logs(vm), ['unload']);
    } finally {
      vm.dispose();
    }
  }
});

test('an app configuration callback error is reported while the phone keeps handling later messages', () => {
  const vm = make();
  try {
    vm.start(
      `Pebble.addEventListener('showConfiguration',()=>Pebble.openURL('https://example.com/settings'));Pebble.addEventListener('webviewclosed',e=>JSON.parse(e.response));Pebble.addEventListener('appmessage',e=>console.log('later',e.payload['7']));`,
    );
    vm.showConfiguration();
    vm.drainEvents();
    assert.equal(vm.closeConfiguration(null), true);
    const errors = vm.drainEvents().filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Unexpected end of JSON input/);
    vm.injectAppMessage({ 7: 3 });
    assert.deepEqual(logs(vm), ['later 3']);
  } finally {
    vm.dispose();
  }
});

test('reopening XHR cancels previous response and never invokes its callback', () => {
  const vm = make({ network: { mode: 'cors' } });
  try {
    vm.start(
      `var x=new XMLHttpRequest();x.onload=()=>console.log(x.responseText);x.open('GET','${weather}');x.send();x.open('GET','${weather}?new');x.send();`,
    );
    const requests = vm.drainEvents().filter((e) => e.type === 'network-request');
    assert.equal(
      vm.deliverNetworkResponse(requests[0].request.id, {
        status: 200,
        body: 'OLD',
      }),
      false,
    );
    assert.equal(
      vm.deliverNetworkResponse(requests[1].request.id, {
        status: 200,
        body: 'NEW',
      }),
      true,
    );
    assert.deepEqual(logs(vm), ['NEW']);
  } finally {
    vm.dispose();
  }
});

test('watch/app context is copied, account/watch tokens are explicit and default identities are empty', () => {
  const watchInfo = {
    platform: 'chalk',
    model: 'pebble_time_round_black_20',
    language: 'en_US',
    firmware: { major: 4, minor: 3, patch: 0, suffix: '' },
  };
  const vm = make({
    watchInfo,
    appInfo: { uuid: 'weather-test', versionLabel: '1.2' },
    watchToken: 'sim-device-app',
    accountToken: 'sim-account',
  });
  try {
    vm.start(
      `var w=Pebble.getActiveWatchInfo();w.platform='CHANGED';var a=Pebble.getAppInfo();a.versionLabel='CHANGED';console.log(Pebble.getActiveWatchInfo().platform,Pebble.getAppInfo().versionLabel,Pebble.getWatchToken(),Pebble.getAccountToken());`,
    );
    assert.deepEqual(logs(vm), ['chalk 1.2 sim-device-app sim-account']);
    assert.equal(watchInfo.platform, 'chalk');
  } finally {
    vm.dispose();
  }
  const empty = make();
  try {
    empty.start(
      `console.log(Pebble.getActiveWatchInfo()===null,Pebble.getWatchToken()==='',Pebble.getAccountToken()==='');`,
    );
    assert.deepEqual(logs(empty), ['true true true']);
  } finally {
    empty.dispose();
  }
});

test('configuration IDs reject stale results, preserve raw encoded payload, and allow bounded Clay data URLs', () => {
  const vm = make();
  try {
    vm.start(
      `Pebble.addEventListener('showConfiguration',()=>Pebble.openURL('data:text/html;charset=utf-8,'+'x'.repeat(20000)));Pebble.addEventListener('webviewclosed',e=>console.log(e.type,e.response));`,
    );
    assert.equal(vm.closeConfiguration('no view'), false);
    vm.showConfiguration();
    const first = vm.drainEvents()[0];
    assert.equal(first.type, 'configuration');
    assert.ok(first.url.length > 20000);
    vm.showConfiguration();
    const second = vm.drainEvents()[0];
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(vm.closeConfiguration('stale', first.requestId), false);
    assert.equal(vm.closeConfiguration('%7B%22x%22%3A1%7D', second.requestId), true);
    assert.equal(vm.closeConfiguration('duplicate', second.requestId), false);
    assert.deepEqual(logs(vm), ['webviewclosed %7B%22x%22%3A1%7D']);
  } finally {
    vm.dispose();
  }
});

const requestEvent = (id = 1, overrides = {}) => ({
  type: 'network-request',
  timestamp: 0,
  request: {
    id,
    url: weather,
    method: 'GET',
    headers: {},
    body: null,
    timeoutMs: 1000,
    ...overrides,
  },
});
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

test('CORS proxy streams bounded text and always omits credentials', async () => {
  const results = [],
    calls = [];
  const proxy = new PhoneCorsNetwork(
    (id, result) => results.push({ id, result }),
    {},
    async (url, options) => {
      calls.push({ url, options });
      return new Response('{"temperature":18}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  try {
    proxy.handle(requestEvent());
    await turn();
    assert.equal(results[0].result.body, '{"temperature":18}');
    assert.equal(calls[0].options.mode, 'cors');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  } finally {
    proxy.dispose();
  }
});

test('CORS proxy fails denied fetch, bounds streaming bodies and rejects local/embedded-credential URLs', async () => {
  const results = [];
  let calls = 0;
  const proxy = new PhoneCorsNetwork(
    (id, result) => results.push({ id, result }),
    { responseBytes: 4 },
    async () => {
      calls++;
      return new Response('12345');
    },
  );
  try {
    proxy.handle(requestEvent(1));
    proxy.handle(requestEvent(2, { url: 'file:///etc/passwd' }));
    proxy.handle(requestEvent(3, { url: 'https://user:password@weather.example/' }));
    await turn();
    assert.equal(calls, 1);
    assert.equal(results.find((r) => r.id === 1).result.error, 'limit');
    assert.equal(results.find((r) => r.id === 2).result.error, 'network');
    assert.equal(results.find((r) => r.id === 3).result.error, 'network');
  } finally {
    proxy.dispose();
  }
  const failed = [];
  const deny = new PhoneCorsNetwork(
    (id, result) => failed.push(result),
    {},
    async () => {
      throw new TypeError('Failed to fetch');
    },
  );
  try {
    deny.handle(requestEvent());
    await turn();
    assert.equal(failed[0].error, 'network');
    assert.match(failed[0].message, /CORS\/network/);
  } finally {
    deny.dispose();
  }
});

test('CORS proxy cancellation/disposal aborts requests and quarantines late completions', async () => {
  const results = [],
    gates = [],
    signals = [];
  const proxy = new PhoneCorsNetwork(
    (id, result) => results.push({ id, result }),
    {},
    (_url, options) => {
      signals.push(options.signal);
      return new Promise((resolve) => gates.push(resolve));
    },
  );
  proxy.handle(requestEvent(1));
  proxy.handle({ type: 'network-cancel', requestId: 1, timestamp: 0 });
  assert.equal(signals[0].aborted, true);
  gates[0](new Response('late'));
  await turn();
  assert.deepEqual(results, []);
  proxy.handle(requestEvent(2));
  proxy.dispose();
  assert.equal(signals[1].aborted, true);
  gates[1](new Response('late'));
  await turn();
  assert.deepEqual(results, []);
});

test('CORS proxy wall timeout aborts a hanging request and replies once', async () => {
  const results = [];
  let signal;
  const proxy = new PhoneCorsNetwork(
    (id, result) => results.push(result),
    { timeoutMs: 10 },
    (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  );
  try {
    proxy.handle(requestEvent());
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signal.aborted, true);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'timeout');
  } finally {
    proxy.dispose();
  }
});

test('XHR abort listener can reopen the same object without losing the new request', () => {
  const vm = make({ network: { mode: 'cors' } });
  try {
    vm.start(
      `var x=new XMLHttpRequest();x.onload=()=>console.log(x.responseText);x.open('GET','${weather}');x.send();x.onabort=()=>{x.open('GET','${weather}?retry');x.send();};x.abort();console.log(x.readyState);`,
    );
    const events = vm.drainEvents(),
      requests = events.filter((e) => e.type === 'network-request');
    assert.equal(requests.length, 2);
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      ['1'],
    );
    assert.equal(
      vm.deliverNetworkResponse(requests[1].request.id, {
        status: 200,
        body: 'retry',
      }),
      true,
    );
    assert.deepEqual(logs(vm), ['retry']);
  } finally {
    vm.dispose();
  }
});

test('legacy PKJS window is only an alias for the isolated QuickJS global', () => {
  const vm = make();
  try {
    vm.start(
      `console.log(window===globalThis, window.fetch===fetch, window.localStorage===localStorage, typeof window.document, typeof window.process, typeof window.__phoneEmit);`,
    );
    assert.deepEqual(logs(vm), ['true true true undefined undefined undefined']);
  } finally {
    vm.dispose();
  }
});
