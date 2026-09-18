// Local, unchanged firmware execution with explicit identities and bounded diagnostics.
// This is an internal-consistency/reference capture runner, not physical validation.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { PebbleTransport } from '../src/app/pebble-transport.ts';
import { appPackage } from '../src/app/archives.ts';
import { FIRMWARE_PROFILES, APP_PLATFORMS } from '../src/app/watch-profiles.ts';
import {
  canonicalJson,
  validateFidelityRun,
  decodeCoreTrace,
  compareFidelityRuns,
} from '../src/app/fidelity-evidence.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/fidelity-run');
await mkdir(out, { recursive: true });
if (process.argv[2] === '--compare') {
  const [reference, candidate, tolerance] = process.argv.slice(3);
  if (!reference || !candidate)
    throw new Error('Usage: --compare REFERENCE_JSON CANDIDATE_JSON [TIMING_TOLERANCE_US]');
  const report = compareFidelityRuns(
    JSON.parse(await readFile(reference)),
    JSON.parse(await readFile(candidate)),
    tolerance === undefined ? undefined : Number(tolerance),
  );
  await writeFile(resolve(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome !== 'match') process.exitCode = 1;
} else {
  await capture();
}

async function capture() {
  // A missing prerequisite must never leave a previous successful run at the
  // advertised output path. Only remove this runner's known report files.
  for (const name of [
    'run.json',
    'prerequisites.json',
    'scenario.json',
    'metrics.json',
    'trace.json',
    'workload.json',
    'mmio-probe.json',
    'console.txt',
  ])
    await rm(resolve(out, name), { force: true });
  const profile = process.env.PEBBLE_PROFILE ?? 'qemu_emery';
  if (!Object.hasOwn(FIRMWARE_PROFILES, profile))
    throw new Error(
      'Only implemented generic profiles can execute. Physical boards are not supported.',
    );
  const version = process.env.PEBBLE_FIRMWARE_VERSION ?? '4.37.0';
  const platform = FIRMWARE_PROFILES[profile].platform;
  const { width, height } = APP_PLATFORMS[platform];
  function bounded(name, fallback, min, max) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error('Invalid ' + name);
    return value;
  }
  const scenario = {
    version: 1,
    seed: 1,
    epoch: 1789545600,
    durationMs: bounded('PEBBLE_SCENARIO_MS', 10000, 1000, 600000),
    switches: bounded('PEBBLE_SWITCHES', 1, 0, 20),
    touch:
      platform === 'flint'
        ? null
        : { x: Math.min(100, width - 1), y: Math.min(182, height - 1), atMs: 1000, heldMs: 100 },
    transportQuantumUs: 10000,
    diagnosticSteps: 1000,
  };
  const inputs = {
    micro:
      process.env.PEBBLE_FIRMWARE_DIR &&
      resolve(process.env.PEBBLE_FIRMWARE_DIR, `${profile}_v${version}_micro_flash.bin`),
    flash:
      process.env.PEBBLE_FIRMWARE_DIR &&
      resolve(process.env.PEBBLE_FIRMWARE_DIR, `${profile}_v${version}_spi_flash.bin`),
    app: process.env.PEBBLE_APP_PBW ?? `public/examples/clock-${platform}.pbw`,
    clock: `public/examples/clock-${platform}.pbw`,
    wasm: process.env.PEBBLE_WASM ?? 'public/wasm/qemu-emery.wasm',
  };
  const bytes = {};
  try {
    for (const [key, path] of Object.entries(inputs)) {
      if (!path) throw new Error('Set PEBBLE_FIRMWARE_DIR to locally supplied firmware.');
      bytes[key] = await readFile(path);
    }
  } catch (error) {
    const unavailable = {
      format: 'pebble-fidelity-prerequisites',
      version: 1,
      outcome: 'not-run',
      reason: error.message,
    };
    await writeFile(
      resolve(out, 'prerequisites.json'),
      JSON.stringify(unavailable, null, 2) + '\n',
    );
    console.log(JSON.stringify(unavailable));
    process.exitCode = 2;
    return;
  }
  const run = {
    format: 'pebble-fidelity-run',
    version: 1,
    identity: {
      board: profile,
      revision: 'generic',
      firmwareVersion: version,
      firmware: { 'micro-flash': hash(bytes.micro), 'spi-flash': hash(bytes.flash) },
      appSha256: hash(bytes.app),
      scenarioSha256: hash(canonicalJson({ ...scenario, replacementAppSha256: hash(bytes.clock) })),
      seed: scenario.seed,
      initialState: 'cold boot; RTC epoch=' + scenario.epoch,
    },
    implementation: {
      name: 'Rust/Wasm generic board',
      version: 'trace-abi-1',
      sha256: hash(bytes.wasm),
    },
    referenceTarget: 'internal-consistency',
    captureMethod:
      'Completed guest frames and full machine-state hashes at named virtual-time checkpoints; no QuickJS companion or live network.',
    outcome: 'failed',
    complete: false,
    droppedEvents: 0,
    observations: [],
  };
  let api,
    transport,
    serial = '',
    steps = 0,
    canceled = false,
    fatalConsoleReported = false;
  const started = performance.now();
  const maximumMs = bounded('PEBBLE_HOST_TIMEOUT_MS', 180000, 1000, 3600000);
  const metrics = [],
    diagnostics = [],
    workload = [];
  const probeMs = bounded('PEBBLE_MMIO_PROBE_MS', 0, 0, 1000);
  const probeEachSample = bounded('PEBBLE_MMIO_PROBE_EACH_SAMPLE', 0, 0, 1) === 1;
  const probeWindows = [];
  const probedPhases = new Set();
  let activeProbe = null;
  const cancel = () => {
    canceled = true;
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  function upload(data) {
    const ptr = api.spike_upload(data.length);
    if (!ptr) throw new Error('Upload allocation rejected.');
    new Uint8Array(api.memory.buffer, ptr, data.length).set(data);
  }
  function clockMs() {
    return api.spike_ticks() / 64000;
  }
  async function advance(count = 50000, deadline = api.spike_ticks() + 640000) {
    if (canceled || performance.now() - started > maximumMs)
      throw new Error(canceled ? 'Run canceled.' : 'Host execution deadline exceeded.');
    const done = api.spike_run_until(count, deadline);
    if (done === 0xffffffff)
      throw new Error(
        `Bus fault at 0x${api.spike_fault().toString(16)}, PC 0x${api.spike_pc().toString(16)}`,
      );
    steps += done;
    if (activeProbe) {
      const length = api.spike_trace_export();
      const records = decodeCoreTrace(
        new Uint8Array(api.memory.buffer, api.spike_trace_ptr(), length),
        api.spike_trace_version(),
      );
      for (const event of records) {
        const key = `${event.kind}:${event.address}`;
        let entry = activeProbe.addresses.get(key);
        if (!entry) {
          if (activeProbe.addresses.size >= 512)
            throw new Error('MMIO probe exceeded 512 distinct access types/addresses.');
          entry = {
            kind: event.kind,
            address: event.address,
            count: 0,
            firstPc: event.pc,
            lastPc: event.pc,
            firstValue: event.value,
            lastValue: event.value,
            firstVirtualUs: event.ticks / 64,
            lastVirtualUs: event.ticks / 64,
          };
          activeProbe.addresses.set(key, entry);
        }
        entry.count++;
        entry.lastPc = event.pc;
        entry.lastValue = event.value;
        entry.lastVirtualUs = event.ticks / 64;
        activeProbe.events++;
      }
      const dropped = api.spike_trace_dropped();
      activeProbe.droppedEvents += dropped;
      run.droppedEvents += dropped;
      if (!api.spike_trace_configure(1, 32768))
        throw new Error('MMIO probe reset rejected.');
    }
    for (const port of [1, 2]) {
      const length = api.spike_uart_tx_len(port);
      const data = new Uint8Array(api.memory.buffer, api.spike_uart_tx_ptr(port), length).slice();
      api.spike_uart_tx_consume(port, length);
      if (port === 1) transport.feedUart(data);
      else if (data.length) {
        serial = (serial + new TextDecoder().decode(data)).slice(-1024 * 1024);
        if (!fatalConsoleReported && /service_system_task: System task queue full|Resetting!/i.test(serial.slice(-4096))) {
          fatalConsoleReported = true;
          throw new Error(`Firmware reported system task queue overflow/reset at ${clockMs()} virtual ms.`);
        }
      }
    }
    await yieldTask();
  }
  async function waitUntil(ms) {
    // The Wasm deadline is an integer tick. Comparing rounded millisecond values
    // can otherwise spin forever one tick below, or even at, that deadline.
    const deadlineTicks = Math.round(ms * 64000);
    while (api.spike_ticks() < deadlineTicks)
      await advance(50000, Math.min(deadlineTicks, api.spike_ticks() + 640000));
  }
  async function probeOperation(phase, operation) {
    activeProbe = {
      phase,
      fromVirtualUs: api.spike_ticks() / 64,
      addresses: new Map(),
      events: 0,
      droppedEvents: 0,
    };
    if (!api.spike_trace_configure(1, 32768))
      throw new Error('MMIO probe configuration rejected.');
    try {
      await operation();
    } finally {
      api.spike_trace_configure(0, 0);
      probeWindows.push({
        phase: activeProbe.phase,
        fromVirtualUs: activeProbe.fromVirtualUs,
        toVirtualUs: api.spike_ticks() / 64,
        events: activeProbe.events,
        droppedEvents: activeProbe.droppedEvents,
        addresses: [...activeProbe.addresses.values()].sort(
          (a, b) => b.count - a.count || a.address - b.address,
        ),
      });
      activeProbe = null;
    }
  }
  async function sampleUntil(ms, phase) {
    const fromVirtualUs = api.spike_ticks() / 64;
    const fromSteps = steps;
    const fromEstimatedCpuCycles = api.spike_estimated_cpu_cycles();
    const fromFrames = api.spike_frame_counter();
    const fromHostMs = performance.now();
    if (probeMs && (probeEachSample || !probedPhases.has(phase))) {
      probedPhases.add(phase);
      const startMs = clockMs();
      await probeOperation(phase, () => waitUntil(Math.min(ms, startMs + probeMs)));
    }
    await waitUntil(ms);
    workload.push({
      phase,
      targetVirtualMs: ms,
      fromVirtualUs,
      toVirtualUs: api.spike_ticks() / 64,
      schedulerSteps: steps - fromSteps,
      estimatedCpuCycles: api.spike_estimated_cpu_cycles() - fromEstimatedCpuCycles,
      completedFrames: api.spike_frame_counter() - fromFrames,
      hostElapsedMs: performance.now() - fromHostMs,
      executedInstructions: null,
      hardwareCycles: null,
    });
  }
  function captureCheckpoint(name) {
    const length = api.spike_checkpoint_save();
    if (!length) throw new Error('Checkpoint capture rejected.');
    const stateHash = hash(new Uint8Array(api.memory.buffer, api.spike_checkpoint_ptr(), length));
    api.spike_checkpoint_clear();
    const frameHash = hash(new Uint8Array(api.memory.buffer, api.spike_frame(), width * height));
    run.observations.push({
      checkpoint: name,
      virtualUs: api.spike_ticks() / 64,
      values: {
        stateSha256: stateHash,
        frameSha256: frameHash,
        pc: api.spike_pc() >>> 0,
        xpsr: api.spike_xpsr() >>> 0,
      },
    });
    metrics.push({
      checkpoint: name,
      schedulerSteps: steps,
      estimatedCpuCycles: api.spike_estimated_cpu_cycles(),
      virtualUs: api.spike_ticks() / 64,
      hostElapsedMs: performance.now() - started,
      executedInstructions: null,
      hardwareCycles: null,
    });
    console.log(
      JSON.stringify({
        checkpoint: name,
        virtualMs: clockMs(),
        hostMs: Math.round(performance.now() - started),
      }),
    );
  }
  async function diagnosticWindow() {
    if (process.env.PEBBLE_TRACE === '0') {
      await advance(scenario.diagnosticSteps, Number.MAX_SAFE_INTEGER);
      return;
    }
    if (!api.spike_trace_configure(7, 32768)) throw new Error('Trace configuration rejected.');
    await advance(scenario.diagnosticSteps, Number.MAX_SAFE_INTEGER);
    const length = api.spike_trace_export();
    diagnostics.push(
      ...decodeCoreTrace(
        new Uint8Array(api.memory.buffer, api.spike_trace_ptr(), length),
        api.spike_trace_version(),
      ),
    );
    run.droppedEvents += api.spike_trace_dropped();
    api.spike_trace_configure(0, 0);
  }
  try {
    api = (await WebAssembly.instantiate(bytes.wasm, {})).instance.exports;
    if (api.spike_trace_version?.() !== 1)
      throw new Error('Build the current Wasm trace ABI first.');
    upload(Buffer.concat([bytes.micro, bytes.flash]));
    if (
      !api.spike_boot_profile(FIRMWARE_PROFILES[profile].id, bytes.micro.length, bytes.flash.length)
    )
      throw new Error('Firmware rejected.');
    api.spike_set_epoch(scenario.epoch);
    transport = new PebbleTransport({
      nowMs: clockMs,
      advance: () => advance(),
      writeUart: async (data) => {
        let offset = 0;
        while (offset < data.length) {
          upload(data.subarray(offset));
          offset += api.spike_receive_uart(1, data.length - offset);
          if (offset < data.length) await advance();
        }
      },
    });
    while (!serial.includes('Ready for communication.')) await advance();
    captureCheckpoint('boot');
    await transport.setBluetooth(true);
    if (probeMs)
      await probeOperation('initial-install', () => transport.install(appPackage(bytes.app, platform)));
    else await transport.install(appPackage(bytes.app, platform));
    captureCheckpoint('installed');
    const began = clockMs();
    if (scenario.touch) {
      await sampleUntil(began + scenario.touch.atMs, 'before-touch');
      api.spike_touch(1, scenario.touch.x, scenario.touch.y);
      await sampleUntil(began + scenario.touch.atMs + scenario.touch.heldMs, 'touch-held');
      api.spike_touch(0, scenario.touch.x, scenario.touch.y);
    }
    for (
      let offset = (Math.floor((clockMs() - began) / 1000) + 1) * 1000;
      offset < scenario.durationMs;
      offset += 1000
    )
      await sampleUntil(began + offset, scenario.touch ? 'after-touch' : 'no-touch');
    if (clockMs() < began + scenario.durationMs)
      await sampleUntil(began + scenario.durationMs, scenario.touch ? 'after-touch' : 'no-touch');
    await diagnosticWindow();
    captureCheckpoint('interaction');
    for (let i = 0; i < scenario.switches; i++) {
      await transport.install(appPackage(bytes.clock, platform));
      captureCheckpoint(`clock-${i + 1}`);
      await transport.install(appPackage(bytes.app, platform));
      captureCheckpoint(`app-${i + 1}`);
    }
    if (/callback queue.*full|queue is full|rebooting|core dump/i.test(serial))
      throw new Error('Firmware reported queue overflow or reset; inspect console.');
    if (run.droppedEvents) throw new Error('Diagnostic trace overflowed.');
    run.outcome = 'passed';
    run.complete = true;
  } catch (error) {
    run.reason = error.message;
    process.exitCode = 1;
    if (api && transport) {
      try {
        await diagnosticWindow();
        captureCheckpoint('failure');
      } catch {
        /* Preserve original failure. */
      }
    }
  } finally {
    transport?.dispose();
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    validateFidelityRun(run);
    for (const [name, value] of Object.entries({
      run,
      scenario,
      metrics,
      trace: diagnostics,
      workload,
    }))
      await writeFile(resolve(out, name + '.json'), JSON.stringify(value, null, 2) + '\n');
    if (probeMs)
      await writeFile(
        resolve(out, 'mmio-probe.json'),
        JSON.stringify(
          {
            format: 'pebble-mmio-probe',
            version: 1,
            identity: run.identity,
            windowMs: probeMs,
            windows: probeWindows,
          },
          null,
          2,
        ) + '\n',
      );
    await writeFile(resolve(out, 'console.txt'), serial);
    console.log(
      JSON.stringify({
        outcome: run.outcome,
        reason: run.reason,
        report: resolve(out, 'run.json'),
      }),
    );
  }
}
