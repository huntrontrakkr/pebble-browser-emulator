import test from 'node:test';
import assert from 'node:assert/strict';
import { switchToWaitingVersion } from '../src/app/launch-update.ts';

// A service-worker container with an optional waiting worker that answers the
// same messages the real worker does.
function container({ controller = true, waiting = true, tabs = 1, activates = true } = {}) {
  const listeners = new Map();
  const sent = [];
  const worker = {
    postMessage(message, [port]) {
      sent.push(message.type);
      if (message.type === 'TABS') port.postMessage({ done: true, value: tabs });
      if (message.type === 'APPLY_UPDATE') {
        port.postMessage({ done: true });
        if (activates) setTimeout(() => listeners.get('controllerchange')?.());
      }
    },
  };
  return {
    sent,
    controller: controller ? {} : null,
    getRegistration: async () => ({ waiting: waiting ? worker : null }),
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
}

test('a waiting version with no other tab takes over and reloads before the app starts', async () => {
  const c = container();
  let reloads = 0;
  assert.equal(await switchToWaitingVersion(c, () => reloads++), true);
  assert.deepEqual(c.sent, ['TABS', 'APPLY_UPDATE']);
  assert.equal(reloads, 1);
});

test('another open tab may hold a running watch, so launch leaves the update to the notice', async () => {
  const c = container({ tabs: 2 });
  let reloads = 0;
  assert.equal(await switchToWaitingVersion(c, () => reloads++), false);
  assert.deepEqual(c.sent, ['TABS']);
  assert.equal(reloads, 0);
});

test('nothing waiting, a first visit or no service worker starts the app as it is', async () => {
  const none = () => assert.fail('must not reload');
  assert.equal(await switchToWaitingVersion(container({ waiting: false }), none), false);
  const first = container({ controller: false });
  assert.equal(await switchToWaitingVersion(first, none), false);
  assert.deepEqual(first.sent, []);
  assert.equal(await switchToWaitingVersion(undefined, none), false);
});

test('a worker that never takes over does not hold the app back or reload it', async () => {
  const c = container({ activates: false });
  let reloads = 0;
  assert.equal(await switchToWaitingVersion(c, () => reloads++, 50), false);
  assert.equal(reloads, 0);
});
