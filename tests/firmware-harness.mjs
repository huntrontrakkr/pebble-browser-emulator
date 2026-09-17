import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
export class FirmwareHarness {
  messages = [];
  serial = '';
  controls = [];
  signals = [];
  states = [];
  failure;
  listeners = new Set();
  constructor() {
    this.worker = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source: resolve('src/app/qemu.worker.ts') },
    });
    this.worker.on('message', (m) => {
      if (m.type === 'serial') this.serial = (this.serial + m.text).slice(-1024 * 1024);
      if (m.type === 'control') this.controls.push(m);
      if (m.type === 'signal') this.signals.push(m);
      if (m.type === 'state') {
        this.states.push(m);
        if (this.states.length > 10) this.states.shift();
      }
      this.messages.push({
        ...m,
        ...(m.type === 'state' ? { state: { ...m.state, framebuffer: undefined } } : {}),
      });
      if (this.messages.length > 5000) this.messages.shift();
      if (m.type === 'error' || m.type === 'harness-unhandled') this.failure = new Error(m.message);
      for (const fn of this.listeners) fn(m);
    });
    this.worker.on('error', (e) => {
      this.failure = e;
      for (const fn of this.listeners) fn({});
    });
  }
  send(value) {
    this.worker.postMessage(value);
  }
  wait(predicate, timeout = 120000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const check = (m) => {
        if (this.failure) {
          cleanup();
          reject(this.failure);
        } else if (predicate(m)) {
          cleanup();
          resolve(m);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            'Firmware wait timed out: ' +
              predicate.toString() +
              '; app events: ' +
              JSON.stringify(
                [...new Set(this.serial.match(/SENSOR [\x20-\x7e]+/g) ?? [])].slice(-35),
              ),
          ),
        );
      }, timeout);
      this.listeners.add(check);
      if (this.failure) check({});
    });
  }
  async boot(profile, directory, version = '4.37.0') {
    await this.wait((m) => m.type === 'harness-ready');
    this.send({
      type: 'init',
      wasmUrl: pathToFileURL(resolve(process.env.PEBBLE_WASM ?? 'public/wasm/qemu-emery.wasm'))
        .href,
    });
    await this.wait((m) => m.type === 'ready');
    this.send({
      type: 'firmware',
      profile,
      micro: await readFile(resolve(directory, `${profile}_v${version}_micro_flash.bin`)),
      flash: await readFile(resolve(directory, `${profile}_v${version}_spi_flash.bin`)),
      name: `${profile} v${version}`,
    });
    await this.wait((m) => m.type === 'firmware-loaded');
    this.send({ type: 'run' });
    await this.wait((m) => m.type === 'firmware-ready');
  }
  async install(path) {
    this.send({ type: 'install', bytes: await readFile(path), name: 'sensor-test.pbw' });
    return this.wait((m) => m.type === 'installed');
  }
  close() {
    return this.worker.terminate();
  }
}
