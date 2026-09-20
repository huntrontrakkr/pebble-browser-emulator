import test from 'node:test';
import assert from 'node:assert/strict';
import { PressFloor, MIN_PRESS_US } from '../src/app/press-floor.ts';

const SELECT = 0x4;
const UP = 0x2;

test('a press and release in the same instant still reaches the firmware', () => {
  const floor = new PressFloor();
  floor.request(SELECT, 1_000);
  floor.request(0, 1_000); // released without the clock moving at all
  assert.equal(floor.effective(1_000), SELECT, 'the press is still held');
  assert.equal(
    floor.effective(1_000 + MIN_PRESS_US - 1),
    SELECT,
    'still held right up to the floor',
  );
  assert.equal(floor.effective(1_000 + MIN_PRESS_US), 0, 'released once the floor passes');
});

test('a press held past the floor is released when the viewer releases it', () => {
  const floor = new PressFloor();
  floor.request(SELECT, 0);
  const late = MIN_PRESS_US * 4;
  assert.equal(floor.effective(late), SELECT, 'held for as long as it is held');
  floor.request(0, late);
  assert.equal(floor.effective(late), 0, 'released immediately, not extended again');
});

test('each button carries its own floor', () => {
  const floor = new PressFloor();
  floor.request(SELECT, 0);
  floor.request(SELECT | UP, MIN_PRESS_US / 2);
  floor.request(0, MIN_PRESS_US / 2);
  // Select's floor has passed; Up's was started later and has not.
  assert.equal(floor.effective(MIN_PRESS_US), UP);
  assert.equal(floor.effective(MIN_PRESS_US * 2), 0);
});

test('re-pressing a held button does not restart its floor', () => {
  const floor = new PressFloor();
  floor.request(SELECT, 0);
  floor.request(SELECT, MIN_PRESS_US - 1); // same bit, still down
  floor.request(0, MIN_PRESS_US - 1);
  assert.equal(floor.effective(MIN_PRESS_US), 0, 'the original floor governs');
});

test('reset forgets held presses so a new program starts clean', () => {
  const floor = new PressFloor();
  floor.request(SELECT, 0);
  floor.request(0, 0);
  floor.reset();
  assert.equal(floor.effective(0), 0);
});
