import { FIRMWARE_PROFILES, isFirmwareProfile, type FirmwareProfile } from './watch-profiles.ts';
/// <reference lib="webworker" />
import { PebbleTransport, encodeAppMessage, decodeAppMessage } from './pebble-transport.ts';
import { appPackage } from './archives.ts';
import type { MachineState } from './emulator.types.ts';
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
  installing = false,
  generation = 0,
  linked = false,
  battery = 100,
  charging = false;
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function tick(count = 100000) {
  const frame = api.spike_run(count);
  steps += count;
  serial();
  if (frame === 0xffffffff)
    throw new Error(`QEMU bus fault at 0x${api.spike_fault().toString(16)}`);
  if (frame !== lastFrame || steps % 2000000 === 0) {
    lastFrame = frame;
    state();
  }
  return frame;
}
function createTransport() {
  return new PebbleTransport(
    {
      nowMs: () => api.spike_ticks() / 64000,
      advance: async () => {
        tick();
        await yieldTask();
      },
      writeUart: async (bytes) => {
        let offset = 0;
        const current = generation;
        while (offset < bytes.length) {
          if (current !== generation) throw new Error('Firmware operation canceled.');
          upload(bytes.subarray(offset));
          offset += api.spike_receive_uart(1, bytes.length - offset);
          if (offset < bytes.length) {
            tick(50000);
            await yieldTask();
          }
        }
      },
    },
    {
      onPacket: (direction, packet) => {
        postMessage({
          type: 'protocol',
          direction,
          endpoint: packet.endpoint,
          bytes: packet.payload,
          virtualSeconds: api.spike_ticks() / 64000000,
        });
        if (direction === 'watch' && packet.endpoint === 0x30) {
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
      consoleTail = (consoleTail + text).slice(-2000);
      if (!firmwareReady && consoleTail.includes('Ready for communication.')) {
        firmwareReady = true;
        postMessage({ type: 'firmware-ready' });
      }
      postMessage({ type: 'serial', port, bytes, text }, [bytes.buffer]);
    }
  }
}
function state(force = true) {
  if (!loaded) return;
  const address = api.spike_fault(),
    fault = api.spike_faulted()
      ? `Bus ${api.spike_fault_write() ? 'write' : 'read'} at 0x${address.toString(16)}; PC 0x${api.spike_fault_pc().toString(16)}`
      : '';
  if (fault) stop();
  const framebuffer = new Uint8Array(
    api.memory.buffer,
    api.spike_frame(),
    api.spike_frame_len(),
  ).slice();
  const value: MachineState = {
    registers: Array.from({ length: 16 }, (_, i) => api.spike_register(i)),
    flags: api.spike_xpsr(),
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
      state: value,
      profile,
      virtualSeconds: api.spike_ticks() / 64000000,
      firmwareReady,
      linked,
      installing,
      charging,
    },
    [framebuffer.buffer],
  );
}
function batch() {
  if (!running || installing) return;
  try {
    tick(250000);
    timer = setTimeout(batch, 0);
  } catch (e) {
    stop();
    postMessage({ type: 'error', message: String(e) });
    state();
  }
}
function resetSession() {
  generation++;
  postMessage({ type: 'session', generation });
  transport?.dispose();
  transport = createTransport();
  loaded = true;
  steps = 0;
  buttons = 0;
  lastFrame = -1;
  firmwareReady = false;
  consoleTail = '';
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
  const bytes = new Uint8Array(candidate.micro.length + candidate.flash.length);
  bytes.set(candidate.micro);
  bytes.set(candidate.flash, candidate.micro.length);
  upload(bytes);
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
  if (!loaded) throw new Error('Load firmware first.');
  stop();
  if (!api.spike_restart()) throw new Error('The loaded watch could not restart.');
  resetSession();
}
self.onmessage = async ({ data }) => {
  const commandGeneration = generation;
  try {
    if (data.type === 'init') {
      const response = await fetch(data.wasmUrl);
      if (!response.ok) throw new Error(`QEMU core download failed (${response.status}).`);
      const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      api = result.instance.exports;
      postMessage({ type: 'ready' });
      return;
    }
    if (!api) throw new Error('QEMU core is still loading.');
    switch (data.type) {
      case 'firmware':
        boot({ micro: data.micro, flash: data.flash, profile: data.profile }, data.name);
        break;
      case 'run':
        if (!loaded) throw new Error('Load firmware first.');
        if (!running) {
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
        api.spike_run(1);
        steps++;
        serial();
        state();
        break;
      case 'reset':
        restart();
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
      case 'install': {
        if (!firmwareReady)
          throw new Error('Run the firmware until boot completes before installing an app.');
        if (installing) throw new Error('An installation is already running.');
        const parts = appPackage(data.bytes, FIRMWARE_PROFILES[profile].platform);
        stop();
        installing = true;
        running = true;
        const current = generation;
        let outcome = 'Installation failed';
        postMessage({ type: 'install-status', busy: true, message: 'Connecting virtual phone…' });
        try {
          await transport!.setBluetooth(true);
          linked = true;
          postMessage({ type: 'connection', connected: true });
          const result = await transport!.install(parts, (progress) =>
            postMessage({
              type: 'install-status',
              busy: true,
              message: `${progress.phase}: ${progress.sentBytes} / ${progress.totalBytes} bytes`,
            }),
          );
          outcome = 'Installed and launched: ' + result.uuid;
          if (current === generation)
            postMessage({
              type: 'installed',
              ...result,
              script: parts.script,
              appinfo: parts.appinfo,
              name: data.name,
            });
        } catch (e) {
          if (current === generation) postMessage({ type: 'error', message: String(e) });
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
    postMessage({ type: 'error', message: String(e) });
    if (loaded) state();
  }
};
