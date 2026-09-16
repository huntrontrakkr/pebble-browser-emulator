import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { registerInspector, type InspectorRegistry } from './inspector-tools';
import type { EmulatorCommand, EmulatorEvent, MachineState } from './emulator.types';

@Component({ selector: 'app-root', imports: [FormsModule, DecimalPipe], templateUrl: './app.html' })
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('screen') screen!: ElementRef<HTMLCanvasElement>;
  ready = signal(false);
  loaded = signal(false);
  running = signal(false);
  state = signal<MachineState | null>(null);
  error = signal('');
  tab = signal('Registers');
  battery = signal(100);
  buttons = 0;
  trace = signal<{ index: number; kind: string; text: string }[]>([]);
  firmwareName = signal('No program loaded');
  packet = signal('');
  snapshotAvailable = signal(false);
  private cleanupInspector = () => {};
  private worker?: Worker;
  private index = 0;
  private saved?: { bytes: Uint8Array; name: string };
  private inputRevision = 0;
  private loadRevision = 0;
  protected hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
  ngAfterViewInit() {
    this.cleanupInspector = registerInspector(
      (document as Document & { modelContext?: InspectorRegistry }).modelContext,
      () => this.state(),
    );
    this.worker = new Worker(new URL('./emulator.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<EmulatorEvent>) => {
      if (data.type === 'ready') {
        this.ready.set(true);
        this.log('CORE', 'Rust/Wasm ABI v1 connected');
      }
      if (data.type === 'error') {
        if (data.fatal) this.ready.set(false);
        this.error.set(data.message);
        this.running.set(false);
        this.log('ERROR', data.message);
      }
      if (data.type === 'state') {
        const prior = this.firmwareName();
        this.state.set(data.state);
        this.running.set(data.state.running);
        this.loaded.set(data.state.loaded);
        this.firmwareName.set(data.state.programName);
        if (data.state.inputRevision === this.inputRevision) {
          this.battery.set(data.state.battery);
          this.buttons = data.state.buttons;
        }
        if (data.state.loaded && prior !== data.state.programName)
          this.log('LOAD', data.state.programName);
        if (data.state.fault && data.state.fault !== this.error()) {
          this.error.set(data.state.fault);
          this.log('FAULT', data.state.fault);
        }
        this.draw(data.state.framebuffer);
      }
      if (data.type === 'snapshot') {
        this.saved = { bytes: data.bytes, name: data.name || this.firmwareName() };
        this.snapshotAvailable.set(true);
        this.log('STATE', 'Snapshot saved in this session');
      }
      if (data.type === 'packet') {
        const hex = Array.from(data.bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
        this.packet.set(hex);
        this.log('CODEC', `Ping encoded by Rust · ${data.bytes.length} bytes · ${hex}`);
      }
    };
    this.worker.postMessage({
      type: 'init',
      wasmUrl: new URL('wasm/emulator.wasm', document.baseURI).href,
    });
    this.worker.onerror = (event) => {
      this.ready.set(false);
      this.error.set(event.message || 'Emulator Worker failed');
      this.running.set(false);
    };
  }
  ngOnDestroy() {
    this.cleanupInspector();
    this.worker?.terminate();
  }
  send(command: EmulatorCommand) {
    if (this.ready()) this.worker?.postMessage(command);
  }
  log(kind: string, text: string) {
    this.trace.update((t) => [...t, { index: ++this.index, kind, text }].slice(-200));
  }
  diagnostic() {
    this.loadRevision++;
    this.error.set('');
    this.send({ type: 'diagnostic' });
  }
  run() {
    this.running.set(true);
    this.send({ type: 'run' });
  }
  pause() {
    this.running.set(false);
    this.send({ type: 'pause' });
  }
  reset() {
    this.error.set('');
    this.running.set(false);
    this.send({ type: 'reset' });
    this.log('RESET', 'Machine reset to image vector table');
  }
  setBattery(value: number) {
    this.battery.set(value);
    this.send({
      type: 'inputs',
      buttons: this.buttons,
      battery: value,
      inputRevision: ++this.inputRevision,
    });
  }
  handleButton(mask: number, pressed: boolean) {
    this.buttons = pressed ? this.buttons | mask : this.buttons & ~mask;
    this.send({
      type: 'inputs',
      buttons: this.buttons,
      battery: this.battery(),
      inputRevision: ++this.inputRevision,
    });
  }
  restore() {
    if (this.saved) {
      this.error.set('');
      this.send({
        type: 'restore',
        bytes: this.saved.bytes,
        name: this.saved.name,
        inputRevision: ++this.inputRevision,
      });
      this.log('STATE', 'Restored machine snapshot');
    }
  }
  exportTrace() {
    this.download(
      'pebble-trace.json',
      new TextEncoder().encode(
        JSON.stringify({ version: 1, profile: 'diagnostic-v1', events: this.trace() }, null, 2),
      ),
    );
  }
  download(name: string, bytes: Uint8Array) {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async loadImage(event: Event) {
    const control = event.target as HTMLInputElement;
    const file = control.files?.[0];
    if (!file) return;
    const revision = ++this.loadRevision;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Diagnostic images are limited to 4 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (revision !== this.loadRevision) return;
      this.error.set('');
      this.send({ type: 'image', bytes, name: file.name });
    } catch (e) {
      if (revision === this.loadRevision) this.error.set(String(e));
    } finally {
      control.value = '';
    }
  }
  draw(bytes: Uint8Array) {
    const context = this.screen.nativeElement.getContext('2d');
    if (!context) return;
    const image = context.createImageData(200, 228);
    for (let i = 0; i < bytes.length; i++) {
      const p = bytes[i];
      image.data[i * 4] = ((p >> 4) & 3) * 85;
      image.data[i * 4 + 1] = ((p >> 2) & 3) * 85;
      image.data[i * 4 + 2] = (p & 3) * 85;
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }
}
