import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppMessageRouter } from '../src/app/app-message-router.ts';
test('phone replacement quarantines its old in-flight transaction IDs', () => {
  const r = new AppMessageRouter(),
    oldPhone = {},
    newPhone = {};
  r.beginSession(1);
  const old = r.allocate(1, 1, oldPhone),
    next = r.allocate(1, 1, newPhone);
  assert.notEqual(old, next);
  assert.deepEqual(r.settle(1, old), { owner: oldPhone, transactionId: 1 });
  assert.deepEqual(r.settle(1, next), { owner: newPhone, transactionId: 1 });
  assert.equal(r.settle(1, old), undefined);
});
test('stale session ACK cannot delete or resolve a new session transaction', () => {
  const r = new AppMessageRouter();
  r.beginSession(7);
  const old = r.allocate(7, 1, 'old');
  r.beginSession(8);
  const next = r.allocate(8, 23, 'new');
  assert.equal(old, next);
  assert.equal(r.settle(7, old), undefined);
  assert.deepEqual(r.settle(8, next), { owner: 'new', transactionId: 23 });
});
test('reserved IDs are bounded and never recycled while still in-flight', () => {
  const r = new AppMessageRouter();
  r.beginSession(1);
  const ids = Array.from({ length: 255 }, (_, n) => r.allocate(1, n, 'phone'));
  assert.equal(new Set(ids).size, 255);
  assert.equal(ids.includes(undefined), false);
  assert.equal(r.allocate(1, 1, 'replacement'), undefined);
  assert.equal(r.settle(1, ids[42]).transactionId, 42);
  assert.equal(r.allocate(1, 9, 'replacement'), ids[42]);
});
test('a new Worker identity clears its generation namespace explicitly', () => {
  const r = new AppMessageRouter();
  r.beginSession(1);
  r.allocate(1, 4, 'old');
  r.resetWorker();
  assert.equal(r.allocate(1, 5, 'new'), undefined);
  r.beginSession(1);
  assert.deepEqual(r.settle(1, r.allocate(1, 6, 'new')), { owner: 'new', transactionId: 6 });
});
