import test from 'node:test';
import assert from 'node:assert/strict';
import { PulseLogDecoder } from '../src/app/pulse-log.ts';

// Captured from unchanged 4.37.0 on qemu_emery: a link-control frame and two
// log records, exactly as they left the debug UART.
const LINK = '5505c0210104060403b253e455';
const ACTIVITY =
  '5503502102030d4c0161637469766974792e63010101010109492dcae519caa00101324803736572766963655f61637469766974793a20416374697669747920747261636b696e6720737461727465647ea3f6e955';
const TIMELINE =
  '5503502102030a44016576656e742e63010101010101010109452d93e219caa00101024c28736572766963655f74696d656c696e653a204e6f742073657474696e672074696d657253d830fb55';
const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'));

test('firmware log frames read as level, file, line and message', () => {
  const decoder = new PulseLogDecoder();
  assert.deepEqual(decoder.push(hex(LINK + ACTIVITY + TIMELINE)), [
    'I activity.c:840 service_activity: Activity tracking started',
    'E event.c:76 service_timeline: Not setting timer',
  ]);
});

test('a frame split across reads is held until it completes', () => {
  const decoder = new PulseLogDecoder();
  const bytes = hex(ACTIVITY);
  assert.deepEqual(decoder.push(bytes.subarray(0, 40)), []);
  assert.deepEqual(decoder.push(bytes.subarray(40)), [
    'I activity.c:840 service_activity: Activity tracking started',
  ]);
});

test('a corrupted frame is not dressed up as a log record', () => {
  const decoder = new PulseLogDecoder();
  const bytes = hex(ACTIVITY);
  bytes[30] ^= 1;
  const lines = decoder.push(bytes);
  assert.ok(!lines.some((line) => line.startsWith('I activity.c')));
});

test('plain console text, including a capital U, passes through', () => {
  const decoder = new PulseLogDecoder();
  const text = new TextEncoder().encode('Booting\nUSB Ready. Use buttons\n');
  assert.deepEqual(decoder.push(text), ['Booting\nUSB Ready. Use buttons']);
});

test('reset forgets a half-read frame', () => {
  const decoder = new PulseLogDecoder();
  decoder.push(hex(ACTIVITY).subarray(0, 40));
  decoder.reset();
  assert.deepEqual(decoder.push(hex(TIMELINE)), [
    'E event.c:76 service_timeline: Not setting timer',
  ]);
});
