import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../src/app/virtual-phone.ts';
import { seededRandom } from '../src/app/signals.ts';
import { withTestLimits } from './phone-limits.mjs';
const module = await getQuickJS();
const logs = (vm) =>
  vm
    .drainEvents()
    .filter((e) => e.type === 'log')
    .map((e) => e.text);
test('location loss and recovery reach real isolated watchPosition callbacks', () => {
  const vm = new VirtualPhone(module, withTestLimits({ appId: 'location', nowMs: 0 }));
  try {
    vm.start(
      `var id=navigator.geolocation.watchPosition(p=>console.log('position',p.coords.latitude,p.coords.altitude,p.coords.speed,p.coords.heading),e=>console.log('error',e.code,e.message));`,
    );
    logs(vm);
    vm.setLocationError(2, 'No fix');
    assert.deepEqual(logs(vm), ['error 2 No fix']);
    vm.setLocation({ latitude: 20, longitude: 10, altitude: 42, speed: 3, heading: 180 });
    assert.deepEqual(logs(vm), ['position 20 42 3 180']);
    vm.setLocationError(1, 'Denied');
    assert.deepEqual(logs(vm), ['error 1 Denied']);
    assert.throws(() => vm.setLocation({ latitude: 0, longitude: 0, speed: -1 }));
  } finally {
    vm.dispose();
  }
});
test('phone random source shares the documented scenario seed without exposing host functions', () => {
  const vm = new VirtualPhone(module, withTestLimits({ appId: 'random', randomSeed: 17 }));
  try {
    vm.start(`console.log(Math.random(),Math.random(),Math.random());`);
    const r = seededRandom(17);
    assert.deepEqual(logs(vm), [[r(), r(), r()].join(' ')]);
  } finally {
    vm.dispose();
  }
});
