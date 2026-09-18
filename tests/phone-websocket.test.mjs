import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../src/app/virtual-phone.ts';
import { PhoneWebSocketNetwork, normalizeSocketUrl } from '../src/app/phone-websocket.ts';
const module = await getQuickJS();
const make = (options) => new VirtualPhone(module, { appId: 'ws-test', nowMs: 0, ...options });
const logs = (vm) =>
  vm
    .drainEvents()
    .filter((e) => e.type === 'log')
    .map((e) => e.text);
test('socket URLs use browser canonicalization and reject invalid ports and fragments', () => {
  assert.equal(
    normalizeSocketUrl('HTTPS://EXAMPLE.COM:443/a/../socket?q=1'),
    'wss://example.com/socket?q=1',
  );
  for (const url of [
    'ws://example.com:99999/',
    'wss://example.com/#',
    '/relative',
    'ftp://example.com/',
  ]) {
    assert.throws(() => normalizeSocketUrl(url));
  }
});
class Socket {
  readyState = 0;
  bufferedAmount = 0;
  protocol = 'chat';
  extensions = '';
  sent = [];
  closed = [];
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? data : Array.from(data));
  }
  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 2;
  }
  message(data) {
    this.onmessage?.({ data });
  }
  end(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }
}
function harness(options = {}) {
  const vm = make({ network: { mode: 'cors' }, ...options }),
    sockets = [],
    events = [];
  const host = new PhoneWebSocketNetwork(
    (id, event) => {
      events.push({ direction: 'host', id, event });
      vm.deliverWebSocketEvent(id, event);
    },
    {},
    () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
  );
  function flush() {
    for (let i = 0; i < 50; i++) {
      const batch = vm.drainEvents();
      if (!batch.length) return;
      for (const e of batch) {
        events.push(e);
        host.handle(e);
      }
    }
    throw Error('Fixture did not settle');
  }
  return {
    vm,
    host,
    sockets,
    events,
    flush,
    close() {
      host.dispose();
      vm.dispose();
    },
  };
}
test('phone locale is available independently of watch locale and cancellation is an empty response', () => {
  const vm = make({ language: 'fr-FR', watchInfo: { language: 'de_DE' } });
  try {
    vm.start(
      `console.log(navigator.language,navigator.languages[0],Object.isFrozen(navigator.languages));Pebble.addEventListener('showConfiguration',()=>Pebble.openURL('https://fixture.invalid/'));Pebble.addEventListener('webviewclosed',e=>{if(e.response==='')console.log('canceled');else console.log('saved',e.response);});`,
    );
    assert.deepEqual(logs(vm), ['fr-FR fr-FR true']);
    vm.showConfiguration();
    vm.drainEvents();
    assert.equal(vm.closeConfiguration(null), true);
    assert.deepEqual(logs(vm), ['canceled']);
    vm.showConfiguration();
    vm.drainEvents();
    vm.closeConfiguration('%7B%22x%22%3A1%7D');
    assert.deepEqual(logs(vm), ['saved %7B%22x%22%3A1%7D']);
  } finally {
    vm.dispose();
  }
  assert.throws(() => make({ language: 'x'.repeat(200) }), /language/);
});
test('offline WebSocket exists but reports real disabled-network failure, never open or fake messages', () => {
  const vm = make();
  try {
    vm.start(
      `var s=new WebSocket('wss://fixture.invalid/');s.onopen=()=>console.log('BAD');s.onerror=()=>console.log('error',s.readyState);s.onclose=e=>console.log('close',e.code,e.wasClean);console.log(s.readyState,WebSocket.CONNECTING,typeof process);`,
    );
    const events = vm.drainEvents();
    assert.equal(
      events.filter((e) => e.type === 'websocket-command' && e.action === 'open').length,
      1,
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      ['0 0 undefined', 'error 3', 'close 1006 false'],
    );
    assert.equal(
      vm.deliverWebSocketEvent(1, { type: 'open', protocol: '', extensions: '' }),
      false,
    );
  } finally {
    vm.dispose();
  }
});
test('live bridge carries text, typed-array slices, default Blob and ArrayBuffer messages and clean close', () => {
  const h = harness();
  try {
    h.vm.start(
      `var s=new WebSocket('wss://fixture.invalid/',['chat']);s.onopen=()=>{console.log('open',s.readyState,s.protocol);s.send('hé');s.send(new Uint8Array([1,2,3,4]).subarray(1,3));};s.onmessage=e=>{if(typeof e.data==='string')console.log('text',e.data);else if(e.data instanceof Blob)e.data.text().then(t=>console.log('blob',e.data.size,t));else console.log('binary',Array.from(new Uint8Array(e.data)).join(','));};s.onclose=e=>console.log('close',e.code,e.reason,e.wasClean);Pebble.addEventListener('appmessage',e=>{if(e.payload.close)s.close(4001,'done');else{s.binaryType='arraybuffer';console.log('buffer',s.bufferedAmount);}});`,
    );
    h.flush();
    assert.equal(h.sockets.length, 1);
    const socket = h.sockets[0];
    socket.open();
    h.flush();
    assert.deepEqual(socket.sent, ['hé', [2, 3]]);
    socket.message('hello');
    socket.message(Uint8Array.from([240, 159, 152, 128]).buffer);
    h.flush();
    h.vm.injectAppMessage({});
    h.flush();
    socket.message(Uint8Array.from([7, 8]).buffer);
    h.flush();
    h.vm.injectAppMessage({ close: 1 });
    h.flush();
    assert.deepEqual(socket.closed, [{ code: 4001, reason: 'done' }]);
    socket.end(4001, 'done');
    h.flush();
    assert.deepEqual(
      h.events.filter((e) => e.type === 'log').map((e) => e.text),
      ['open 1 chat', 'text hello', 'blob 4 😀', 'buffer 0', 'binary 7,8', 'close 4001 done true'],
    );
  } finally {
    h.close();
  }
});
test('constructor/state/size limits reject misuse and do not expose host functions', () => {
  const h = harness({ limits: { pendingSockets: 1, socketMessageBytes: 4 } });
  try {
    h.vm.start(
      `for(const f of [()=>new WebSocket('file:///x'),()=>new WebSocket('ws://user:pass@localhost/'),()=>new WebSocket('wss://x/#a'),()=>new WebSocket('wss://x/',['a','a'])])try{f();console.log('BAD')}catch(e){console.log(e.name)}var s=new WebSocket('wss://fixture.invalid/');try{s.send('x')}catch(e){console.log(e.name)}try{new WebSocket('wss://fixture.invalid/2')}catch(e){console.log('limit')}s.onopen=()=>{try{s.send('12345')}catch(e){console.log('large')}try{s.close(1006)}catch(e){console.log(e.name)}console.log(s.send.constructor('return typeof process')(),typeof __phoneSocketUrl);};`,
    );
    h.flush();
    h.sockets[0].open();
    h.flush();
    assert.deepEqual(
      h.events.filter((e) => e.type === 'log').map((e) => e.text),
      [
        'SyntaxError',
        'SyntaxError',
        'SyntaxError',
        'SyntaxError',
        'InvalidStateError',
        'limit',
        'large',
        'InvalidAccessError',
        'undefined undefined',
      ],
    );
    assert.deepEqual(h.sockets[0].sent, []);
  } finally {
    h.close();
  }
});
test('host bounds incoming data and quarantines late callbacks after disposal', () => {
  const output = [],
    socket = new Socket(),
    host = new PhoneWebSocketNetwork(
      (id, e) => output.push(e),
      { messageBytes: 4 },
      () => socket,
    );
  const open = {
    type: 'websocket-command',
    timestamp: 0,
    socketId: 1,
    action: 'open',
    url: 'wss://fixture.invalid/',
    protocols: [],
  };
  host.handle(open);
  const late = socket.onmessage;
  socket.open();
  socket.message('12345');
  assert.deepEqual(
    output.map((e) => e.type),
    ['open', 'error', 'close'],
  );
  assert.equal(output.at(-1).code, 1006);
  const n = output.length;
  host.dispose();
  late({ data: 'late' });
  assert.equal(output.length, n);
  assert.equal(socket.closed.length, 1);
});
test('host closes active sockets and ignores stale generation callbacks without fabricating replies', () => {
  const output = [],
    socket = new Socket(),
    host = new PhoneWebSocketNetwork(
      (id, e) => output.push(e),
      {},
      () => socket,
    );
  host.handle({
    type: 'websocket-command',
    timestamp: 0,
    socketId: 1,
    action: 'open',
    url: 'wss://fixture.invalid/',
    protocols: [],
  });
  const open = socket.onopen,
    message = socket.onmessage,
    close = socket.onclose;
  host.dispose();
  open({});
  message({ data: 'late' });
  close({ code: 1000, reason: 'late', wasClean: true });
  assert.deepEqual(output, []);
  assert.equal(socket.closed.length, 1);
});
test('host connection timeout releases socket with an abnormal close', async () => {
  const output = [],
    socket = new Socket(),
    host = new PhoneWebSocketNetwork(
      (id, e) => output.push(e),
      { timeoutMs: 10 },
      () => socket,
    );
  try {
    host.handle({
      type: 'websocket-command',
      timestamp: 0,
      socketId: 1,
      action: 'open',
      url: 'wss://fixture.invalid/',
      protocols: [],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(
      output.map((e) => e.type),
      ['error', 'close'],
    );
    assert.equal(output[1].wasClean, false);
  } finally {
    host.dispose();
  }
});
