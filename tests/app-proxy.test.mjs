import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedAddress, guardedLookup, relayRequest } from '../services/resources/app-proxy.mjs';

test('addresses outside public routing are refused', () => {
  const blocked = [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud instance metadata
    '100.64.0.1', // carrier-grade NAT
    '198.18.0.1',
    '192.0.0.8', // protocol assignments
    '192.0.2.1', // TEST-NET-1
    '198.51.100.1', // TEST-NET-2
    '203.0.113.1', // TEST-NET-3
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '64:ff9b::10.0.0.1', // NAT64-embedded private address
    '2001:db8::1',
  ];
  for (const address of blocked)
    assert.equal(blockedAddress(address), true, `${address} must be refused`);

  // Public hosts that sit next to a reserved range must still be reachable.
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '192.0.66.1',
    '198.51.101.1',
    '203.0.114.1',
    '2606:4700::1111',
  ];
  for (const address of allowed)
    assert.equal(blockedAddress(address), false, `${address} must be allowed`);

  // Anything that is not an address at all is refused rather than assumed safe.
  assert.equal(blockedAddress('example.com'), true);
  assert.equal(blockedAddress(''), true);
});

test('a hostname resolving only inward is refused at lookup', async () => {
  const lookup = guardedLookup((_host, _options, done) =>
    done(null, [{ address: '169.254.169.254', family: 4 }]),
  );
  const error = await new Promise((resolve) =>
    lookup('metadata.example', { all: false }, (e) => resolve(e)),
  );
  assert.ok(error, 'the lookup must fail');
  assert.equal(error.code, 'EBLOCKED');
  assert.match(error.message, /non-public address/);
});

test('a hostname keeps only its public addresses', async () => {
  const lookup = guardedLookup((_host, _options, done) =>
    done(null, [
      { address: '10.0.0.5', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]),
  );
  const [error, address] = await new Promise((resolve) =>
    lookup('mixed.example', { all: false }, (e, a) => resolve([e, a])),
  );
  assert.equal(error, null);
  assert.equal(address, '1.1.1.1', 'the private address must not be chosen');
});

test('only HTTPS without embedded credentials is relayed', async () => {
  await assert.rejects(() => relayRequest('http://example.com/'), /Only HTTPS/);
  await assert.rejects(() => relayRequest('https://user:pass@example.com/'), /credentials/);
  await assert.rejects(() => relayRequest('https://example.com/', { method: 'POST' }), /GET/);
  await assert.rejects(() => relayRequest('https://example.com/', { method: 'DELETE' }), /GET/);
});

test('the guard refuses the connection, not merely a pre-flight check', async () => {
  // A hostname that resolves inward: the relay must fail at connect time, so a
  // name that changes between a check and the request cannot slip through.
  const lookup = guardedLookup((_host, _options, done) =>
    done(null, [{ address: '127.0.0.1', family: 4 }]),
  );
  await assert.rejects(
    () => relayRequest('https://loopback.example/secret', { lookup, timeoutMs: 3000 }),
    (error) => {
      assert.match(String(error.message), /non-public address/);
      return true;
    },
  );
});

test('a public address is not refused by the guard', async () => {
  // Whether the connection then succeeds depends on the network, so this asserts
  // the guard's decision rather than the outcome: it must not be the refusal.
  let consulted = false;
  const lookup = guardedLookup((_host, _options, done) => {
    consulted = true;
    done(null, [{ address: '192.0.66.1', family: 4 }]);
  });
  const outcome = await relayRequest('https://public.example/', { lookup, timeoutMs: 1500 }).then(
    () => null,
    (error) => error,
  );
  assert.equal(consulted, true, 'the relay must resolve through the guard');
  if (outcome) assert.notEqual(outcome.code, 'EBLOCKED');
  if (outcome) assert.doesNotMatch(String(outcome.message), /non-public address/);
});
