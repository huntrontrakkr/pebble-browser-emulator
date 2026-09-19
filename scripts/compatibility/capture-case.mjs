// One isolated process per case. Records observations; deliberately never decides compatibility.
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../../src/app/virtual-phone.ts';
import {
  PebbleTransport,
  encodeAppMessage,
  decodeAppMessage,
  encodeQemuPacket,
  diagnoseFirmwareLaunch,
} from '../../src/app/pebble-transport.ts';
import { appPackage, inspectPackage } from '../../src/app/archives.ts';
import { FIRMWARE_PROFILES, APP_PLATFORMS } from '../../src/app/watch-profiles.ts';
import { signalControl } from '../../src/app/signals.ts';
import { signalRoute } from '../../src/app/board-registry.ts';
import { sha, targetTicks } from './common.mjs';
import { compatibilitySignals } from './scenario.mjs';
import { isWasmRunFailure, wasmU32 } from '../../src/app/wasm-abi.ts';
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = resolve(job.out),
  profile = FIRMWARE_PROFILES[job.profile],
  platform = profile.platform;
const { width, height } = APP_PLATFORMS[platform];
mkdirSync(join(out, 'frames'), { recursive: true });
const fd = openSync(join(out, 'events.jsonl'), 'w'),
  consoleFd = openSync(join(out, 'console.txt'), 'w');
let eventBytes = 0,
  consoleBytes = 0,
  droppedEvents = 0,
  droppedConsoleBytes = 0,
  phase = 'package',
  api,
  transport,
  phone,
  serialTail = '',
  launchConsoleTail = '',
  launchDiagnostic = '',
  steps = 0,
  lastFrame = -1,
  frameIndex = 0,
  phoneOrigin = 0,
  pumping = false,
  stopped = false;
const frames = new Set(),
  phoneQueue = [],
  incoming = [];
const started = performance.now(),
  epoch = 1789545600;
const observations = {
  format: 'pebble-compatibility-observations',
  version: 1,
  profile: job.profile,
  platform,
  dimensions: { width, height },
  startedAt: new Date().toISOString(),
  scenarioCompleted: false,
  installed: false,
  phoneStarted: false,
  network: 'offline; real companion executes but no external requests or fabricated replies',
  configuration: 'showConfiguration and cancel lifecycle only; no settings DOM or save validation',
  executedInstructions: null,
  hardwareCycles: null,
  trace:
    '1000 scheduler-step window after each one-second sample; mask 7, capacity 32768; otherwise disabled',
  streamLimitBytes: 256 * 2 ** 20,
};
function event(type, data = {}) {
  const line =
    JSON.stringify({
      type,
      phase,
      virtualUs: api ? api.spike_ticks() / 64 : null,
      hostMs: performance.now() - started,
      ...data,
    }) + '\n';
  if (eventBytes + Buffer.byteLength(line) > 256 * 2 ** 20) {
    droppedEvents++;
    return;
  }
  writeSync(fd, line);
  eventBytes += Buffer.byteLength(line);
}
function recordJson(name, data) {
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');
}
function upload(bytes) {
  const ptr = api.spike_upload(bytes.length);
  if (!ptr) throw Error('Upload allocation rejected');
  new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
}
function clock() {
  return api.spike_ticks() / 64000;
}
function checkpoint(name) {
  const n = api.spike_checkpoint_save();
  if (!n) throw Error('Checkpoint allocation rejected');
  const bytes = Buffer.from(new Uint8Array(api.memory.buffer, api.spike_checkpoint_ptr(), n));
  writeFileSync(join(out, name + '.checkpoint.gz'), gzipSync(bytes, { level: 1 }));
  api.spike_checkpoint_clear();
  event('checkpoint', {
    name,
    sha256: sha(bytes),
    bytes: n,
    pc: api.spike_pc() >>> 0,
    xpsr: api.spike_xpsr() >>> 0,
  });
}
function frame() {
  const counter = api.spike_frame_counter();
  if (counter === lastFrame) return;
  lastFrame = counter;
  const bytes = Buffer.from(new Uint8Array(api.memory.buffer, api.spike_frame(), width * height)),
    hash = sha(bytes);
  if (!frames.has(hash)) {
    if (frames.size >= 5000) {
      event('frame-limit', { counter });
      return;
    }
    frames.add(hash);
    writeFileSync(join(out, 'frames', hash + '.gcolor8'), bytes);
  }
  event('frame', { counter, index: frameIndex++, sha256: hash, pc: api.spike_pc() >>> 0 });
}
function phoneEvents() {
  if (!phone) return;
  for (const e of phone.drainEvents()) {
    event('phone', { event: e });
    if (e.type === 'outbound') phoneQueue.push(e);
  }
}
async function advance(deadline = api.spike_ticks() + 640000, trace = false) {
  if (stopped || performance.now() - started > job.timeoutMs - 1000)
    throw Error(stopped ? 'Capture canceled' : 'Host capture deadline exceeded');
  if (trace) api.spike_trace_configure(7, 32768);
  let done;
  try {
    done = api.spike_run_until(trace ? 1000 : 50000, deadline);
  } finally {
    if (trace) {
      const n = api.spike_trace_export(),
        name = `trace-${Math.round(api.spike_ticks())}.bin`;
      writeFileSync(
        join(out, name),
        Buffer.from(new Uint8Array(api.memory.buffer, api.spike_trace_ptr(), n)),
      );
      event('trace', {
        path: name,
        bytes: n,
        dropped: api.spike_trace_dropped(),
        abi: api.spike_trace_version(),
      });
      api.spike_trace_configure(0, 0);
    }
  }
  if (isWasmRunFailure(done))
    throw Error(
      `Bus fault at 0x${wasmU32(api.spike_fault()).toString(16)}, PC 0x${wasmU32(api.spike_pc()).toString(16)}`,
    );
  steps += done;
  for (const port of [0, 1, 2]) {
    const n = api.spike_uart_tx_len(port);
    if (!n) continue;
    const bytes = Buffer.from(new Uint8Array(api.memory.buffer, api.spike_uart_tx_ptr(port), n));
    api.spike_uart_tx_consume(port, n);
    event('uart', { direction: 'watch', port, base64: bytes.toString('base64') });
    if (port === 1) transport.feedUart(bytes);
    if (port === 2) {
      serialTail = (serialTail + bytes.toString('utf8')).slice(-16384);
      if (phase === 'install') {
        launchConsoleTail = (launchConsoleTail + bytes.toString('utf8')).slice(-16384);
        if (!launchDiagnostic)
          launchDiagnostic = diagnoseFirmwareLaunch(launchConsoleTail) ?? '';
      }
      if (consoleBytes + n <= 256 * 2 ** 20) {
        writeSync(consoleFd, bytes);
        consoleBytes += n;
      } else droppedConsoleBytes += n;
    }
  }
  frame();
  if (phone) {
    phone.advanceTime(epoch * 1000 + Math.floor(clock() - phoneOrigin));
    phoneEvents();
  }
  if (incoming.length + phoneQueue.length > 1024) throw Error('Phone queue capture limit exceeded');
  await yieldTask();
}
async function writeUart(bytes) {
  event('uart', { direction: 'phone', port: 1, base64: Buffer.from(bytes).toString('base64') });
  let offset = 0;
  while (offset < bytes.length) {
    upload(bytes.subarray(offset));
    offset += api.spike_receive_uart(1, bytes.length - offset);
    if (offset < bytes.length) await advance();
  }
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    // Bound each turn, preserving all remaining messages for the next CPU quantum.
    for (let budget = 0; budget < 64 && (incoming.length || phoneQueue.length); budget++) {
      if (incoming.length) {
        const m = incoming.shift();
        if (m.kind === 'push') {
          let accepted = false;
          if (phone && m.uuid === observations.install.uuid) {
            try {
              phone.injectAppMessage(m.payload);
              accepted = true;
            } catch (e) {
              event('phone-delivery-error', { error: String(e) });
            }
          }
          await transport.send(0x30, Uint8Array.of(accepted ? 255 : 127, m.transactionId));
        } else phone?.acknowledgeAppMessage(m.transactionId, m.kind === 'ack');
        phoneEvents();
      }
      if (phoneQueue.length) {
        const e = phoneQueue.shift();
        await transport.send(0x30, encodeAppMessage(e.appId, e.transactionId, e.payload));
      }
    }
  } finally {
    pumping = false;
  }
}
async function wait(deadlineTicks, trace = false) {
  let first = trace;
  while (api.spike_ticks() < deadlineTicks) {
    await advance(Math.min(deadlineTicks, api.spike_ticks() + 640000), first);
    first = false;
    await pump();
  }
}
async function signal(value) {
  event('input-request', { signal: value });
  try {
    signalRoute(job.profile, value.kind);
    if (value.kind === 'buttons') api.spike_button(value.mask);
    else if (value.kind === 'touch') {
      if (!api.spike_touch(Number(value.down), value.x, value.y)) throw Error('Touch rejected');
    } else if (value.kind === 'location') {
      phone?.setLocation(value);
      phoneEvents();
      if (!phone) throw Error('No companion');
    } else {
      const control = signalControl(value);
      if (!control) throw Error('No signal encoding');
      await writeUart(encodeQemuPacket(control.channel, control.payload));
      if (value.kind === 'connection') phone?.setConnected(value.connected);
    }
    event('input-applied', { signal: value });
  } catch (e) {
    event('input-rejected', { signal: value, error: String(e) });
  }
}
process.on('SIGTERM', () => {
  stopped = true;
});
process.on('SIGINT', () => {
  stopped = true;
});
try {
  if (!job.pbw) throw Error('Package acquisition unavailable');
  const pbw = readFileSync(job.pbw);
  if (job.appSha256 && sha(pbw) !== job.appSha256) throw Error('Package hash mismatch');
  const info = inspectPackage(pbw);
  recordJson('package.json', {
    name: info.name,
    kind: info.kind,
    platforms: info.platforms,
    files: Object.entries(info.files).map(([path, b]) => ({
      path,
      bytes: b.length,
      sha256: sha(b),
    })),
    appinfo: info.files['appinfo.json']
      ? JSON.parse(new TextDecoder().decode(info.files['appinfo.json']))
      : null,
  });
  const parts = appPackage(pbw, platform);
  phase = 'boot';
  const wasm = readFileSync(job.wasm),
    micro = readFileSync(
      join(job.firmwareDir, `${job.profile}_v${job.firmwareVersion}_micro_flash.bin`),
    ),
    flash = readFileSync(
      join(job.firmwareDir, `${job.profile}_v${job.firmwareVersion}_spi_flash.bin`),
    );
  observations.identity = {
    appSha256: sha(pbw),
    wasmSha256: sha(wasm),
    microSha256: sha(micro),
    flashSha256: sha(flash),
    firmwareVersion: job.firmwareVersion,
    epoch,
    seed: 1,
  };
  api = (await WebAssembly.instantiate(wasm, {})).instance.exports;
  upload(Buffer.concat([micro, flash]));
  if (!api.spike_boot_profile(profile.id, micro.length, flash.length))
    throw Error('Firmware rejected');
  api.spike_set_epoch(epoch);
  transport = new PebbleTransport(
    { nowMs: clock, advance: () => advance(), writeUart },
    {
      diagnoseWaitFailure: (endpoint) =>
        endpoint === 0x34
          ? launchDiagnostic || diagnoseFirmwareLaunch(launchConsoleTail)
          : undefined,
      onPacket: (direction, packet) => {
        event('packet', {
          direction,
          endpoint: packet.endpoint,
          sequence: packet.sequence,
          base64: Buffer.from(packet.payload).toString('base64'),
        });
        if (direction === 'watch' && packet.endpoint === 0x30) {
          try {
            incoming.push(decodeAppMessage(packet.payload));
          } catch (e) {
            event('packet-decode-error', { error: String(e) });
          }
        }
      },
      onControl: (channel, payload) =>
        event('control', { channel, base64: Buffer.from(payload).toString('base64') }),
    },
  );
  while (!serialTail.includes('Ready for communication.')) await advance();
  checkpoint('boot');
  phase = 'install';
  launchConsoleTail = '';
  launchDiagnostic = '';
  await transport.setBluetooth(true);
  observations.install = await transport.install(parts, (p) => event('install-progress', p));
  observations.installed = true;
  checkpoint('installed');
  phase = 'phone-start';
  phoneOrigin = clock();
  if (parts.script) {
    phone = new VirtualPhone(await getQuickJS(), {
      appId: observations.install.uuid,
      nowMs: epoch * 1000,
      randomSeed: 1,
      messageKeys: parts.appinfo.appKeys ?? {},
      appInfo: parts.appinfo,
      watchInfo: {
        platform,
        model: profile.model,
        language: 'en_US',
        firmware: {
          major: Number(job.firmwareVersion.split('.')[0]),
          minor: Number(job.firmwareVersion.split('.')[1]),
          patch: Number(job.firmwareVersion.split('.')[2]),
          suffix: '',
        },
      },
      coordinates: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
      network: { mode: 'disabled' },
    });
    phone.setConnected(true);
    phone.start(parts.script);
    observations.phoneStarted = true;
    phoneEvents();
    await pump();
  }
  phase = 'scenario';
  const beganTicks = api.spike_ticks();
  for (let second = 0; second < job.durationMs / 1000; second++) {
    const events = compatibilitySignals(second, platform, width, height);
    for (const value of events) await signal(value);
    if (phone && second === 14) {
      event('configuration-request');
      phone.showConfiguration();
      phoneEvents();
    }
    if (phone && second === 15) {
      event('configuration-cancel', { accepted: phone.closeConfiguration(null) });
      phoneEvents();
    }
    await wait(targetTicks(beganTicks, Math.min(job.durationMs, (second + 1) * 1000)), true);
    event('sample', {
      schedulerSteps: steps,
      estimatedCpuCycles: api.spike_estimated_cpu_cycles(),
      completedFrames: api.spike_frame_counter(),
      pc: api.spike_pc() >>> 0,
      xpsr: api.spike_xpsr() >>> 0,
      rssBytes: process.memoryUsage().rss,
    });
  }
  observations.scenarioCompleted = true;
  phase = 'complete';
} catch (error) {
  observations.exception = { phase, message: String(error), stack: error.stack };
  event('exception', observations.exception);
} finally {
  if (api) {
    try {
      checkpoint('terminal');
      frame();
    } catch (error) {
      event('checkpoint-error', { error: String(error) });
    }
  }
  if (phone) {
    try {
      phoneEvents();
      recordJson('phone-storage.json', phone.getStorage());
      phone.dispose();
    } catch (error) {
      event('phone-dispose-error', { error: String(error) });
    }
  }
  transport?.dispose();
  Object.assign(observations, {
    finishedAt: new Date().toISOString(),
    phase,
    hostMs: performance.now() - started,
    virtualUs: api ? api.spike_ticks() / 64 : null,
    schedulerSteps: steps,
    estimatedCpuCycles: api ? api.spike_estimated_cpu_cycles() : null,
    uniqueFrames: frames.size,
    frameRecords: frameIndex,
    droppedEvents,
    droppedConsoleBytes,
    resourceUsage: process.resourceUsage(),
    memory: process.memoryUsage(),
  });
  closeSync(fd);
  closeSync(consoleFd);
  recordJson('observations.json', observations);
}
