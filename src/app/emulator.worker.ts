/// <reference lib="webworker" />
import type { EmulatorCommand, EmulatorEvent } from './emulator.types';
type Wasm = WebAssembly.Exports & { memory: WebAssembly.Memory; [name: string]: any };
let core: Wasm | undefined;
let running = false,
  loaded = false,
  programName = 'No program loaded',
  inputRevision = 0;
let desiredButtons = 0,
  desiredBattery = 100;
let timer: ReturnType<typeof setTimeout> | undefined;
const emit = (event: EmulatorEvent) => postMessage(event);
const out = () =>
  new Uint8Array(core!.memory.buffer, core!['output_ptr'](), core!['output_len']()).slice();
const errorText = () => new TextDecoder().decode(out());
const input = (bytes: Uint8Array) => {
  const pointer = core!['input_reserve'](bytes.length);
  if (!pointer) throw new Error('Input exceeds the 24 MiB limit.');
  new Uint8Array(core!.memory.buffer, pointer, bytes.length).set(bytes);
};
function state() {
  if (!core) return;
  core['fault']();
  emit({
    type: 'state',
    state: {
      registers: Array.from({ length: 16 }, (_, i) => core!['register'](i) >>> 0),
      flags: core['flags']() >>> 0,
      instructions: core['instructions'](),
      halted: !!core['halted'](),
      running,
      loaded,
      programName,
      inputRevision,
      fault: errorText(),
      framebuffer: new Uint8Array(core.memory.buffer, core['framebuffer_ptr'](), 45600).slice(),
      buttons: core['buttons'](),
      battery: core['battery'](),
    },
  });
}
function stop() {
  running = false;
  clearTimeout(timer);
}
function tick() {
  try {
    if (!running || !core) return;
    core['run'](10000);
    if (core['halted']()) stop();
    state();
    if (running) timer = setTimeout(tick, 0);
  } catch (e) {
    stop();
    emit({ type: 'error', message: String(e), fatal: true });
  }
}
function applyInputs() {
  core!['set_inputs'](desiredButtons, desiredBattery);
}
addEventListener('message', async ({ data }: MessageEvent<EmulatorCommand>) => {
  try {
    if (data.type === 'init') {
      if (core) throw new Error('Core already initialized.');
      const response = await fetch(data.wasmUrl);
      if (!response.ok)
        throw new Error(`Unable to load Rust core (${response.status}). Run npm run build:wasm.`);
      const instance = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      core = instance.instance.exports as Wasm;
      if (core['abi_version']() !== 1) throw new Error('Incompatible emulator ABI.');
      emit({ type: 'ready' });
      state();
      return;
    }
    if (!core) throw new Error('Core has not initialized.');
    switch (data.type) {
      case 'diagnostic':
        stop();
        core['load_diagnostic']();
        applyInputs();
        loaded = true;
        programName = 'Framebuffer diagnostic';
        state();
        break;
      case 'run':
        if (!running && !core['halted']()) {
          running = true;
          tick();
        } else state();
        break;
      case 'pause':
        stop();
        state();
        break;
      case 'step':
        stop();
        core['run'](1);
        state();
        break;
      case 'reset':
        stop();
        if (!core['reset']()) throw new Error(errorText());
        applyInputs();
        state();
        break;
      case 'inputs':
        desiredButtons = data.buttons;
        desiredBattery = data.battery;
        inputRevision = data.inputRevision;
        applyInputs();
        state();
        break;
      case 'image':
        stop();
        input(data.bytes);
        if (!core['load_image']()) throw new Error(errorText());
        applyInputs();
        loaded = true;
        programName = data.name;
        state();
        break;
      case 'snapshot':
        core['snapshot']();
        emit({ type: 'snapshot', bytes: out(), name: programName });
        break;
      case 'restore':
        stop();
        input(data.bytes);
        if (!core['restore']()) throw new Error(errorText());
        programName = data.name;
        loaded = true;
        desiredButtons = core['buttons']();
        desiredBattery = core['battery']();
        inputRevision = data.inputRevision;
        state();
        break;
      case 'ping':
        core['encode_ping'](data.cookie);
        emit({ type: 'packet', bytes: out() });
        break;
    }
  } catch (e) {
    stop();
    state();
    emit({ type: 'error', message: String(e), fatal: data.type === 'init' });
  }
});
