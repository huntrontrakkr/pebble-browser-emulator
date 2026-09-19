import { FIRMWARE_PROFILES, isFirmwareProfile, type FirmwareProfile } from './watch-profiles.ts';
/// <reference lib="webworker" />
import {
  PebbleTransport,
  encodeAppMessage,
  decodeAppMessage,
  diagnoseFirmwareLaunch,
} from './pebble-transport.ts';
import { appPackage } from './archives.ts';
import type { MachineStateUpdate } from './emulator.types.ts';
import { encodeQemuPacket } from './pebble-transport.ts';
import {
  normalizeScenario,
  normalizeSignal,
  SignalTimeline,
  signalControl,
  type DeviceSignal,
} from './signals.ts';
import { UartWriter } from './uart-writer.ts';
import { healthPreferences } from './watch-preferences.ts';
import { ClockBarrier } from './clock-barrier.ts';
import { signalRoute } from './board-registry.ts';
import { PresentationBudget, yieldWorker } from './worker-scheduler.ts';
import { DemoSignalStream, normalizeDemoSettings } from './demo-settings.ts';
import { wristShake } from './watch-gestures.ts';
import { mergeDueSignals } from './scheduled-inputs.ts';
import { demoRecords, type DemoRecord } from './demo-timeline.ts';
import { bytesHash } from './resource-cache.ts';
import { isWasmRunFailure, wasmU32 } from './wasm-abi.ts';
import {
  startupIdentity,
  loadStartupCheckpoint,
  saveStartupCheckpoint,
  type StartupIdentity,
  type StartupCheckpoint,
} from './startup-checkpoint.ts';
let coreHash = '',
  checkpointBase = '';
let startupOwner: StartupIdentity | undefined;
let exportStartup = false,
  announceReady = false;
let bootController: AbortController | undefined;
let bootRevision = 0;
let api: any,
  running = false,
  loaded = false,
  name = '',
  steps = 0,
  buttons = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  lastFrame = -1;
let profile: FirmwareProfile = 'qemu_emery';
const decoder = new TextDecoder();
let transport: PebbleTransport | undefined,
  firmwareReady = false,
  consoleTail = '',
  launchConsoleTail = '',
  launchDiagnostic = '',
  installing = false,
  generation = 0,
  linked = false,
  battery = 100,
  charging = false;
const yieldTask = yieldWorker;
const presentation = new PresentationBudget();
let deltaFrames = false;
let lastClock = -Infinity;
let batchSize = 50000;
let cpuMs = 1;
let realtime = false;
let paceStart: { wall: number; virtual: number } | undefined;
const timeline = new SignalTimeline();
const gesture = new SignalTimeline();
const demoStream = new DemoSignalStream();
let demoApplying = false;
const demoOwned = new Map<string, Pick<DemoRecord, 'database' | 'key'>>();
const uartWriter = new UartWriter();
let scenarioName = '';
let phoneCoupled = false;
let clockPort: MessagePort | undefined;
let phoneNeedsUi = false;
let runSequence = 0;
const phoneClock = new ClockBarrier();
function closeClockPort() {
  clockPort?.close();
  clockPort = undefined;
  phoneClock.clear();
  phoneNeedsUi = false;
}
function connectClockPort(port?: MessagePort) {
  closeClockPort();
  clockPort = port;
  if (!port) return;
  const owner = generation;
  port.onmessage = ({ data }) => {
    if (clockPort !== port || owner !== generation || !phoneCoupled) return;
    if (data.type === 'clock-ack' && data.transportGeneration === generation)
      phoneClock.acknowledge(data.sequence);
  };
}
let cpuPump: Promise<unknown> = Promise.resolve();
function flushUart() {
  uartWriter.flush((bytes) => {
    upload(bytes);
    return api.spike_receive_uart(1, bytes.length);
  });
}
function validateDeviceSignal(signal: DeviceSignal) {
  signalRoute(profile, signal.kind);
  if (signal.kind === 'touch') {
    if (signal.x >= api.spike_frame_width() || signal.y >= api.spike_frame_height())
      throw new Error('Touch coordinates are outside the display.');
  }
}
function applySignal(value: DeviceSignal, scheduledUs = api.spike_ticks() / 64) {
  const signal = normalizeSignal(value);
  validateDeviceSignal(signal);
  const report = (stage: string) =>
    postMessage({
      type: 'signal',
      generation,
      signal,
      scheduledUs,
      actualUs: api.spike_ticks() / 64,
      stage,
    });
  if (signal.kind === 'location' || signal.kind === 'location-error') {
    phoneNeedsUi = true;
    postMessage({
      type: 'phone-signal',
      generation,
      signal,
      virtualUs: api.spike_ticks() / 64,
      epochMs: api.spike_epoch_ms(),
    });
    report('forwarded to phone');
    return;
  }
  if (!firmwareReady) throw new Error('Wait for firmware boot before sending a signal.');
  if (signal.kind === 'touch') {
    if (!api.spike_touch(Number(signal.down), signal.x, signal.y))
      throw new Error('Touch input was rejected by the board.');
    report('applied to controller');
    return;
  }
  if (signal.kind === 'buttons') {
    buttons = signal.mask;
    api.spike_button(buttons);
    report('applied to GPIO');
    return;
  }
  const control = signalControl(signal);
  if (!control) throw new Error('No device route for this signal.');
  uartWriter.enqueue(encodeQemuPacket(control.channel, control.payload), () => {
    report('written to UART');
    if (signal.kind === 'battery') {
      battery = signal.percent;
      charging = signal.charging;
    }
    if (signal.kind === 'connection') {
      linked = signal.connected;
      phoneNeedsUi = true;
      postMessage({ type: 'connection', connected: linked });
    }
  });
  report('queued');
  flushUart();
}
function tick(count = 100000): Promise<number> {
  const owner = generation;
  const task = cpuPump.then(() => {
    if (owner !== generation) throw new Error('Firmware operation canceled.');
    return tickOnce(count);
  });
  cpuPump = task.catch(() => {});
  return task;
}
function flushScheduledSignals() {
  const now = api.spike_ticks() / 64;
  const gestureActive = gesture.pending > 0;
  for (const event of mergeDueSignals(
    demoStream.takeDue(now),
    timeline.takeDue(now),
    gesture.takeDue(now),
    gestureActive,
  ))
    applySignal(event.signal, event.atUs);
}
async function tickOnce(count: number) {
  const began = performance.now();
  let remaining = count;
  const quantumEnd =
    api.spike_ticks() +
    (phoneCoupled
      ? 640000
      : realtime && firmwareReady
        ? 1280000
        : Number.MAX_SAFE_INTEGER - api.spike_ticks());
  while (remaining > 0) {
    flushScheduledSignals();
    flushUart();
    const deadline = Math.min(
      quantumEnd,
      Math.round(timeline.nextUs * 64),
      Math.round(demoStream.nextUs * 64),
      Math.round(gesture.nextUs * 64),
    );
    // Service pending UART envelopes promptly without interleaving their bytes.
    const done = api.spike_run_until(
      Math.min(remaining, uartWriter.pending ? 1000 : remaining),
      deadline,
    );
    if (isWasmRunFailure(done))
      throw new Error(`QEMU bus fault at 0x${wasmU32(api.spike_fault()).toString(16)}`);
    steps += done;
    remaining -= done;
    serial();
    if (api.spike_ticks() >= quantumEnd) break;
    if (
      !done &&
      Math.min(timeline.nextUs, demoStream.nextUs, gesture.nextUs) > api.spike_ticks() / 64
    )
      break;
  }
  flushScheduledSignals();
  flushUart();
  if (announceReady) {
    announceReady = false;
    if (startupOwner) {
      try {
        if (linked || installing || demoApplying || phoneCoupled || uartWriter.pending)
          throw new Error('Startup state is no longer isolated.');
        const length = api.spike_checkpoint_save();
        if (!length) throw new Error('Firmware startup could not be captured.');
        let machine: Uint8Array;
        try {
          machine = new Uint8Array(api.memory.buffer, api.spike_checkpoint_ptr(), length).slice();
        } finally {
          api.spike_checkpoint_clear();
        }
        const checkpoint: StartupCheckpoint = {
          version: 1,
          identity: startupOwner,
          steps,
          transport: transport!.startupState(),
          machine,
        };
        if (exportStartup)
          postMessage({ type: 'startup-checkpoint', checkpoint }, [machine.buffer]);
        else {
          const owner = generation;
          void saveStartupCheckpoint(checkpoint)
            .then(() => {
              if (owner === generation)
                postMessage({
                  type: 'startup-status',
                  message: 'Startup state saved on this device.',
                });
            })
            .catch(() => {});
        }
      } catch (error) {
        postMessage({
          type: 'startup-status',
          message: 'Startup cache unavailable: ' + String((error as Error).message),
        });
      }
      startupOwner = undefined;
    }
    postMessage({ type: 'firmware-ready' });
  }
  const frame = api.spike_frame_counter();
  const phase = phoneCoupled ? phoneClock.begin() : undefined;
  // If this quantum emitted time-sensitive events through the UI, its clock
  // follows those events on the same ordered channel. Idle quanta bypass the UI.
  const direct = !!(phase && clockPort && !phoneNeedsUi);
  phoneNeedsUi = false;
  const clock = { epochMs: api.spike_epoch_ms(), virtualUs: api.spike_ticks() / 64 };
  if (direct)
    clockPort!.postMessage({
      type: 'clock',
      ...clock,
      sequence: phase!.sequence,
      transportGeneration: generation,
    });
  if ((phase && !direct) || performance.now() - lastClock >= 100) {
    lastClock = performance.now();
    postMessage({
      type: 'clock',
      generation,
      ...clock,
      direct,
      ...(phase && !direct ? { sequence: phase.sequence } : {}),
    });
  }
  state(false);
  cpuMs = Math.max(0.1, performance.now() - began);
  if (phase) await phase.done;
  return frame;
}
function createTransport() {
  return new PebbleTransport(
    {
      nowMs: () => api.spike_ticks() / 64000,
      advance: async () => {
        await tick();
        await yieldTask();
      },
      writeUart: async (bytes) => {
        const current = generation;
        let complete = false;
        uartWriter.enqueue(bytes, () => {
          complete = true;
        });
        while (!complete) {
          if (current !== generation) throw new Error('Firmware operation canceled.');
          flushUart();
          if (!complete) {
            await tick(50000);
            await yieldTask();
          }
        }
      },
    },
    {
      diagnoseWaitFailure: (endpoint) =>
        endpoint === 0x34
          ? launchDiagnostic || diagnoseFirmwareLaunch(launchConsoleTail)
          : undefined,
      onControl: (channel, payload) => {
        postMessage({
          type: 'control',
          generation,
          channel,
          bytes: payload,
          virtualSeconds: api.spike_ticks() / 64000000,
        });
        if (channel === 7 && payload.length === 1)
          postMessage({
            type: 'device-output',
            generation,
            kind: 'vibration',
            value: payload[0] !== 0,
            virtualUs: api.spike_ticks() / 64,
          });
      },
      onPacket: (direction, packet) => {
        postMessage({
          type: 'protocol',
          direction,
          endpoint: packet.endpoint,
          bytes: packet.payload,
          virtualSeconds: api.spike_ticks() / 64000000,
        });
        if (direction === 'watch' && packet.endpoint === 0x30) {
          phoneNeedsUi = true;
          try {
            postMessage({
              type: 'appmessage',
              generation,
              message: decodeAppMessage(packet.payload),
            });
          } catch (e) {
            postMessage({ type: 'error', message: String(e) });
          }
        }
      },
    },
  );
}
function upload(bytes: Uint8Array) {
  const p = api.spike_upload(bytes.length);
  if (!p) throw new Error('Image exceeds the emulator upload limit.');
  new Uint8Array(api.memory.buffer, p, bytes.length).set(bytes);
}
function stop() {
  runSequence++;
  paceStart = undefined;
  running = false;
  clearTimeout(timer);
}
function serial() {
  for (let port = 0; port < 3; port++) {
    const n = api.spike_uart_tx_len(port);
    if (!n) continue;
    const bytes = new Uint8Array(api.memory.buffer, api.spike_uart_tx_ptr(port), n).slice();
    api.spike_uart_tx_consume(port, n);
    if (port === 1) transport?.feedUart(bytes);
    if (port === 2) {
      const text = decoder.decode(bytes, { stream: true });
      consoleTail = (consoleTail + text).slice(-16384);
      if (installing) {
        launchConsoleTail = (launchConsoleTail + text).slice(-16384);
        if (!launchDiagnostic)
          launchDiagnostic = diagnoseFirmwareLaunch(launchConsoleTail) ?? '';
      }
      if (!firmwareReady && consoleTail.includes('Ready for communication.')) {
        firmwareReady = true;
        announceReady = true;
      }
      postMessage({ type: 'serial', port, bytes, text }, [bytes.buffer]);
    }
  }
}
function state(force = true) {
  if (!loaded) return;
  const address = wasmU32(api.spike_fault()),
    fault = api.spike_faulted()
      ? `Bus ${api.spike_fault_write() ? 'write' : 'read'} at 0x${address.toString(16)}; PC 0x${wasmU32(api.spike_fault_pc()).toString(16)}`
      : '';
  if (fault) stop();
  const frame = api.spike_frame_counter();
  if (!presentation.due(performance.now(), frame !== lastFrame, force || !!fault)) return;
  const framebuffer =
    !deltaFrames || force || !!fault || frame !== lastFrame
      ? new Uint8Array(api.memory.buffer, api.spike_frame(), api.spike_frame_len()).slice()
      : undefined;
  lastFrame = frame;
  const value: MachineStateUpdate = {
    registers: Array.from({ length: 16 }, (_, i) => wasmU32(api.spike_register(i))),
    flags: wasmU32(api.spike_xpsr()),
    instructions: steps,
    halted: !!fault,
    running,
    loaded,
    programName: name,
    inputRevision: 0,
    fault,
    framebuffer,
    buttons,
    battery,
  };
  postMessage(
    {
      type: 'state',
      generation,
      state: value,
      profile,
      virtualSeconds: api.spike_ticks() / 64000000,
      firmwareReady,
      linked,
      installing,
      charging,
      scenario: { name: scenarioName, pending: timeline.pending },
    },
    framebuffer ? [framebuffer.buffer] : [],
  );
}
async function batch() {
  if (!running || installing || demoApplying) return;
  const owner = generation;
  const loop = runSequence;
  try {
    await tick(batchSize);
    if (owner !== generation || loop !== runSequence || !running) return;
    batchSize = Math.max(10000, Math.min(250000, Math.round(batchSize * Math.min(2, 8 / cpuMs))));
    if (realtime && firmwareReady) {
      const wall = performance.now(),
        virtual = api.spike_ticks() / 64000;
      paceStart ??= { wall, virtual };
      const delay = virtual - paceStart.virtual - (wall - paceStart.wall);
      if (delay > 1) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 100)));
    }
    await yieldWorker();
    if (owner === generation && loop === runSequence && running) void batch();
  } catch (e) {
    if (owner !== generation) return;
    stop();
    postMessage({ type: 'error', message: String(e) });
    state();
  }
}
function resetSession() {
  generation++;
  closeClockPort();
  phoneCoupled = false;
  paceStart = undefined;
  cpuPump = Promise.resolve();
  timeline.clear();
  gesture.clear();
  demoStream.stop();
  demoApplying = false;
  uartWriter.clear();
  scenarioName = '';
  postMessage({ type: 'session', generation });
  transport?.dispose();
  transport = createTransport();
  loaded = true;
  steps = 0;
  buttons = 0;
  lastFrame = -1;
  firmwareReady = false;
  announceReady = false;
  startupOwner = undefined;
  consoleTail = '';
  launchConsoleTail = '';
  launchDiagnostic = '';
  linked = false;
  installing = false;
  battery = 100;
  charging = false;
  postMessage({ type: 'connection', connected: false });
  postMessage({ type: 'install-status', busy: false, message: '' });
  state();
}
function boot(
  candidate: { micro: Uint8Array; flash: Uint8Array; profile?: FirmwareProfile },
  candidateName: string,
) {
  const selected = candidate.profile ?? 'qemu_emery';
  if (!isFirmwareProfile(selected)) throw new Error('Unsupported firmware profile.');
  stop();
  const length = candidate.micro.length + candidate.flash.length;
  const pointer = api.spike_upload(length);
  if (!pointer) throw new Error('Firmware exceeds the emulator upload limit.');
  const destination = new Uint8Array(api.memory.buffer, pointer, length);
  destination.set(candidate.micro);
  destination.set(candidate.flash, candidate.micro.length);
  if (
    !api.spike_boot_profile(
      FIRMWARE_PROFILES[selected].id,
      candidate.micro.length,
      candidate.flash.length,
    )
  )
    throw new Error('Firmware vector table or image sizes are not valid for ' + selected + '.');
  profile = selected;
  name = candidateName;
  api.spike_set_epoch(Date.now() / 1000);
  postMessage({ type: 'firmware-loaded', profile, name });
  resetSession();
}
function restart() {
  bootController?.abort();
  bootRevision++;
  if (!loaded) throw new Error('Load firmware first.');
  stop();
  if (!api.spike_restart()) throw new Error('The loaded watch could not restart.');
  resetSession();
}
async function bootWithStartup(data: any) {
  bootController?.abort();
  const controller = new AbortController();
  bootController = controller;
  const revision = ++bootRevision;
  stop();
  // Invalidate earlier installation/phone-clock awaits before asynchronous loading.
  generation++;
  closeClockPort();
  phoneCoupled = false;
  transport?.dispose();
  transport = undefined;
  loaded = false;
  postMessage({ type: 'session', generation });
  try {
    const selected = data.profile;
    if (!isFirmwareProfile(selected)) throw new Error('Unsupported firmware profile.');
    let identity: StartupIdentity | undefined;
    let restored: Awaited<ReturnType<typeof loadStartupCheckpoint>>;
    try {
      identity = await startupIdentity(selected, coreHash, data.micro, data.flash);
      controller.signal.throwIfAborted();
      if (!data.exportStartup)
        restored = await loadStartupCheckpoint(identity, checkpointBase, controller.signal);
    } catch {
      controller.signal.throwIfAborted();
      postMessage({
        type: 'startup-status',
        message: 'Using normal boot; prepared startup state is unavailable or incompatible.',
      });
    }
    if (revision !== bootRevision || controller.signal.aborted) return;
    if (restored) {
      try {
        const candidateTransport = createTransport();
        candidateTransport.restoreStartup(restored.checkpoint.transport);
        candidateTransport.dispose();
        upload(restored.checkpoint.machine);
        if (!api.spike_checkpoint_restore(FIRMWARE_PROFILES[selected].id))
          throw new Error('Invalid machine checkpoint.');
        profile = selected;
        name = data.name;
        if (data.preserveCheckpointClock !== true) api.spike_set_epoch(Date.now() / 1000);
        postMessage({ type: 'firmware-loaded', profile, name });
        resetSession();
        transport!.restoreStartup(restored.checkpoint.transport);
        steps = restored.checkpoint.steps;
        firmwareReady = true;
        state();
        postMessage({
          type: 'startup-status',
          restored: true,
          source: restored.source,
          message: 'Restored prepared firmware startup state.',
        });
        postMessage({ type: 'firmware-ready' });
        return;
      } catch {
        postMessage({
          type: 'startup-status',
          message: 'Startup state was rejected. Booting firmware normally.',
        });
      }
    }
    boot({ micro: data.micro, flash: data.flash, profile: selected }, data.name);
    startupOwner = identity;
    exportStartup = data.exportStartup === true;
    postMessage({ type: 'startup-status', restored: false, message: 'Booting firmware normally.' });
  } catch (error) {
    if (revision === bootRevision && !controller.signal.aborted)
      postMessage({ type: 'error', generation, command: 'firmware', message: String(error) });
  }
}
self.onmessage = async ({ data }) => {
  const commandGeneration = generation;
  try {
    if (data.type === 'init') {
      const response = await fetch(data.wasmUrl);
      if (!response.ok) throw new Error(`QEMU core download failed (${response.status}).`);
      const wasm = await response.arrayBuffer();
      coreHash = await bytesHash(new Uint8Array(wasm));
      checkpointBase = new URL('../checkpoints/', data.wasmUrl).href;
      const result = await WebAssembly.instantiate(wasm, {});
      api = result.instance.exports;
      postMessage({ type: 'ready' });
      return;
    }
    // Cancelling a preview posts these before `init` can finish. Neither needs
    // the core, and rejecting them left the preview holding a loading error it
    // never cleared, so the next start did nothing.
    if (data.type === 'cancel-startup') {
      if (!loaded) {
        bootController?.abort();
        bootRevision++;
      }
      return;
    }
    if (data.type === 'pause' && !api) return;
    if (!api) throw new Error('QEMU core is still loading.');
    switch (data.type) {
      case 'presentation':
        deltaFrames = !!data.deltaFrames;
        break;
      case 'pacing':
        realtime = !!data.realtime;
        paceStart = undefined;
        break;
      case 'firmware':
        demoOwned.clear();
        if (data.startup) await bootWithStartup(data);
        else {
          bootController?.abort();
          bootRevision++;
          boot({ micro: data.micro, flash: data.flash, profile: data.profile }, data.name);
        }
        break;
      case 'run':
        if (!loaded) throw new Error('Load firmware first.');
        if (!running) {
          paceStart = undefined;
          running = true;
          batch();
        }
        break;
      case 'pause':
        if (installing) throw new Error('Reset the watch to cancel the active installation.');
        stop();
        state();
        break;
      case 'step':
        if (installing) throw new Error('Wait for installation to finish before stepping.');
        stop();
        await tick(1);
        state();
        break;
      case 'reset':
        restart();
        break;
      case 'phone-clock':
        if (data.generation !== generation) return;
        connectClockPort(data.enabled ? data.port : undefined);
        phoneCoupled = !!data.enabled;
        break;
      case 'phone-clock-ack':
        if (data.generation === generation) phoneClock.acknowledge(data.sequence);
        break;
      case 'signal':
        applySignal(normalizeSignal(data.signal));
        state();
        break;
      case 'wrist-shake':
        if (!firmwareReady || installing || demoApplying)
          throw new Error('Wait for the app to finish loading before shaking the wrist.');
        gesture.load(wristShake(), Math.round(api.spike_ticks() / 64));
        break;
      case 'health-settings':
        if (!firmwareReady)
          throw new Error('Wait for firmware boot before changing health settings.');
        for (const item of healthPreferences(data.enabled, data.heartRate)) {
          await transport!.insertBlob(7, item.key, item.value);
          if (commandGeneration !== generation) return;
        }
        postMessage({
          type: 'health-settings',
          generation,
          enabled: data.enabled,
          heartRate: data.heartRate,
        });
        break;
      case 'scenario': {
        if (!firmwareReady) throw new Error('Wait for firmware boot before loading a scenario.');
        const scenario = normalizeScenario(data.scenario);
        for (const event of scenario.events) validateDeviceSignal(event.signal);
        demoStream.stop();
        postMessage({ type: 'demo-stopped', generation });
        timeline.load(scenario, Math.round(api.spike_ticks() / 64));
        scenarioName = scenario.name;
        for (const event of timeline.takeDue(api.spike_ticks() / 64))
          applySignal(event.signal, event.atUs);
        state();
        break;
      }
      case 'scenario-stop':
        timeline.clear();
        scenarioName = '';
        state();
        break;
      case 'inputs':
        buttons = data.buttons;
        api.spike_button(buttons);
        state();
        break;
      case 'epoch':
        if (!api.spike_set_epoch(data.epoch)) throw new Error('Invalid clock value.');
        state();
        break;
      case 'battery':
        if (!firmwareReady) throw new Error('Wait for firmware boot before setting battery state.');
        await transport!.setBattery(data.percent, data.charging);
        if (commandGeneration !== generation) return;
        battery = data.percent;
        charging = data.charging;
        state();
        break;
      case 'connection':
        if (!firmwareReady) throw new Error('Wait for firmware boot before connecting the phone.');
        await transport!.setBluetooth(data.connected);
        if (commandGeneration !== generation) return;
        linked = data.connected;
        phoneNeedsUi = true;
        postMessage({ type: 'connection', connected: linked });
        break;
      case 'appmessage':
        if (data.generation !== generation) return;
        if (!linked) throw new Error('Virtual phone link is disconnected.');
        await transport!.send(0x30, encodeAppMessage(data.uuid, data.transactionId, data.payload));
        break;
      case 'appmessage-ack':
        if (data.generation !== generation) return;
        await transport!.send(0x30, Uint8Array.of(data.accepted ? 255 : 127, data.transactionId));
        break;
      case 'packet':
        if (!firmwareReady) throw new Error('Firmware is not ready.');
        await transport!.send(data.endpoint, data.bytes);
        break;
      case 'demo-settings':
      case 'demo-notification': {
        if (data.generation !== generation) return;
        if (!firmwareReady)
          throw new Error('Wait for firmware boot before applying demo settings.');
        if (installing || demoApplying)
          throw new Error('Wait for the current watch operation to finish.');
        const settings = normalizeDemoSettings(data.settings);
        const popup = data.type === 'demo-notification';
        if (
          popup &&
          (!settings.enabled || !settings.notifications.some((n) => n.enabled && n.id === data.id))
        )
          throw new Error('Enable a sample notification first.');
        const records = demoRecords(settings, api.spike_epoch_ms(), popup ? data.id : undefined);
        const current = generation,
          port = transport!;
        const check = () => {
          if (current !== generation) throw new Error('Demo setup canceled.');
        };
        const resume = running;
        stop();
        running = resume;
        demoApplying = true;
        postMessage({ type: 'demo-status', busy: true, generation, revision: data.revision });
        try {
          if (!popup) {
            demoStream.stop();
            timeline.clear();
            scenarioName = '';
            if (settings.enabled) {
              applySignal({
                kind: 'battery',
                percent: settings.battery,
                charging: settings.charging,
              });
              for (const pref of healthPreferences(
                settings.health,
                settings.pulse && profile === 'qemu_emery',
              )) {
                await port.insertBlob(7, pref.key, pref.value);
                check();
              }
              if (settings.health)
                settings.metrics.forEach((value, metric) =>
                  applySignal({
                    kind: 'health',
                    metric: metric as 0 | 1 | 2 | 3 | 4 | 5 | 6,
                    value,
                  }),
                );
              if (settings.location)
                applySignal({
                  kind: 'location',
                  latitude: settings.latitude,
                  longitude: settings.longitude,
                  accuracy: settings.accuracy,
                });
            }
          }
          const id = (r: Pick<DemoRecord, 'database' | 'key'>) =>
            `${r.database}:${Array.from(r.key).join(',')}`;
          const toRemove = new Map(popup ? [] : demoOwned);
          for (const r of records) toRemove.set(id(r), r);
          for (const [key, r] of toRemove) {
            await port.deleteBlob(r.database, r.key);
            check();
            demoOwned.delete(key);
          }
          for (const r of records) {
            // Track before awaiting: a canceled transfer may already have reached the watch.
            demoOwned.set(id(r), { database: r.database, key: r.key });
            await port.insertBlob(r.database, r.key, r.value);
            check();
            if (r.dismissed) {
              await port.insertBlob(r.database, r.key, r.dismissed);
              check();
            }
          }
          if (!popup)
            demoStream.start(
              settings,
              Math.round(api.spike_ticks() / 64),
              profile === 'qemu_emery',
            );
          postMessage({
            type: 'demo-applied',
            generation,
            revision: data.revision,
            popup,
            notifications: records.filter((r) => r.database === 4).length,
            calendar: records.filter((r) => r.database === 1).length,
            heartRate: settings.enabled && settings.pulse && profile === 'qemu_emery',
          });
        } finally {
          if (current === generation) {
            demoApplying = false;
            postMessage({ type: 'demo-status', busy: false, generation, revision: data.revision });
            paceStart = undefined;
            state();
            if (running) void batch();
          }
        }
        break;
      }
      case 'install': {
        if (!firmwareReady)
          throw new Error('Run the firmware until boot completes before installing an app.');
        if (installing) throw new Error('An installation is already running.');
        if (demoApplying) throw new Error('Wait for demo settings to finish before installing.');
        const parts = appPackage(data.bytes, FIRMWARE_PROFILES[profile].platform);
        stop();
        launchConsoleTail = '';
        launchDiagnostic = '';
        installing = true;
        running = true;
        const current = generation;
        let outcome = 'Installation failed';
        postMessage({ type: 'install-status', busy: true, message: 'Connecting virtual phone…' });
        try {
          if (!linked) await transport!.setBluetooth(true);
          linked = true;
          phoneNeedsUi = true;
          postMessage({ type: 'connection', connected: true });
          const result = await transport!.install(parts, (progress) =>
            postMessage({
              type: 'install-status',
              busy: true,
              message: `${progress.phase}: ${progress.sentBytes} / ${progress.totalBytes} bytes`,
            }),
          );
          outcome =
            'Installed and launched: ' +
            result.uuid +
            (parts.compatibility === 'legacy' ? ` (${parts.selectedPlatform} legacy build)` : '');
          if (current === generation)
            postMessage({
              type: 'installed',
              ...result,
              script: parts.script,
              appinfo: parts.appinfo,
              selectedPlatform: parts.selectedPlatform,
              compatibility: parts.compatibility,
              name: data.name,
            });
        } catch (e) {
          if (current === generation) {
            stop();
            outcome = String(e);
            postMessage({ type: 'error', message: outcome, command: 'install', generation });
          }
        } finally {
          if (current === generation) {
            installing = false;
            postMessage({ type: 'install-status', busy: false, message: outcome });
            state();
            if (running) batch();
          }
        }
        break;
      }
      case 'uart':
        upload(data.bytes);
        const accepted = api.spike_receive_uart(data.port, data.bytes.length);
        postMessage({ type: 'uart-accepted', id: data.id, accepted });
        break;
      default:
        throw new Error('Command is unavailable on the QEMU profile.');
    }
  } catch (e) {
    if (commandGeneration !== generation) return;
    if (data.type === 'install' && !installing) stop();
    postMessage({ type: 'error', message: String(e), command: data.type, generation });
    if (loaded) state();
  }
};
