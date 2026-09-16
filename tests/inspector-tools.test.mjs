import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerInspector } from '../src/app/inspector-tools.ts';
test('optional inspector tool reads the same state, rejects invalid input, and unregisters', () => {
  let tool, signal;
  const state = { registers: [1, 2], running: false, framebuffer: new Uint8Array(45600) };
  const cleanup = registerInspector(
    {
      registerTool(t, o) {
        tool = t;
        signal = o.signal;
      },
    },
    () => state,
  );
  assert.equal(tool.name, 'read_emulator_state');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.execute({}), {
    profile: 'diagnostic-v1',
    registers: [1, 2],
    running: false,
  });
  assert.throws(() => tool.execute({ run: true }), /empty object/);
  assert.throws(() => tool.execute(null));
  cleanup();
  assert.equal(signal.aborted, true);
  registerInspector(undefined, () => null)();
});
