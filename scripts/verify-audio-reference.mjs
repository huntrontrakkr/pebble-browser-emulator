// Independent generic-QEMU speaker register/IRQ smoke against locally supplied
// pinned native QEMU and the shipped Wasm. Synthetic firmware is generated here;
// no Pebble firmware or third-party app bytes are needed or redistributed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isWasmRunFailure } from '../src/app/wasm-abi.ts';

const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/audio-reference');
await mkdir(out, { recursive: true });
await rm(join(out, 'result.json'), { force: true });
const executable = process.env.PEBBLE_QEMU;
if (!executable) {
  const result = { format: 'pebble-audio-reference', version: 1, outcome: 'not-run', reason: 'Set PEBBLE_QEMU to the pinned native QEMU binary.' };
  await writeFile(join(out, 'not-run.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exit(2);
}
await rm(join(out, 'not-run.json'), { force: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wasm = await readFile(process.env.PEBBLE_WASM ?? 'public/wasm/qemu-emery.wasm');
const binary = await readFile(executable);
const scratch = await mkdtemp(join(tmpdir(), 'pebble-audio-ref-'));

function image(irq) {
  const bytes = Buffer.alloc(irq ? 0x160 : 0x128, 0xff);
  bytes.writeUInt32LE(0x2008_0000, 0); // MSP
  bytes.writeUInt32LE(0x101, 4); // Thumb reset handler
  const words = (at, values) => values.forEach((v, i) => bytes.writeUInt16LE(v, at + i * 2));
  if (irq) {
    bytes.writeUInt32LE(0x141, (16 + 10) * 4); // external IRQ 10
    // Enable audio INTCTRL, enable NVIC IRQ 10, start CTRL, then idle.
    words(0x100, [0x480b, 0x2101, 0x6101, 0x4b0b, 0x2201, 0x0292, 0x601a, 0x6001, 0xe7fe]);
    bytes.writeUInt32LE(0x4001_2000, 0x130);
    bytes.writeUInt32LE(0xe000_e100, 0x134);
    // Handler clears INTSTAT, emits 'I' over UART2, and returns.
    words(0x140, [0x4805, 0x2101, 0x6141, 0x4b05, 0x2249, 0x601a, 0x4770]);
    bytes.writeUInt32LE(0x4001_2000, 0x158);
    bytes.writeUInt32LE(0x4000_2000, 0x15c);
  } else {
    // Enable audio and send the observed INTSTAT over UART2.
    words(0x100, [0x4807, 0x2101, 0x6101, 0x6001, 0x6942, 0x4b06, 0x601a, 0xe7fe]);
    bytes.writeUInt32LE(0x4001_2000, 0x120);
    bytes.writeUInt32LE(0x4000_2000, 0x124);
  }
  return bytes;
}

async function native(name, micro, flashPath) {
  const kernel = join(scratch, name + '.bin');
  const serial = join(scratch, name + '.uart');
  await writeFile(kernel, micro);
  const child = spawn(executable, [
    '-machine', 'pebble-emery',
    '-audiodev', 'driver=none,id=silent',
    '-global', 'pebble-audio.audiodev=silent',
    '-display', 'none',
    '-kernel', kernel,
    '-drive', `if=mtd,format=raw,snapshot=on,file=${flashPath}`,
    '-serial', 'null', '-serial', 'null', '-serial', `file:${serial}`,
    '-monitor', 'none', '-no-reboot',
  ], { stdio: 'ignore' });
  const exit = new Promise((resolveExit, reject) => {
    child.once('exit', resolveExit);
    child.once('error', reject);
  });
  try {
    for (let i = 0; i < 200; i++) {
      const bytes = await readFile(serial).catch(() => Buffer.alloc(0));
      if (bytes.length) return bytes;
      if (child.exitCode !== null) throw new Error(`Native QEMU exited before ${name} observation.`);
      await pause(25);
    }
    throw new Error(`Native QEMU produced no ${name} observation within five seconds.`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exit;
  }
}

async function browserCore(micro, flash) {
  const api = (await WebAssembly.instantiate(wasm, {})).instance.exports;
  const ptr = api.spike_upload(micro.length + flash.length);
  if (!ptr) throw new Error('Wasm allocation rejected.');
  new Uint8Array(api.memory.buffer, ptr, micro.length).set(micro);
  new Uint8Array(api.memory.buffer, ptr + micro.length, flash.length).set(flash);
  if (!api.spike_boot_profile(2, micro.length, flash.length)) throw new Error('Wasm boot rejected.');
  if (isWasmRunFailure(api.spike_run_until(10000, 640000)))
    throw new Error('Wasm bus fault in audio reference program.');
  const length = api.spike_uart_tx_len(2);
  return new Uint8Array(api.memory.buffer, api.spike_uart_tx_ptr(2), length).slice();
}

try {
  const flashPath = join(scratch, 'spi.bin');
  const file = await open(flashPath, 'w');
  await file.truncate(32 * 1024 * 1024);
  await file.close();
  const flash = new Uint8Array(32 * 1024 * 1024);
  const cases = [];
  for (const [name, irq, expected] of [
    ['initial-status', false, 1],
    ['irq-10', true, 0x49],
  ]) {
    const micro = image(irq);
    const [reference, candidate] = await Promise.all([
      native(name, micro, flashPath),
      browserCore(micro, flash),
    ]);
    const passed = reference[0] === expected && candidate[0] === expected;
    cases.push({ name, microSha256: hash(micro), expectedFirstUartByte: expected,
      nativeFirstUartByte: reference[0] ?? null, wasmFirstUartByte: candidate[0] ?? null,
      nativeObservedBytes: reference.length, passed });
  }
  const result = {
    format: 'pebble-audio-reference', version: 1,
    outcome: cases.every((x) => x.passed) ? 'match' : 'mismatch',
    target: 'pinned native generic QEMU register/initial-IRQ behavior',
    nativeQemuSha256: hash(binary), wasmSha256: hash(wasm), cases,
    limits: 'Synthetic firmware proves initial status and IRQ 10 delivery only; PCM drain timing and production app compatibility are not covered.',
  };
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== 'match') process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
