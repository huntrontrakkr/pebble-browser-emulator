import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServiceDefaults,
  serviceDefaults,
  resetServiceDefaults,
} from '../src/app/service-defaults.ts';

const BASE = 'https://emulator.example/app/';
const respond = (body, status = 200) =>
  async function fetcher(url) {
    fetcher.calledWith = url;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };

test('a deployment endpoint and key are accepted', () => {
  assert.deepEqual(
    normalizeServiceDefaults({ endpoint: 'https://svc.example/', relayKey: 'k'.repeat(24) }),
    { endpoint: 'https://svc.example', relayKey: 'k'.repeat(24) },
  );
  assert.deepEqual(normalizeServiceDefaults({ endpoint: 'http://localhost:4318' }), {
    endpoint: 'http://localhost:4318',
    relayKey: '',
  });
});

test('anything malformed configures nothing rather than half a service', () => {
  const empty = { endpoint: '', relayKey: '' };
  for (const value of [
    null,
    {},
    { relayKey: 'k'.repeat(24) }, // a key with nowhere to send it
    { endpoint: 'not a url' },
    { endpoint: 'http://remote.example' }, // plain HTTP off localhost
    { endpoint: 'https://user:pass@svc.example' },
    { endpoint: 'https://svc.example/?token=1' },
    { endpoint: 'https://svc.example/#x' },
  ])
    assert.deepEqual(normalizeServiceDefaults(value), empty, JSON.stringify(value));

  // A key too short to be a credential is dropped, the endpoint is kept.
  assert.deepEqual(normalizeServiceDefaults({ endpoint: 'https://svc.example', relayKey: 'abc' }), {
    endpoint: 'https://svc.example',
    relayKey: '',
  });
});

test('the defaults are read from service-config.json beside the application', async () => {
  resetServiceDefaults();
  const fetcher = respond({ endpoint: 'https://svc.example', relayKey: 'k'.repeat(20) });
  assert.deepEqual(await serviceDefaults(fetcher, BASE), {
    endpoint: 'https://svc.example',
    relayKey: 'k'.repeat(20),
  });
  assert.equal(fetcher.calledWith, 'https://emulator.example/app/service-config.json');
});

test('a missing file leaves the application with no service', async () => {
  resetServiceDefaults();
  assert.deepEqual(await serviceDefaults(respond(null, 404), BASE), { endpoint: '', relayKey: '' });

  resetServiceDefaults();
  const throws = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await serviceDefaults(throws, BASE), { endpoint: '', relayKey: '' });

  resetServiceDefaults();
  const badJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('not json');
    },
  });
  assert.deepEqual(await serviceDefaults(badJson, BASE), { endpoint: '', relayKey: '' });
});

test('the file is read once, not on every consultation', async () => {
  resetServiceDefaults();
  let reads = 0;
  const counting = async () => {
    reads++;
    return { ok: true, status: 200, json: async () => ({ endpoint: 'https://svc.example' }) };
  };
  await serviceDefaults(counting, BASE);
  await serviceDefaults(counting, BASE);
  await serviceDefaults(counting, BASE);
  assert.equal(reads, 1);
});
