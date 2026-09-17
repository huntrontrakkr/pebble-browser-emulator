import {
  FIRMWARE_PROFILES,
  profileDisplay,
  isFirmwareProfile,
  type FirmwareProfile,
  type MachineProfile,
} from './watch-profiles.ts';
import { AppMessageRouter } from './app-message-router.ts';
import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirmwarePanel } from './firmware-panel.ts';
import { ProjectPanel } from './project-panel.ts';
import { SensorPanel, type SignalObservation } from './sensor-panel.ts';
import { FramePanel } from './frame-panel.ts';
import type { DeviceSignal, SignalScenario } from './signals.ts';
import { renderPixels, type DisplayMode } from './display.ts';
import type { WatchModel } from './watch-model.ts';
import { registerInspector, type InspectorRegistry } from './inspector-tools';
import type { EmulatorCommand, EmulatorEvent, MachineState } from './emulator.types';

@Component({
  selector: 'app-root',
  imports: [FormsModule, DecimalPipe, FirmwarePanel, ProjectPanel, SensorPanel, FramePanel],
  templateUrl: './app.html',
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('screen') screen!: ElementRef<HTMLCanvasElement>;
  ready = signal(false);
  loaded = signal(false);
  running = signal(false);
  state = signal<MachineState | null>(null);
  error = signal('');
  tab = signal('Firmware');
  profile = signal<MachineProfile>('diagnostic-v1');
  isFirmware() {
    return this.profile() !== 'diagnostic-v1';
  }
  display() {
    return profileDisplay(this.profile());
  }
  machineName() {
    const p = this.profile();
    return p === 'diagnostic-v1' ? 'Diagnostic board' : FIRMWARE_PROFILES[p].label;
  }
  appPlatform() {
    const p = this.profile();
    return p === 'diagnostic-v1' ? 'emery' : FIRMWARE_PROFILES[p].platform;
  }
  hasModel() {
    return this.profile() === 'qemu_emery' || this.profile() === 'diagnostic-v1';
  }
  displayMode = signal<DisplayMode>('pixels');
  theme = signal('light');
  ambient = 80;
  backlight = 0;
  finish = 'silver';
  zoom = 2;
  modelStatus = signal('');
  private model?: WatchModel;
  private modelAbort?: AbortController;
  private modelLoading = false;
  private destroyed = false;
  @ViewChild('modelHost') modelHost!: ElementRef<HTMLElement>;
  private phoneWorker?: Worker;
  private phoneAccepting = false;
  private watchGeneration = -1;
  private phoneMessages = new AppMessageRouter<Worker>();
  private phoneAppId = 'project';
  private phoneKeys: Record<string, number> = {};
  private phoneAppInfo: Record<string, unknown> = {};
  private phoneGeneration = -1;
  phoneNetworkMode: 'disabled' | 'fixtures' | 'cors' = 'disabled';
  phoneFixtures =
    '[\n  {\n    "url": "https://weather.example/forecast",\n    "response": { "status": 200, "body": "{\\"temperature\\":23}" },\n    "delayMs": 50\n  }\n]';
  phoneWatchOverride = '';
  accountToken = '';
  watchToken = '';
  phoneHttp = signal<string[]>([]);
  configuration = signal<{ url: string; requestId: number; generation: number } | null>(null);
  configurationResponse = '';
  private qemuWorker?: Worker;
  private qemuReady?: Promise<void>;
  private diagnosticReady = false;
  virtualSeconds = signal(0);
  private watchEpochMs = Date.now();
  sensorEvents = signal<SignalObservation[]>([]);
  scenarioPending = signal(0);
  vibrating = signal(false);
  phoneScript = signal('');
  phoneScriptName = signal('No script loaded');
  latitude = 37.7749;
  longitude = -122.4194;
  accuracy = 10;
  altitude: number | null = null;
  locationHeading: number | null = null;
  speed: number | null = null;
  phoneStatus = signal('Stopped');
  watchReady = signal(false);
  linked = signal(false);
  installing = signal(false);
  installStatus = signal('');
  charging = false;
  packets = signal<
    { id: number; direction: string; endpoint: number; bytes: Uint8Array; time: number }[]
  >([]);
  packetFilter = '';
  injectEndpoint = '0x30';
  injectHex = '';
  private packetIndex = 0;
  epochValue = new Date().toISOString().slice(0, 16);
  readonly buttonList = [
    { name: 'Back', mask: 1 },
    { name: 'Up', mask: 2 },
    { name: 'Select', mask: 4 },
    { name: 'Down', mask: 8 },
  ];
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
    try {
      this.setTheme(localStorage.getItem('pebble.theme') ?? 'light');
    } catch {}
    this.cleanupInspector = registerInspector(
      (document as Document & { modelContext?: InspectorRegistry }).modelContext,
      () => this.state(),
    );
    this.worker = new Worker(new URL('./emulator.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<EmulatorEvent>) => {
      if (data.type === 'ready') this.diagnosticReady = true;
      if (data.type === 'error' && data.fatal) this.diagnosticReady = false;
      if (this.profile() !== 'diagnostic-v1') return;
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
    this.destroyed = true;
    this.cleanupInspector();
    this.worker?.terminate();
    this.qemuWorker?.terminate();
    this.phoneWorker?.terminate();
    this.modelAbort?.abort();
    this.model?.dispose();
  }
  send(command: EmulatorCommand) {
    if (this.ready()) (this.isFirmware() ? this.qemuWorker : this.worker)?.postMessage(command);
  }
  log(kind: string, text: string) {
    this.trace.update((t) =>
      [
        ...t,
        { index: ++this.index, kind, text: text.length > 6000 ? text.slice(0, 6000) + ' …' : text },
      ].slice(-200),
    );
  }
  diagnostic() {
    if (this.installing()) {
      this.error.set(
        'Wait for installation to finish, or reset the watch before switching profiles.',
      );
      return;
    }
    this.stopPhone();
    this.qemuWorker?.postMessage({ type: 'pause' });
    this.profile.set('diagnostic-v1');
    this.ready.set(this.diagnosticReady);
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
    this.buttons = 0;
    this.error.set('');
    this.running.set(false);
    this.send({ type: 'reset' });
    this.log(
      'RESET',
      this.isFirmware()
        ? 'Watch restarted; installed apps and RTC retained'
        : 'Machine reset to image vector table',
    );
  }
  setBattery(value: number) {
    if (!Number.isFinite(value)) return;
    value = Math.round(Math.min(100, Math.max(0, value)));
    this.battery.set(value);
    if (this.isFirmware()) {
      this.setCharge();
      return;
    }
    this.send({
      type: 'inputs',
      buttons: this.buttons,
      battery: value,
      inputRevision: ++this.inputRevision,
    });
  }
  isPressed(mask: number) {
    return (this.buttons & mask) !== 0;
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
        JSON.stringify({ version: 1, profile: this.profile(), events: this.trace() }, null, 2),
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
      if (this.installing())
        throw new Error(
          'Wait for installation to finish, or reset the watch before switching profiles.',
        );
      this.stopPhone();
      this.qemuWorker?.postMessage({ type: 'pause' });
      this.profile.set('diagnostic-v1');
      this.ready.set(this.diagnosticReady);
      this.send({ type: 'image', bytes, name: file.name });
    } catch (e) {
      if (revision === this.loadRevision) this.error.set(String(e));
    } finally {
      control.value = '';
    }
  }
  draw(bytes: Uint8Array) {
    if (!this.screen) return;
    const context = this.screen.nativeElement.getContext('2d');
    if (!context) return;
    const rgba = renderPixels(bytes, {
      mode: this.displayMode(),
      ambient: this.ambient / 100,
      backlight: this.backlight / 100,
    });
    const { width, height } = this.display();
    if (bytes.length !== width * height) return;
    const canvas = this.screen.nativeElement;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.putImageData(
      new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height),
      0,
      0,
    );
    if (this.hasModel()) this.model?.pixels(rgba);
  }
  redraw() {
    const state = this.state();
    if (state) this.draw(state.framebuffer);
    this.model?.finish(this.finish);
  }
  setTheme(value: string) {
    this.theme.set(value);
    document.documentElement.dataset['theme'] = value;
    try {
      localStorage.setItem('pebble.theme', value);
    } catch {}
  }
  async setDisplay(mode: DisplayMode) {
    if (mode === 'model' && !this.hasModel()) return;
    this.displayMode.set(mode);
    this.redraw();
    if (mode !== 'model' || this.model || this.modelLoading) return;
    this.modelLoading = true;
    this.modelStatus.set('Loading official CAD model…');
    this.modelAbort = new AbortController();
    try {
      const { WatchModel } = await import('./watch-model.ts');
      if (this.destroyed) return;
      this.model = new WatchModel(this.modelHost.nativeElement);
      await this.model.load(this.modelAbort.signal);
      this.modelStatus.set('');
      this.redraw();
    } catch (e) {
      this.model?.dispose();
      this.model = undefined;
      this.modelStatus.set(String(e));
    } finally {
      this.modelLoading = false;
    }
  }
  resetModel() {
    this.model?.reset();
  }
  async loadFirmware(data: {
    micro: Uint8Array;
    flash: Uint8Array;
    name: string;
    profile?: FirmwareProfile;
  }) {
    const revision = ++this.loadRevision;
    this.worker?.postMessage({ type: 'pause' });
    this.error.set('');
    try {
      if (!this.qemuWorker) {
        this.qemuWorker = new Worker(new URL('./qemu.worker', import.meta.url), { type: 'module' });
        const watch = this.qemuWorker;
        this.watchGeneration = -1;
        this.phoneMessages.resetWorker();
        this.qemuReady = new Promise((resolve, reject) => {
          this.qemuWorker!.onmessage = ({ data }) => {
            if (this.qemuWorker !== watch) return;
            if (data.type === 'ready') {
              resolve();
              return;
            }
            if (data.type === 'error') {
              this.error.set(data.message);
              if (data.command === 'health-settings' && data.generation === this.watchGeneration)
                this.healthStatus.set(data.message);
              this.running.set(false);
              reject(new Error(data.message));
              return;
            }
            this.handleQemuEvent(data);
            if (data.type === 'state' && this.isFirmware()) {
              this.state.set(data.state);
              this.running.set(data.state.running);
              this.loaded.set(data.state.loaded);
              this.firmwareName.set(data.state.programName);
              this.virtualSeconds.set(data.virtualSeconds);
              this.watchReady.set(data.firmwareReady);
              this.installing.set(data.installing);
              this.battery.set(data.state.battery);
              this.charging = data.charging;
              this.scenarioPending.set(data.scenario?.pending ?? 0);
              if (data.state.fault) this.error.set(data.state.fault);
              this.draw(data.state.framebuffer);
            }
            if (data.type === 'serial') {
              if (data.port === 2) this.log('UART', data.text);
              else
                this.log(
                  'PACKET',
                  `UART ${data.port}: ${Array.from(data.bytes as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join(' ')}`,
                );
            }
          };
          this.qemuWorker!.onerror = (e) => {
            if (this.qemuWorker !== watch) return;
            this.error.set(e.message);
            this.running.set(false);
            reject(new Error(e.message));
          };
          this.qemuWorker!.postMessage({
            type: 'init',
            wasmUrl: new URL('wasm/qemu-emery.wasm', document.baseURI).href,
          });
        });
      }
      await this.qemuReady;
      if (revision !== this.loadRevision || this.destroyed) return;
      this.qemuWorker.postMessage({ type: 'firmware', ...data });
      this.log('LOAD', data.name);
      this.tab.set('Inputs');
    } catch (e) {
      if (revision !== this.loadRevision) return;
      this.qemuWorker?.terminate();
      this.qemuWorker = undefined;
      this.qemuReady = undefined;
      this.error.set(String(e));
    }
  }
  installPackage(data: { bytes: Uint8Array; name: string }) {
    if (!this.isFirmware() || !this.watchReady()) {
      this.error.set(
        'Load and run matching emulator firmware until boot completes, then install the app.',
      );
      return;
    }
    this.error.set('');
    this.qemuWorker?.postMessage({ type: 'install', ...data });
  }
  handleQemuEvent(data: any) {
    if (data.type === 'health-settings' && data.generation === this.watchGeneration)
      this.healthStatus.set('Firmware accepted the health preferences.');
    if (data.type === 'clock' && data.generation === this.watchGeneration) {
      this.watchEpochMs = data.epochMs;
      this.virtualSeconds.set(data.virtualUs / 1e6);
      if (this.phoneAccepting)
        this.phoneWorker?.postMessage({
          type: 'clock',
          virtualUs: data.virtualUs,
          sequence: data.sequence,
          transportGeneration: data.generation,
        });
      else if (data.sequence !== undefined)
        this.qemuWorker?.postMessage({
          type: 'phone-clock-ack',
          generation: data.generation,
          sequence: data.sequence,
        });
    }
    if (data.type === 'signal' && data.generation === this.watchGeneration)
      this.sensorEvents.update((rows) => [...rows, data].slice(-300));
    if (
      data.type === 'device-output' &&
      data.kind === 'vibration' &&
      data.generation === this.watchGeneration
    )
      this.vibrating.set(data.value);
    if (
      data.type === 'phone-signal' &&
      data.generation === this.watchGeneration &&
      this.phoneAccepting
    ) {
      const signal = data.signal;
      this.phoneWorker?.postMessage(
        signal.kind === 'location'
          ? { type: 'location', coordinates: signal, virtualUs: data.virtualUs }
          : {
              type: 'location-error',
              code: signal.code,
              message: signal.message,
              virtualUs: data.virtualUs,
            },
      );
    }
    if (data.type === 'firmware-loaded' && isFirmwareProfile(data.profile)) {
      this.stopPhone();
      this.profile.set(data.profile);
      this.ready.set(true);
      this.watchReady.set(false);
      this.buttons = 0;
      if (!this.hasModel() && this.displayMode() === 'model') this.displayMode.set('pixels');
      return;
    }
    if (data.type === 'session') {
      this.stopPhone();
      this.healthStatus.set('');
      this.sensorEvents.set([]);
      this.scenarioPending.set(0);
      this.vibrating.set(false);
      this.watchGeneration = data.generation;
      this.phoneMessages.beginSession(data.generation);
      this.linked.set(false);
      this.phoneWorker?.postMessage({ type: 'connection', connected: false });
      return;
    }
    if (data.type === 'firmware-ready') {
      this.watchReady.set(true);
      this.log('FIRMWARE', 'Boot complete. Ready for app installation.');
    }
    if (data.type === 'connection') {
      this.linked.set(data.connected);
      this.phoneWorker?.postMessage({ type: 'connection', connected: data.connected });
    }
    if (data.type === 'install-status') {
      this.installing.set(data.busy);
      this.installStatus.set(data.message);
    }
    if (data.type === 'installed') {
      this.installStatus.set('Installed and launched: ' + data.uuid);
      this.log('INSTALL', this.installStatus());
      this.setScript({
        source: data.script,
        name: data.name + '/pebble-js-app.js',
        appId: data.uuid,
        messageKeys: data.appinfo.appKeys ?? {},
        appInfo: data.appinfo,
      });
      if (data.script) this.startPhone();
    }
    if (data.type === 'protocol') {
      this.packets.update((rows) =>
        [
          ...rows,
          {
            id: ++this.packetIndex,
            direction: data.direction,
            endpoint: data.endpoint,
            bytes: data.bytes,
            time: data.virtualSeconds,
          },
        ].slice(-300),
      );
    }
    if (data.type === 'appmessage') {
      if (data.generation !== this.watchGeneration) return;
      const message = data.message;
      if (message.kind === 'ack' || message.kind === 'nack') {
        const pending = this.phoneMessages.settle(data.generation, message.transactionId);
        if (pending && this.phoneAccepting && pending.owner === this.phoneWorker) {
          pending.owner.postMessage({
            type: 'ack',
            transactionId: pending.transactionId,
            accepted: message.kind === 'ack',
          });
        }
      } else if (this.phoneStatus() === 'Running' && message.uuid === this.phoneAppId) {
        this.phoneWorker?.postMessage({
          type: 'appmessage',
          payload: message.payload,
          transactionId: message.transactionId,
          transportGeneration: data.generation,
        });
      } else {
        this.qemuWorker?.postMessage({
          type: 'appmessage-ack',
          generation: data.generation,
          transactionId: message.transactionId,
          accepted: false,
        });
      }
    }
  }
  setConnection(value: boolean) {
    this.qemuWorker?.postMessage({ type: 'connection', connected: value });
  }
  sendSignal(signal: DeviceSignal) {
    this.qemuWorker?.postMessage({ type: 'signal', signal });
  }
  healthStatus = signal('');
  applyHealthSettings(values: { enabled: boolean; heartRate: boolean }) {
    this.healthStatus.set('Waiting for firmware…');
    this.qemuWorker?.postMessage({ type: 'health-settings', ...values });
  }
  scheduleSignals(scenario: SignalScenario) {
    this.qemuWorker?.postMessage({ type: 'scenario', scenario });
  }
  cancelSignals() {
    this.qemuWorker?.postMessage({ type: 'scenario-stop' });
  }
  locationUnavailable() {
    this.phoneWorker?.postMessage({
      type: 'location-error',
      code: 2,
      message: 'Location unavailable',
    });
  }
  setCharge() {
    this.qemuWorker?.postMessage({
      type: 'battery',
      percent: this.battery(),
      charging: this.charging,
    });
  }
  packetRows() {
    const query = this.packetFilter.toLowerCase();
    return this.packets().filter((p) =>
      (
        this.endpointName(p.endpoint) +
        ' ' +
        p.endpoint +
        ' ' +
        this.hex(p.endpoint) +
        ' ' +
        p.direction
      )
        .toLowerCase()
        .includes(query),
    );
  }
  endpointName(value: number) {
    return (
      {
        48: 'AppMessage',
        52: 'App run state',
        6033: 'App fetch',
        45531: 'BlobDB',
        48879: 'PutBytes',
        2001: 'Ping',
        17: 'Phone version',
        11: 'Time',
      }[value] ?? 'Endpoint ' + value
    );
  }
  packetHex(bytes: Uint8Array) {
    return (
      Array.from(bytes.subarray(0, 256), (b) => b.toString(16).padStart(2, '0')).join(' ') +
      (bytes.length > 256 ? ' …' : '')
    );
  }
  exportPackets() {
    this.download(
      'pebble-packets.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            version: 1,
            profile: this.profile(),
            packets: this.packets().map((p) => ({ ...p, bytes: Array.from(p.bytes) })),
          },
          null,
          2,
        ),
      ),
    );
  }
  injectPacket() {
    const endpoint = Number(this.injectEndpoint),
      hex = this.injectHex.replace(/\s+/g, '');
    if (
      !Number.isInteger(endpoint) ||
      endpoint < 0 ||
      endpoint > 65535 ||
      hex.length % 2 ||
      !/^[0-9a-f]*$/i.test(hex) ||
      hex.length > 131070
    ) {
      this.error.set('Enter an endpoint from 0 to 65535 and complete hexadecimal byte pairs.');
      return;
    }
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (v) => parseInt(v, 16));
    this.qemuWorker?.postMessage({ type: 'packet', endpoint, bytes });
  }
  setScript(data: {
    source: string;
    name: string;
    appId?: string;
    messageKeys?: Record<string, number>;
    appInfo?: Record<string, unknown>;
  }) {
    this.stopPhone();
    this.phoneAppId = data.appId ?? data.name;
    this.phoneKeys = data.messageKeys ?? {};
    this.phoneAppInfo = data.appInfo ?? {};
    this.phoneScript.set(data.source);
    this.phoneScriptName.set(data.name);
  }
  startPhone() {
    let fixtures = [],
      watchInfo = null;
    try {
      if (this.phoneNetworkMode === 'fixtures') {
        if (this.phoneFixtures.length > 4 * 1048576) throw new Error('Fixture JSON exceeds 4 MiB.');
        fixtures = JSON.parse(this.phoneFixtures);
        if (!Array.isArray(fixtures)) throw new Error('Network fixtures must be a JSON array.');
      }
      if (this.phoneWatchOverride.trim()) watchInfo = JSON.parse(this.phoneWatchOverride);
      else watchInfo = this.defaultWatchInfo();
    } catch (error) {
      this.error.set(String(error));
      return;
    }
    this.configuration.set(null);
    this.phoneGeneration = -1;
    this.phoneHttp.set([]);
    this.phoneWorker?.terminate();
    this.phoneWorker = new Worker(new URL('./phone.worker', import.meta.url), { type: 'module' });
    const phone = this.phoneWorker;
    this.phoneAccepting = true;
    this.phoneStatus.set('Starting…');
    this.phoneWorker.onmessage = ({ data }) => {
      if (this.phoneWorker !== phone) return;
      if (data.type === 'clock-ack')
        this.qemuWorker?.postMessage({
          type: 'phone-clock-ack',
          generation: data.transportGeneration,
          sequence: data.sequence,
        });
      if (data.type === 'status') {
        this.phoneStatus.set(data.status);
        if (data.phoneGeneration !== undefined) this.phoneGeneration = data.phoneGeneration;
      }
      if (data.type === 'network-result')
        this.phoneHttp.update((rows) => [...rows, JSON.stringify(data)].slice(-100));
      if (data.type === 'error') {
        this.qemuWorker?.postMessage({
          type: 'phone-clock',
          generation: this.watchGeneration,
          enabled: false,
        });
        this.phoneStatus.set('Error');
        this.log('PHONE', data.message);
      }
      if (data.type === 'inbound-result' && data.transportGeneration === this.watchGeneration)
        this.qemuWorker?.postMessage({
          type: 'appmessage-ack',
          generation: data.transportGeneration,
          transactionId: data.transactionId,
          accepted: data.accepted,
        });
      if (data.type === 'event') {
        const event = data.event;
        if (event.type === 'configuration' && this.phoneAccepting) {
          this.configuration.set({
            url: event.url,
            requestId: event.requestId,
            generation: data.phoneGeneration,
          });
          this.configurationResponse = '';
        }
        if (event.type === 'network-request' || event.type === 'network-cancel')
          this.phoneHttp.update((rows) => [...rows, JSON.stringify(event)].slice(-100));
        this.log(
          'PHONE',
          event.type === 'configuration'
            ? `Configuration ${event.requestId}: ${event.url.length} characters`
            : (event.text ?? event.message ?? JSON.stringify(event)),
        );
        if (event.type === 'outbound' && this.phoneAccepting) {
          if (!this.linked() || !this.isFirmware()) {
            phone.postMessage({ type: 'ack', transactionId: event.transactionId, accepted: false });
            return;
          }
          const wireId = this.phoneMessages.allocate(
            this.watchGeneration,
            event.transactionId,
            phone,
          );
          if (wireId === undefined) {
            this.log(
              'PHONE',
              'No free AppMessage transaction IDs; waiting for outstanding watch acknowledgements.',
            );
            phone.postMessage({ type: 'ack', transactionId: event.transactionId, accepted: false });
            return;
          }
          this.qemuWorker?.postMessage({
            type: 'appmessage',
            generation: this.watchGeneration,
            uuid: event.appId,
            transactionId: wireId,
            payload: event.payload,
          });
        }
      }
      if (data.type === 'storage') {
        try {
          sessionStorage.setItem('pebble.phone.' + data.appId, JSON.stringify(data.storage));
        } catch {}
      }
    };
    this.phoneWorker.onerror = (e) => {
      if (this.phoneWorker !== phone) return;
      this.qemuWorker?.postMessage({
        type: 'phone-clock',
        generation: this.watchGeneration,
        enabled: false,
      });
      this.phoneStatus.set('Error');
      this.log('PHONE', e.message);
    };
    let storage = {};
    try {
      storage = JSON.parse(sessionStorage.getItem('pebble.phone.' + this.phoneAppId) ?? '{}');
    } catch {}
    this.phoneWorker.postMessage({
      type: 'start',
      wasmUrl: new URL('wasm/quickjs.wasm', document.baseURI).href,
      source: this.phoneScript(),
      name: this.phoneScriptName(),
      appId: this.phoneAppId,
      messageKeys: this.phoneKeys,
      appInfo: this.phoneAppInfo,
      watchInfo,
      accountToken: this.accountToken,
      watchToken: this.watchToken,
      network: { mode: this.phoneNetworkMode, fixtures },
      storage,
      coordinates: {
        latitude: this.latitude,
        longitude: this.longitude,
        accuracy: this.accuracy,
        altitude: this.altitude,
        heading: this.locationHeading,
        speed: this.speed,
      },
      connected: this.linked(),
      clock: this.isFirmware() ? 'watch' : 'wall',
      nowMs: this.isFirmware() ? Math.floor(this.watchEpochMs) : Date.now(),
      virtualUs: Math.round(this.virtualSeconds() * 1e6),
      randomSeed: 1,
    });
    if (this.isFirmware())
      this.qemuWorker?.postMessage({
        type: 'phone-clock',
        generation: this.watchGeneration,
        enabled: true,
      });
  }
  stopPhone() {
    this.qemuWorker?.postMessage({
      type: 'phone-clock',
      generation: this.watchGeneration,
      enabled: false,
    });
    this.configuration.set(null);
    this.phoneAccepting = false;
    this.phoneWorker?.postMessage({ type: 'stop' });
  }
  defaultWatchInfo() {
    const version = this.firmwareName().match(/v?(\d+)\.(\d+)\.(\d+)([-+][\w.-]+)?/);
    if (!this.isFirmware() || !version) return null;
    const profile = this.profile() as FirmwareProfile;
    return {
      platform: this.appPlatform(),
      model: FIRMWARE_PROFILES[profile].model,
      language: 'en_US',
      firmware: {
        major: +version[1],
        minor: +version[2],
        patch: +version[3],
        suffix: version[4] ?? '',
      },
    };
  }
  showConfiguration() {
    this.phoneWorker?.postMessage({ type: 'configuration' });
  }
  closeConfiguration(canceled = false) {
    const view = this.configuration();
    if (!view) return;
    this.phoneWorker?.postMessage({
      type: 'configurationClosed',
      requestId: view.requestId,
      phoneGeneration: view.generation,
      response: canceled ? null : this.configurationResponse,
    });
    this.configuration.set(null);
  }
  configurationLink() {
    const url = this.configuration()?.url ?? '';
    return /^https?:\/\//i.test(url) ? url : null;
  }
  advancePhone() {
    this.phoneWorker?.postMessage({ type: 'advance', milliseconds: 1000 });
  }
  locationDemo() {
    this.setScript({
      name: 'Location test',
      source: `Pebble.addEventListener('ready', function () {
  navigator.geolocation.watchPosition(function (position) {
    console.log('Location', position.coords.latitude, position.coords.longitude, 'accuracy', position.coords.accuracy);
  });
});`,
    });
    this.startPhone();
  }
  applyLocation() {
    if (
      !Number.isFinite(this.latitude) ||
      Math.abs(this.latitude) > 90 ||
      !Number.isFinite(this.longitude) ||
      Math.abs(this.longitude) > 180 ||
      !Number.isFinite(this.accuracy) ||
      this.accuracy < 0
    ) {
      this.error.set('Enter valid latitude, longitude, and nonnegative accuracy.');
      return;
    }
    if (this.phoneStatus() !== 'Running') {
      this.log('PHONE', 'Location saved. Start a phone script to deliver it.');
      return;
    }
    this.phoneWorker?.postMessage({
      type: 'location',
      coordinates: {
        latitude: this.latitude,
        longitude: this.longitude,
        accuracy: this.accuracy,
        altitude: this.altitude,
        heading: this.locationHeading,
        speed: this.speed,
      },
    });
  }
  setClock() {
    const epoch = new Date(this.epochValue + 'Z').getTime() / 1000;
    if (Number.isFinite(epoch)) {
      this.stopPhone();
      this.watchEpochMs = Math.floor(epoch * 1000);
      this.qemuWorker?.postMessage({ type: 'epoch', epoch });
      this.log('CLOCK', 'Watch time changed. Start the phone script to use the new clock origin.');
    }
  }
}
