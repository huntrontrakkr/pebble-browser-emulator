import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = process.env.PEBBLE_REPO ?? fileURLToPath(new URL('../', import.meta.url));
const source = process.env.PEBBLE_PHONE_WORKER ?? resolve(repo, 'src/app/phone.worker.ts');
const wasmUrl = pathToFileURL(resolve(repo, 'public/wasm/quickjs.wasm')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class PhoneHarness {
  messages = [];
  waiters = [];
  error;
  constructor() {
    this.worker = new Worker(new URL('./phone-network-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source },
    });
    this.worker.on('message', (m) => {
      this.messages.push(m);
      for (const w of [...this.waiters]) w();
    });
    this.worker.on('error', (e) => {
      this.error = e;
      for (const w of [...this.waiters]) w();
    });
  }
  send(m) {
    this.worker.postMessage(m);
  }
  async wait(predicate, after = 0) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Timeout ' + JSON.stringify(this.messages.slice(-8)))),
        15000,
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((x) => x !== check);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        if (this.error) {
          finish(this.error);
          return;
        }
        const messages = this.messages.slice(after),
          error = messages.find((m) => m.type === 'error' || m.type === 'harness-unhandled'),
          match = messages.find(predicate);
        if (error) finish(new Error(error.message));
        else if (match) finish(null, match);
      };
      this.waiters.push(check);
      check();
    });
  }
  start(appId, source, options = {}) {
    this.send({
      type: 'start',
      appId,
      source,
      name: 'network.js',
      wasmUrl,
      network: { mode: 'cors' },
      ...options,
    });
  }
  async close() {
    await this.worker.terminate();
  }
}
test(
  'actual phone Worker aborts old HTTP requests and quarantines replies across app replacement',
  { timeout: 30000 },
  async () => {
    const h = new PhoneHarness();
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.start(
        'old',
        `fetch('https://fixture.invalid/old').then(r=>r.text()).then(value=>console.log('OLD',value));`,
      );
      const old = await h.wait((m) => m.type === 'harness-network');
      assert.equal(old.mode, 'cors');
      assert.equal(old.credentials, 'omit');
      await h.wait((m) => m.type === 'status' && m.status === 'Running');
      const mark = h.messages.length;
      h.start(
        'new',
        `fetch('https://fixture.invalid/new').then(r=>r.text()).then(value=>console.log('NEW',value));`,
      );
      await h.wait((m) => m.type === 'harness-abort' && m.id === old.id, mark);
      const current = await h.wait((m) => m.type === 'harness-network' && m.id !== old.id, mark);
      h.send({ type: 'harness-response', id: old.id, body: 'stale' });
      h.send({ type: 'harness-response', id: current.id, body: 'fresh' });
      await h.wait((m) => m.type === 'event' && m.event.text === 'NEW fresh', mark);
      await sleep(25);
      assert.equal(
        h.messages.some((m) => m.type === 'event' && m.event.text?.startsWith('OLD')),
        false,
      );
      assert.equal(
        h.messages.slice(mark).filter((m) => m.type === 'network-result' && m.accepted).length,
        1,
      );
    } finally {
      await h.close();
    }
  },
);
test(
  'actual phone Worker stop aborts HTTP and late data cannot restart the script',
  { timeout: 30000 },
  async () => {
    const h = new PhoneHarness();
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.start(
        'old',
        `fetch('https://fixture.invalid/old').then(r=>r.text()).then(value=>console.log('BAD',value));`,
      );
      const request = await h.wait((m) => m.type === 'harness-network');
      const mark = h.messages.length;
      h.send({ type: 'stop' });
      await h.wait((m) => m.type === 'harness-abort', mark);
      h.send({ type: 'harness-response', id: request.id, body: 'stale' });
      await sleep(50);
      assert.equal(
        h.messages
          .slice(mark)
          .some(
            (m) =>
              m.type === 'network-result' ||
              m.type === 'error' ||
              (m.type === 'event' && m.event.text?.startsWith('BAD')),
          ),
        false,
      );
    } finally {
      await h.close();
    }
  },
);
test(
  'actual phone Worker resolves fixtures by virtual time and rejects previous configuration generation',
  { timeout: 30000 },
  async () => {
    const h = new PhoneHarness();
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.start(
        'fixture',
        `fetch('https://fixture.invalid/weather').then(r=>r.json()).then(v=>console.log('WEATHER',v.temperature));Pebble.addEventListener('showConfiguration',()=>Pebble.openURL('https://fixture.invalid/settings'));Pebble.addEventListener('webviewclosed',e=>console.log('CLOSED',e.response));`,
        {
          network: {
            mode: 'fixtures',
            fixtures: [
              {
                url: 'https://fixture.invalid/weather',
                delayMs: 500,
                response: { status: 200, body: '{"temperature":17}' },
              },
            ],
          },
        },
      );
      const started = await h.wait((m) => m.type === 'status' && m.status === 'Running');
      h.send({ type: 'advance', milliseconds: 500 });
      await h.wait((m) => m.type === 'event' && m.event.text === 'WEATHER 17');
      assert.equal(
        h.messages.some((m) => m.type === 'harness-network'),
        false,
      );
      h.send({ type: 'configuration' });
      const config = await h.wait((m) => m.type === 'event' && m.event.type === 'configuration');
      assert.equal(config.phoneGeneration, started.phoneGeneration);
      h.send({
        type: 'configurationClosed',
        phoneGeneration: started.phoneGeneration - 1,
        requestId: config.event.requestId,
        response: 'STALE',
      });
      h.send({
        type: 'configurationClosed',
        phoneGeneration: started.phoneGeneration,
        requestId: config.event.requestId,
        response: 'fresh',
      });
      await h.wait((m) => m.type === 'event' && m.event.text === 'CLOSED fresh');
      assert.equal(
        h.messages.some((m) => m.type === 'event' && m.event.text === 'CLOSED STALE'),
        false,
      );
    } finally {
      await h.close();
    }
  },
);
