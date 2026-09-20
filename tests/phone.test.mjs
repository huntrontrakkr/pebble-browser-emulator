import assert from 'node:assert/strict';
import test from 'node:test';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../src/app/virtual-phone.ts';
import { withTestLimits } from './phone-limits.mjs';
const module = await getQuickJS();
const make = (options = {}) =>
  new VirtualPhone(module, {
    appId: '00112233-4455-6677-8899-aabbccddeeff',
    nowMs: 1000,
    ...withTestLimits(options),
  });
const logs = (vm) =>
  vm
    .drainEvents()
    .filter((e) => e.type === 'log')
    .map((e) => e.text);

test('executes real PKJS ready and keeps host APIs isolated', () => {
  const vm = make();
  try {
    vm.start(`Pebble.addEventListener('ready',()=>{
    console.log('ready', typeof process, typeof fetch, typeof XMLHttpRequest, typeof document, typeof __phoneEmit);
    console.log(Function('return typeof process')());
    try {require('node:fs')} catch(e){console.log('module denied')}
  });`);
    assert.deepEqual(logs(vm), [
      'ready undefined function function undefined undefined',
      'undefined',
      'module denied',
    ]);
  } finally {
    vm.dispose();
  }
});
test('Date and timers use explicit virtual time; microtasks follow each timer', () => {
  const vm = make();
  try {
    vm.start(`console.log(Date.now(), +new Date(), new Date().constructor.now(), performance.now());
    setTimeout(()=>{console.log('first',Date.now());Promise.resolve().then(()=>console.log('micro'));},5);
    setTimeout(()=>console.log('second',Date.now()),5);
    var interval=setInterval(()=>console.log('interval',Date.now()),10);
    setTimeout(()=>clearInterval(interval),25);`);
    assert.deepEqual(logs(vm), ['1000 1000 1000 0']);
    vm.advanceTime(1004);
    assert.deepEqual(logs(vm), []);
    vm.advanceTime(1029);
    assert.deepEqual(logs(vm), [
      'first 1005',
      'micro',
      'second 1005',
      'interval 1010',
      'interval 1020',
    ]);
    assert.throws(() => vm.advanceTime(1000), /backwards/);
  } finally {
    vm.dispose();
  }
});
test('location get/watch/clear use injected phone state', () => {
  const vm = make({ coordinates: { latitude: 40.7, longitude: -74, accuracy: 8 } });
  try {
    vm.start(`navigator.geolocation.getCurrentPosition(p=>console.log('get',p.coords.latitude,p.coords.longitude,p.timestamp));
    var watch=navigator.geolocation.watchPosition(p=>{console.log('watch',p.coords.latitude,p.timestamp);if(p.coords.latitude===51.5)navigator.geolocation.clearWatch(watch);});`);
    assert.deepEqual(logs(vm), ['get 40.7 -74 1000', 'watch 40.7 1000']);
    vm.advanceTime(2000);
    vm.setLocation({ latitude: 51.5, longitude: -0.1 });
    assert.deepEqual(logs(vm), ['watch 51.5 2000']);
    vm.setLocation({ latitude: 0, longitude: 0 });
    assert.deepEqual(logs(vm), []);
    assert.throws(() => vm.setLocation({ latitude: 100, longitude: 0 }), /latitude/);
  } finally {
    vm.dispose();
  }
});
test('disconnected AppMessage emits outbound plus NOT_CONNECTED and never ACK', () => {
  const vm = make({ messageKeys: { Temperature: 7 } });
  try {
    vm.start(
      `Pebble.addEventListener('ready',()=>{console.log(require('message_keys').Temperature);Pebble.sendAppMessage({Temperature:25,unknown:'discard'},()=>console.log('ACK'),e=>console.log(e.error.code));});`,
    );
    const events = vm.drainEvents();
    const out = events.find((e) => e.type === 'outbound');
    assert.equal(out.transactionId, 1);
    assert.deepEqual(out.payload, { 7: 25 });
    assert.deepEqual(
      events.filter((e) => e.type === 'log').map((e) => e.text),
      ['7', 'NOT_CONNECTED'],
    );
    assert.equal(vm.acknowledgeAppMessage(1, true), false);
  } finally {
    vm.dispose();
  }
});
test('only explicit transport ACK succeeds; NACK and virtual timeout fail', () => {
  const vm = make({ limits: { messageTimeoutMs: 100 } });
  try {
    vm.setConnected(true);
    vm.start(`function send(){Pebble.sendAppMessage({'1':'hello'},()=>console.log('ACK'),e=>console.log(e.error.code));}
    Pebble.addEventListener('ready',send);Pebble.addEventListener('appmessage',send);`);
    let event = vm.drainEvents().find((e) => e.type === 'outbound');
    assert.equal(vm.acknowledgeAppMessage(event.transactionId, true), true);
    assert.deepEqual(logs(vm), ['ACK']);
    vm.injectAppMessage({});
    event = vm.drainEvents().find((e) => e.type === 'outbound');
    vm.acknowledgeAppMessage(event.transactionId, false);
    assert.deepEqual(logs(vm), ['NACK']);
    vm.injectAppMessage({});
    vm.drainEvents();
    vm.advanceTime(1100);
    assert.deepEqual(logs(vm), ['TIMEOUT']);
  } finally {
    vm.dispose();
  }
});
test('listener removal, incoming key aliases, configuration callbacks', () => {
  const vm = make({ messageKeys: { Temperature: 7 } });
  try {
    vm.start(`function gone(){console.log('BAD')}Pebble.addEventListener('appmessage',gone);Pebble.removeEventListener('appmessage',gone);
    Pebble.addEventListener('appmessage',e=>console.log(e.payload.Temperature));
    Pebble.addEventListener('showConfiguration',()=>Pebble.openURL('https://example.com/settings'));
    Pebble.addEventListener('webviewclosed',e=>console.log(e.response));`);
    vm.injectAppMessage({ 7: 21 });
    assert.deepEqual(logs(vm), ['21']);
    vm.showConfiguration();
    assert.equal(vm.drainEvents()[0].type, 'configuration');
    vm.closeConfiguration('configured');
    assert.deepEqual(logs(vm), ['configured']);
  } finally {
    vm.dispose();
  }
});
test('localStorage coercion/enumeration and persistence stay isolated per app', () => {
  const a = make({ storage: { count: '2' } }),
    b = make({ appId: 'another-app' });
  try {
    a.start(`localStorage.setItem('count',Number(localStorage.getItem('count'))+1);localStorage.flag=true;
    console.log(localStorage.count,localStorage.flag,localStorage.length,Object.keys(localStorage).sort().join(','));delete localStorage.flag;`);
    assert.deepEqual(logs(a), ['3 true 2 count,flag']);
    assert.deepEqual(a.getStorage(), { count: '3' });
    b.start(`console.log(localStorage.getItem('count'));`);
    assert.deepEqual(logs(b), ['null']);
    const restored = make({ storage: a.getStorage() });
    try {
      restored.start(`console.log(localStorage.count)`);
      assert.deepEqual(logs(restored), ['3']);
    } finally {
      restored.dispose();
    }
  } finally {
    a.dispose();
    b.dispose();
  }
});
test('output and storage are bounded', () => {
  const a = make({ limits: { eventCount: 8, outputBytes: 4096, storageBytes: 20 } });
  try {
    a.start(`for(let i=0;i<100;i++)console.log(i);try{localStorage.big='x'.repeat(100)}catch(e){}`);
    const events = a.drainEvents();
    assert.ok(events.length <= 8);
    assert.equal(events.at(-1).type, 'limit');
    assert.deepEqual(a.getStorage(), {});
  } finally {
    a.dispose();
  }
});
test('infinite code is interrupted and cannot be resumed', (t) => {
  // This gate measures the guest turn, not scheduler delays while installing the
  // trusted bootstrap. Restore real time before executing any guest code; retain
  // the actual 20 ms interrupt and the stopped-instance assertion below.
  const setupClock = t.mock.method(Date, 'now', () => 0);
  let vm;
  try {
    vm = make({ limits: { turnMilliseconds: 20 } });
  } finally {
    setupClock.mock.restore();
  }
  try {
    const start = Date.now();
    assert.throws(() => vm.start('while(true){}'), /interrupted/);
    assert.ok(Date.now() - start < 2000);
    assert.throws(() => vm.advanceTime(2000), /stopped/);
  } finally {
    vm.dispose();
  }
});
test('timer callback loop and promise jobs are bounded', () => {
  const timer = make({ limits: { timerCallbacks: 10 } }),
    jobs = make({ limits: { pendingJobs: 10 } });
  try {
    assert.throws(
      () => timer.start('function again(){setTimeout(again,0)}again()'),
      /callback limit/,
    );
    assert.throws(
      () => jobs.start('function again(){Promise.resolve().then(again)}again()'),
      /pending-job limit/,
    );
  } finally {
    timer.dispose();
    jobs.dispose();
  }
});
test('memory is bounded and disposal is idempotent', () => {
  const vm = make({ limits: { memoryBytes: 2 * 1024 * 1024, turnMilliseconds: 200 } });
  try {
    assert.throws(
      () => vm.start(`const x=[];for(;;)x.push(new Array(10000).fill(42));`),
      /out of memory|interrupted/,
    );
  } finally {
    vm.dispose();
    vm.dispose();
  }
});

test('SDK array message keys allocate blocks first from 10000 and preserve declaration order', () => {
  const vm = make({ messageKeys: ['Temperature', 'Hourly[3]', 'Condition', 'Flags[2]'] });
  try {
    vm.setConnected(true);
    vm.start(`console.log(JSON.stringify(require('message_keys')));
      Pebble.addEventListener('appmessage', e => console.log(e.payload.Hourly,e.payload.Temperature));
      Pebble.sendAppMessage({Temperature:23,Condition:'sun',Hourly:7,Flags:1});`);
    const events = vm.drainEvents();
    assert.deepEqual(JSON.parse(events.find((e) => e.type === 'log').text), {
      Hourly: 10000,
      Flags: 10003,
      Temperature: 10005,
      Condition: 10006,
    });
    assert.deepEqual(events.find((e) => e.type === 'outbound').payload, {
      10000: 7,
      10003: 1,
      10005: 23,
      10006: 'sun',
    });
    vm.injectAppMessage({ 10000: 4, 10005: 19 });
    assert.deepEqual(logs(vm), ['4 19']);
  } finally {
    vm.dispose();
  }
  for (const messageKeys of [['X[0]'], ['X[4294967296]'], ['X', 'X[2]'], [42]]) {
    assert.throws(() => make({ messageKeys }), /message key|Message keys/);
  }
});
