import {
  FIRMWARE_PROFILES,
  profileDisplay,
  isFirmwareProfile,
  type FirmwareProfile,
  type MachineProfile,
} from './watch-profiles.ts';
import { AppMessageRouter } from './app-message-router.ts';
import { BufferedHistory } from './buffered-history.ts';
import { PreferencesPanel } from './preferences-panel.ts';
import { startupCheckpointsEnabled } from './startup-checkpoint.ts';
import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirmwarePanel } from './firmware-panel.ts';
import { ProjectPanel } from './project-panel.ts';
import { PreviewPanel, type PreviewLaunch } from './preview-panel.ts';
import {
  PhoneAppPanel,
  type PhoneConfiguration,
  type PhoneConfigurationResult,
} from './phone-app-panel.ts';
import { saveFirmware, type PreviewFirmware } from './preview-firmware.ts';
import { DemoSettingsPanel } from './demo-settings-panel.ts';
import {
  defaultDemoSettings,
  readDemoSettings,
  normalizeDemoSettings,
  DEMO_STORAGE_KEY,
  type DemoSettings,
} from './demo-settings.ts';
import { watchModelSpec, modelSource } from './watch-model-specs.ts';
import type { SourceSnapshot } from './projects.ts';
import { SensorPanel, type SignalObservation } from './sensor-panel.ts';
import { FramePanel } from './frame-panel.ts';
import type { DeviceSignal, SignalScenario } from './signals.ts';
import { boardDescriptor } from './board-registry.ts';
import { screenPoint } from './watch-gestures.ts';
import { renderPixels, type DisplayMode } from './display.ts';
import type { WatchModel } from './watch-model.ts';
import type { LightingEnvironment } from './watch-lighting.ts';
import type { OpticalStyle } from './watch-optics.ts';
import { registerInspector, type InspectorRegistry } from './inspector-tools';
import type { EmulatorCommand, EmulatorEvent, MachineState } from './emulator.types';
import { WEATHER_CONDITIONS, type WeatherCondition } from './weather-records.ts';
import {
  coordinateName,
  fetchForecast,
  weatherReading,
  type WeatherUnits,
} from './weather-source.ts';

/** The operating system's colour-scheme preference, false where unsupported. */
function prefersDarkTheme(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    DecimalPipe,
    FirmwarePanel,
    ProjectPanel,
    SensorPanel,
    FramePanel,
    PreviewPanel,
    PhoneAppPanel,
    DemoSettingsPanel,
    PreferencesPanel,
  ],
  templateUrl: './app.html',
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('screen') screen!: ElementRef<HTMLCanvasElement>;
  @ViewChild(PreviewPanel) preview?: PreviewPanel;
  @ViewChild('projectEditor') projectEditor?: ProjectPanel;
  workbench = signal(false);
  toolsOpened = signal(false);
  previewBusy = signal(false);
  previewStatus = signal('');
  activeAppName = signal('Watch preview');
  /** What the installed package is, for labelling only. */
  activeAppRole = signal<'watchface' | 'app'>('app');
  previewSource = signal<SourceSnapshot | null>(null);
  private pendingPreview?: PreviewLaunch['package'];
  private firmwareToSave?: PreviewFirmware;
  private autoRunFirmware = false;
  private sourcePreview = false;
  settingsOpen = signal(false);
  demoSettings = signal(defaultDemoSettings());
  demoBusy = signal(false);
  demoStatus = signal('');
  private previewSession = false;
  private demoPrepared = false;
  private demoRevision = 0;
  private demoStorageNotice = '';
  private releaseButtons = () => {
    this.releaseTouch();
    this.pointerButtons.clear();
    this.keyButtons.clear();
    if (this.buttons) this.handleButton(15, false);
  };
  private pointerButtons = new Map<number, number>();
  private keyButtons = new Map<string, number>();
  touchMode = signal(false);
  private touchPointer?: number;
  private touchPosition?: { x: number; y: number };
  private resumeVisible = false;
  private visibility = () => {
    if (document.hidden) this.releaseButtons();
    this.model?.setActive(!document.hidden && this.displayMode() === 'model');
    if (document.hidden && !this.workbench() && this.running() && !this.installing()) {
      this.resumeVisible = true;
      this.pause();
    } else if (!document.hidden && this.resumeVisible) {
      this.resumeVisible = false;
      this.run();
    }
  };
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
  buildPlatform() {
    return this.sourcePreview && this.preview
      ? FIRMWARE_PROFILES[this.preview.profile()].platform
      : this.appPlatform();
  }
  hasModel() {
    return !!watchModelSpec(this.profile());
  }
  modelSpec() {
    return watchModelSpec(this.profile());
  }
  modelSource() {
    return modelSource(this.modelSpec());
  }
  buttonTop(mask: number) {
    return this.modelSpec().buttons.find((b) => b.mask === mask)?.top ?? 50;
  }
  modelButtons = signal<{ mask: number; x: number; y: number; visible: boolean }[]>([]);
  displayMode = signal<DisplayMode>('pixels');
  theme = signal('light');
  ambient = 80;
  backlight = 0;
  lightingEnvironment: LightingEnvironment = 'studio';
  opticalStyle: OpticalStyle = 'layered';
  opticalNotice = signal('');
  lightAzimuth = -35;
  finish = 'silver';
  zoom = 2;
  modelStatus = signal('');
  private model?: WatchModel;
  private modelAbort?: AbortController;
  private modelLoading = false;
  private modelLoaded = false;
  private modelProfile?: MachineProfile;
  private modelRevision = 0;
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
  timelineToken = '';
  phoneHttp = signal<string[]>([]);
  configuration = signal<PhoneConfiguration | null>(null);
  configurationPending = signal(false);
  configurationNotice = signal('');
  appConfigurable = signal(false);
  private configurationTimeout?: ReturnType<typeof setTimeout>;
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
  /** Off until asked for: the watch should not show weather nobody set. */
  weatherMode: 'off' | 'live' | 'manual' = 'off';
  weatherUnits: WeatherUnits = 'celsius';
  /** Blank follows the simulated position, shown as its coordinates. */
  weatherLocationName = '';
  weatherPhrase = 'Partly cloudy';
  weatherCondition: WeatherCondition = 'PartlyCloudy';
  weatherTemperature = 18;
  weatherTodayHigh = 21;
  weatherTodayLow = 12;
  weatherTomorrowCondition: WeatherCondition = 'Sun';
  weatherTomorrowHigh = 23;
  weatherTomorrowLow = 13;
  weatherStatus = signal('');
  weatherBusy = signal(false);
  readonly weatherConditions = Object.keys(WEATHER_CONDITIONS) as WeatherCondition[];
  phoneStatus = signal('Stopped');
  watchReady = signal(false);
  linked = signal(false);
  installing = signal(false);
  restartRequired = signal(false);
  private installWatchdog?: ReturnType<typeof setTimeout>;
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
    { name: 'Back', mask: 1, icon: '‹', side: 'left', key: 'ArrowLeft' },
    { name: 'Up', mask: 2, icon: '⌃', side: 'right', key: 'ArrowUp' },
    { name: 'Select', mask: 4, icon: '●', side: 'right', key: 'ArrowRight' },
    { name: 'Down', mask: 8, icon: '⌄', side: 'right', key: 'ArrowDown' },
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
  private screenImage?: ImageData;
  private traceUpdates = new BufferedHistory<{ index: number; kind: string; text: string }>(
    200,
    (items) => this.trace.update((rows) => [...rows, ...items].slice(-200)),
  );
  private packetUpdates = new BufferedHistory<{
    id: number;
    direction: string;
    endpoint: number;
    bytes: Uint8Array;
    time: number;
  }>(300, (items) => this.packets.update((rows) => [...rows, ...items].slice(-300)));
  private saved?: { bytes: Uint8Array; name: string };
  private inputRevision = 0;
  private loadRevision = 0;
  protected hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
  ngAfterViewInit() {
    this.demoSettings.set(readDemoSettings());
    try {
      // Follow the operating system until the viewer picks a theme, so a
      // dark desktop does not open to a full-brightness page.
      const stored = localStorage.getItem('pebble.theme');
      this.setTheme(stored ?? (prefersDarkTheme() ? 'dark' : 'light'));
    } catch {}
    this.cleanupInspector = registerInspector(
      (document as Document & { modelContext?: InspectorRegistry }).modelContext,
      () => this.state(),
    );
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('blur', this.releaseButtons);
  }
  private startDiagnosticCore() {
    if (this.worker) return;
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
    this.clearInstallWatchdog();
    this.traceUpdates.dispose();
    this.packetUpdates.dispose();
    this.clearConfiguration();
    this.cleanupInspector();
    this.worker?.terminate();
    this.qemuWorker?.terminate();
    this.phoneWorker?.terminate();
    this.modelAbort?.abort();
    this.model?.dispose();
    document.removeEventListener('visibilitychange', this.visibility);
    window.removeEventListener('blur', this.releaseButtons);
  }
  showTools(tab?: string) {
    this.traceUpdates.flush();
    this.packetUpdates.flush();
    this.toolsOpened.set(true);
    this.workbench.set(true);
    if (tab) this.tab.set(tab);
    this.startDiagnosticCore();
  }
  showPreview() {
    this.workbench.set(false);
  }
  beginPreview() {
    if (this.sourcePreview) this.projectEditor?.cancel();
    this.sourcePreview = false;
    this.previewSource.set(null);
  }
  async startPreview(data: PreviewLaunch) {
    this.previewSession = true;
    this.sourcePreview = false;
    this.workbench.set(false);
    this.error.set('');
    this.pendingPreview = data.package;
    this.previewBusy.set(true);
    if (data.firmware) {
      this.previewStatus.set('Starting firmware…');
      await this.loadFirmware(data.firmware, true);
    } else if (this.profile() === data.profile && this.loaded()) {
      this.qemuWorker?.postMessage({ type: 'pacing', realtime: true });
      if (this.watchReady()) this.preparePreview();
      else {
        this.previewStatus.set('Starting firmware…');
        this.run();
      }
    } else {
      this.pendingPreview = undefined;
      this.previewBusy.set(false);
      this.error.set('Set up matching firmware before starting this preview.');
    }
  }
  private preparePreview() {
    if (this.previewSession && !this.demoPrepared && this.demoSettings().enabled) {
      if (!this.demoBusy()) {
        this.previewStatus.set('Preparing demo data…');
        this.applyDemo(this.demoSettings());
      }
    } else this.installPreview();
  }
  saveDemo(value: DemoSettings) {
    try {
      const settings = normalizeDemoSettings(value);
      this.demoSettings.set(settings);
      this.demoPrepared = false;
      let saved = true;
      try {
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(settings));
      } catch {
        saved = false;
      }
      this.demoStorageNotice = saved
        ? ''
        : ' Browser storage is unavailable; settings last for this session.';
      this.demoStatus.set(
        saved
          ? 'Settings saved in this browser.'
          : 'Settings retained for this session; browser storage is unavailable.',
      );
      if (this.isFirmware() && this.watchReady()) this.applyDemo(settings);
    } catch (e) {
      this.demoStatus.set(String(e));
    }
  }
  private applyDemo(settings: DemoSettings, notificationId?: number) {
    if (!this.watchReady() || this.demoBusy() || this.installing()) return;
    this.demoBusy.set(true);
    this.demoStatus.set(
      notificationId === undefined ? 'Applying sample data to the watch…' : 'Sending notification…',
    );
    if (settings.enabled && settings.location && notificationId === undefined) {
      this.latitude = settings.latitude;
      this.longitude = settings.longitude;
      this.accuracy = settings.accuracy;
      this.altitude = this.locationHeading = this.speed = null;
    }
    if (notificationId === undefined) this.deliverLocationAvailability(settings.location);
    this.qemuWorker?.postMessage({
      type: notificationId === undefined ? 'demo-settings' : 'demo-notification',
      settings,
      id: notificationId,
      generation: this.watchGeneration,
      revision: ++this.demoRevision,
    });
  }
  notifyDemo(value: { settings: DemoSettings; id: number }) {
    this.applyDemo(value.settings, value.id);
  }
  private installPreview() {
    const pkg = this.pendingPreview;
    if (!pkg) return;
    this.pendingPreview = undefined;
    this.previewStatus.set('Installing app…');
    this.installPackage(pkg);
    if (!this.running()) this.run();
  }
  cancelPreview() {
    this.qemuWorker?.postMessage({ type: 'cancel-startup' });
    this.beginPreview();
    const cancelInstall =
      this.installing() || this.demoBusy() || (this.previewBusy() && !this.pendingPreview);
    this.pendingPreview = undefined;
    this.firmwareToSave = undefined;
    this.autoRunFirmware = false;
    this.demoRevision++;
    this.loadRevision++;
    this.previewBusy.set(false);
    this.previewStatus.set('Preview canceled.');
    this.resumeVisible = false;
    if (cancelInstall && this.isFirmware()) this.discardEmulator();
    else if (this.isFirmware()) {
      this.qemuWorker?.postMessage({ type: 'pause' });
      this.running.set(false);
    }
  }
  openPreviewSource(source: SourceSnapshot) {
    this.sourcePreview = true;
    this.previewSource.set(source);
    this.showTools('Projects');
  }
  projectPackage(data: { bytes: Uint8Array; name: string }) {
    if (this.sourcePreview) {
      this.workbench.set(false);
      void this.preview?.builtPackage(data);
    } else this.installPackage(data);
  }
  send(command: EmulatorCommand) {
    if (this.ready()) (this.isFirmware() ? this.qemuWorker : this.worker)?.postMessage(command);
  }
  log(kind: string, text: string) {
    this.traceUpdates.append({
      index: ++this.index,
      kind,
      text: text.length > 6000 ? text.slice(0, 6000) + ' …' : text,
    });
  }
  clearTrace() {
    this.traceUpdates.dispose();
    this.trace.set([]);
  }
  clearPackets() {
    this.packetUpdates.dispose();
    this.packets.set([]);
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
    if (this.displayMode() === 'model') void this.setDisplay('model');
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
    this.releaseTouch();
    this.running.set(false);
    this.send({ type: 'pause' });
  }
  reset() {
    this.clearInstallWatchdog();
    this.releaseTouch();
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
  private clearInstallWatchdog() {
    clearTimeout(this.installWatchdog);
    this.installWatchdog = undefined;
  }
  private trackInstallProgress() {
    this.clearInstallWatchdog();
    this.installWatchdog = setTimeout(() => {
      this.discardEmulator();
      this.error.set(
        'The app made no installation progress for 45 seconds. Restart the preview or choose another app.',
      );
      this.previewStatus.set('Installation stopped. You can restart the preview.');
    }, 45000);
  }
  private discardEmulator() {
    this.clearInstallWatchdog();
    this.loadRevision++;
    this.stopPhone();
    this.qemuWorker?.terminate();
    this.qemuWorker = undefined;
    this.qemuReady = undefined;
    this.running.set(false);
    this.installing.set(false);
    this.previewBusy.set(false);
    this.demoBusy.set(false);
    this.demoPrepared = false;
    this.pendingPreview = undefined;
    this.watchReady.set(false);
    this.firmwareToSave = undefined;
    this.autoRunFirmware = false;
    this.loaded.set(false);
    this.ready.set(false);
    this.restartRequired.set(true);
    this.resumeVisible = false;
    this.touchPointer = undefined;
    this.touchPosition = undefined;
    this.pointerButtons.clear();
    this.keyButtons.clear();
    this.buttons = 0;
    this.linked.set(false);
  }
  canRestartPreview() {
    return !!this.preview?.package();
  }
  restartPreview() {
    if (!this.preview?.package()) return;
    this.discardEmulator();
    this.error.set('');
    void this.preview.restart();
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
    const next = pressed ? this.buttons | mask : this.buttons & ~mask;
    if (next === this.buttons) return;
    this.buttons = next;
    this.send({
      type: 'inputs',
      buttons: this.buttons,
      battery: this.battery(),
      inputRevision: ++this.inputRevision,
    });
  }
  pointerButton(event: PointerEvent, mask: number, down: boolean) {
    if (down && event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    if (down) {
      element.focus({ preventScroll: true });
      element.setPointerCapture(event.pointerId);
      this.pointerButtons.set(event.pointerId, mask);
    } else {
      this.pointerButtons.delete(event.pointerId);
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
    }
    this.handleButton(
      mask,
      down || [...this.pointerButtons.values(), ...this.keyButtons.values()].includes(mask),
    );
  }
  keyButton(value: Event, mask: number, down: boolean) {
    const event = value as KeyboardEvent;
    if (typeof event.key !== 'string') return;
    event.preventDefault();
    if (event.repeat || !this.loaded() || this.demoBusy()) return;
    if (down) this.keyButtons.set(event.key, mask);
    else this.keyButtons.delete(event.key);
    this.handleButton(
      mask,
      [...this.pointerButtons.values(), ...this.keyButtons.values()].includes(mask),
    );
  }
  releaseKeys() {
    const masks = new Set(this.keyButtons.values());
    this.keyButtons.clear();
    for (const mask of masks)
      this.handleButton(mask, [...this.pointerButtons.values()].includes(mask));
  }
  watchKey(event: KeyboardEvent, down: boolean) {
    const mask = this.buttonList.find((b) => b.key === event.key)?.mask;
    if (!mask || !this.loaded() || this.settingsOpen()) return;
    this.keyButton(event, mask, down);
  }
  buttonPosition(mask: number) {
    if (this.displayMode() === 'model') return this.modelButtons().find((b) => b.mask === mask);
    return undefined;
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
    this.traceUpdates.flush();
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
      if (this.displayMode() === 'model') void this.setDisplay('model');
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
    const { width, height } = this.display();
    if (bytes.length !== width * height) return;
    if (this.screenImage?.width !== width || this.screenImage.height !== height)
      this.screenImage = context.createImageData(width, height);
    const rgba = renderPixels(
      bytes,
      {
        mode: this.displayMode(),
        ambient: this.ambient / 100,
        backlight: this.backlight / 100,
      },
      this.screenImage.data,
    );
    const canvas = this.screen.nativeElement;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.putImageData(this.screenImage, 0, 0);
    if (this.hasModel() && this.displayMode() === 'model' && this.modelProfile === this.profile())
      this.model?.pixels(rgba, bytes);
  }
  redraw() {
    const state = this.state();
    if (state) this.draw(state.framebuffer);
    this.model?.finish(this.finish);
    this.model?.setOpticalStyle(this.opticalStyle);
    this.opticalNotice.set(this.model?.opticalNotice() ?? '');
    this.model?.setLighting({
      environment: this.lightingEnvironment,
      ambient: this.ambient / 100,
      backlight: this.backlight / 100,
      azimuth: this.lightAzimuth,
    });
  }
  setTheme(value: string) {
    this.theme.set(value);
    document.documentElement.dataset['theme'] = value;
    // Keep the browser's own chrome (address bar, overscroll) on the same
    // surface as the page background.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'dark' ? '#141210' : '#f3efe9');
    try {
      localStorage.setItem('pebble.theme', value);
    } catch {}
  }
  async setDisplay(mode: DisplayMode) {
    if (mode === 'model' && !this.hasModel()) return;
    this.releaseTouch();
    this.displayMode.set(mode);
    this.model?.setActive(mode === 'model' && !document.hidden);
    this.model?.setTouchMode(this.touchMode() && this.touchAvailable());
    if (mode !== 'model') {
      this.redraw();
      return;
    }
    if (this.modelProfile !== this.profile()) {
      this.modelAbort?.abort();
      this.modelLoading = false;
      this.modelLoaded = false;
      this.modelProfile = this.profile();
      this.modelRevision++;
      this.modelButtons.set([]);
      this.model?.setSpec(this.modelSpec());
    }
    this.redraw();
    if (this.modelLoaded || this.modelLoading) return;
    this.modelLoading = true;
    const revision = ++this.modelRevision;
    this.modelStatus.set('Loading 3D model…');
    const controller = (this.modelAbort = new AbortController());
    try {
      if (!this.model) {
        const { WatchModel } = await import('./watch-model.ts');
        if (this.destroyed || revision !== this.modelRevision) return;
        this.model = new WatchModel(this.modelHost.nativeElement, this.modelSpec(), (positions) => {
          if (!this.destroyed) this.modelButtons.set(positions);
        });
      }
      const model = this.model;
      model.setTouchMode(this.touchMode() && this.touchAvailable());
      model.setActive(this.displayMode() === 'model' && !document.hidden);
      this.redraw();
      await model.load(controller.signal);
      if (this.destroyed || revision !== this.modelRevision) return;
      this.modelLoaded = true;
      this.modelStatus.set('');
      this.redraw();
    } catch (e) {
      if (!this.destroyed && revision === this.modelRevision) {
        this.modelStatus.set(String(e));
      }
    } finally {
      if (revision === this.modelRevision) this.modelLoading = false;
    }
  }
  resetModel() {
    this.model?.reset();
  }
  async loadFirmware(
    data: {
      micro: Uint8Array;
      flash: Uint8Array;
      name: string;
      profile?: FirmwareProfile;
    },
    autoRun = false,
  ) {
    const revision = ++this.loadRevision;
    if (!autoRun) this.previewSession = false;
    this.autoRunFirmware = autoRun;
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
              if (data.command === 'install') {
                this.clearInstallWatchdog();
                this.installing.set(false);
                this.restartRequired.set(true);
              }
              if (data.command?.startsWith('demo-') && data.generation === this.watchGeneration) {
                this.demoBusy.set(false);
                this.demoStatus.set('Demo setup failed: ' + data.message);
              }
              this.firmwareToSave = undefined;
              this.error.set(data.message);
              if (data.command === 'health-settings' && data.generation === this.watchGeneration)
                this.healthStatus.set(data.message);
              this.running.set(false);
              this.pendingPreview = undefined;
              this.previewBusy.set(false);
              this.previewStatus.set('Preview stopped. See the error above.');
              reject(new Error(data.message));
              return;
            }
            this.handleQemuEvent(data);
            if (data.type === 'state' && this.isFirmware()) {
              if (data.generation !== this.watchGeneration) return;
              const pixels = data.state.framebuffer ?? this.state()?.framebuffer;
              if (!pixels) throw new Error('Watch state arrived before its initial frame.');
              this.state.set({ ...data.state, framebuffer: pixels });
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
              if (data.state.framebuffer) this.draw(data.state.framebuffer);
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
            this.error.set(
              e.message || 'The emulator stopped unexpectedly. Open the app again to restart it.',
            );
            this.discardEmulator();
            this.previewStatus.set('Emulator stopped. Restart the preview to retry.');
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
      this.qemuWorker.postMessage({ type: 'presentation', deltaFrames: true });
      this.firmwareToSave =
        !autoRun && data.profile ? { ...data, profile: data.profile } : undefined;
      this.qemuWorker.postMessage({ type: 'pacing', realtime: autoRun });
      this.qemuWorker.postMessage({
        type: 'firmware',
        ...data,
        startup: autoRun && startupCheckpointsEnabled(),
      });
      this.log('LOAD', data.name);
      if (!autoRun) this.tab.set('Inputs');
    } catch (e) {
      if (revision !== this.loadRevision) return;
      this.qemuWorker?.terminate();
      this.qemuWorker = undefined;
      this.qemuReady = undefined;
      this.error.set(String(e));
      this.pendingPreview = undefined;
      this.previewBusy.set(false);
    }
  }
  installPackage(data: { bytes: Uint8Array; name: string }) {
    if (this.installing() || this.demoBusy()) {
      this.error.set(
        'Wait for the current installation or setup to finish, or cancel the preview.',
      );
      return;
    }
    if (!this.isFirmware() || !this.watchReady()) {
      this.error.set(
        'Load and run matching emulator firmware until boot completes, then install the app.',
      );
      return;
    }
    this.error.set('');
    this.releaseTouch();
    this.stopPhone();
    this.installing.set(true);
    this.trackInstallProgress();
    this.qemuWorker?.postMessage({ type: 'install', ...data });
  }
  handleQemuEvent(data: any) {
    if (data.type === 'startup-status') this.log('STARTUP', data.message);
    if (data.generation === this.watchGeneration && data.revision === this.demoRevision) {
      if (data.type === 'demo-status') this.demoBusy.set(data.busy);
      if (data.type === 'demo-applied') {
        this.demoBusy.set(false);
        this.demoStatus.set(
          (data.popup
            ? 'Notification sent to the watch.'
            : `${data.notifications} messages and ${data.calendar} events applied. ${data.heartRate ? 'Synthetic heart rate is running.' : ''}`) +
            this.demoStorageNotice,
        );
        if (!data.popup) {
          this.demoPrepared = true;
          this.installPreview();
        }
      }
    }
    if (data.type === 'demo-stopped' && data.generation === this.watchGeneration)
      this.demoStatus.set('Demo signal stream stopped by the developer scenario.');
    if (data.type === 'health-settings' && data.generation === this.watchGeneration)
      this.healthStatus.set('Firmware accepted the health preferences.');
    if (data.type === 'weather-applied' && data.generation === this.watchGeneration)
      this.weatherStatus.set(
        data.published
          ? 'Firmware stored the forecast. Open the Weather app on the watch.'
          : 'Forecast removed from the watch.',
      );
    if (data.type === 'clock' && data.generation === this.watchGeneration) {
      this.watchEpochMs = data.epochMs;
      if (!data.direct && this.phoneAccepting)
        this.phoneWorker?.postMessage({
          type: 'clock',
          virtualUs: data.virtualUs,
          sequence: data.sequence,
          transportGeneration: data.generation,
        });
      else if (!data.direct && data.sequence !== undefined)
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
      this.restartRequired.set(false);
      const saved = this.firmwareToSave;
      this.firmwareToSave = undefined;
      if (saved && saved.profile === data.profile && saved.name === data.name)
        void saveFirmware(saved).catch(() =>
          this.log('STORAGE', 'Firmware loaded for this session; local storage is unavailable.'),
        );
      this.stopPhone();
      this.profile.set(data.profile);
      this.ready.set(true);
      this.watchReady.set(false);
      this.buttons = 0;
      if (this.displayMode() === 'model') void this.setDisplay('model');
      if (this.autoRunFirmware) {
        this.autoRunFirmware = false;
        this.qemuWorker?.postMessage({ type: 'run' });
      }
      return;
    }
    if (data.type === 'session') {
      this.clearInstallWatchdog();
      this.touchPointer = undefined;
      this.touchPosition = undefined;
      this.pointerButtons.clear();
      this.keyButtons.clear();
      this.buttons = 0;
      this.demoRevision++;
      this.demoBusy.set(false);
      this.demoPrepared = false;
      this.watchReady.set(false);
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
      this.preparePreview();
      this.preview?.resumeAfterFirmware();
    }
    if (data.type === 'connection') {
      this.linked.set(data.connected);
      this.phoneWorker?.postMessage({ type: 'connection', connected: data.connected });
    }
    if (data.type === 'install-status') {
      this.installing.set(data.busy);
      this.installStatus.set(data.message);
      if (data.busy) this.trackInstallProgress();
      else this.clearInstallWatchdog();
      if (this.previewBusy() && data.busy) this.previewStatus.set(data.message);
    }
    if (data.type === 'installed') {
      this.clearInstallWatchdog();
      this.activeAppName.set(
        String(data.appinfo.shortName ?? data.appinfo.displayName ?? data.name),
      );
      // A watchface is the idle screen; a watchapp is launched from the
      // launcher. Both drive the whole watch, so this only decides what the
      // interface calls the thing it just installed.
      this.activeAppRole.set(data.appinfo?.watchapp?.watchface === true ? 'watchface' : 'app');
      this.installStatus.set(
        'Installed and launched: ' +
          data.uuid +
          (data.compatibility === 'legacy' ? ` (${data.selectedPlatform} legacy build)` : ''),
      );
      this.log('INSTALL', this.installStatus());
      this.setScript({
        source: data.script,
        name: data.name + '/pebble-js-app.js',
        appId: data.uuid,
        messageKeys: data.appinfo.appKeys ?? {},
        appInfo: data.appinfo,
      });
      if (data.script) this.startPhone();
      this.previewBusy.set(false);
      this.previewStatus.set('Ready. Use the watch buttons to interact.');
      this.preview?.collapseOnPhone();
      if (typeof matchMedia === 'function' && matchMedia('(max-width: 780px)').matches)
        requestAnimationFrame(() =>
          this.screen?.nativeElement.closest('.display-panel')?.scrollIntoView({ block: 'start' }),
        );
    }
    if (data.type === 'protocol') {
      this.packetUpdates.append({
        id: ++this.packetIndex,
        direction: data.direction,
        endpoint: data.endpoint,
        bytes: data.bytes,
        time: data.virtualSeconds,
      });
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
  quickInputReady() {
    return (
      this.isFirmware() &&
      this.watchReady() &&
      this.running() &&
      !this.previewBusy() &&
      !this.installing() &&
      !this.demoBusy()
    );
  }
  touchAvailable() {
    const profile = this.profile();
    return (
      isFirmwareProfile(profile) && boardDescriptor(profile).inputs['touch'] === 'touch-controller'
    );
  }
  shakeWrist() {
    if (this.quickInputReady()) this.qemuWorker?.postMessage({ type: 'wrist-shake' });
  }
  toggleScreenTouch() {
    this.releaseTouch();
    this.touchMode.update((value) => !value);
    this.model?.setTouchMode(this.touchMode() && this.touchAvailable());
  }
  screenTouch(event: PointerEvent, phase: 'down' | 'move' | 'up', model = false) {
    if (phase === 'up') {
      if (event.pointerId === this.touchPointer) this.releaseTouch();
      return;
    }
    if (!this.quickInputReady() || !this.touchAvailable() || (model && !this.touchMode())) return;
    if (
      phase === 'down' &&
      (event.button !== 0 || !event.isPrimary || this.touchPointer !== undefined)
    )
      return;
    if (phase === 'move' && event.pointerId !== this.touchPointer) return;
    const target = event.currentTarget as HTMLElement;
    const box = target.getBoundingClientRect();
    const point = model
      ? this.model?.touchPoint(event.clientX, event.clientY)
      : screenPoint(
          (event.clientX - box.left) / box.width,
          (event.clientY - box.top) / box.height,
          this.display(),
        );
    if (!point) {
      if (event.pointerId === this.touchPointer) this.releaseTouch();
      return;
    }
    event.preventDefault();
    if (phase === 'down') {
      this.touchPointer = event.pointerId;
      target.setPointerCapture(event.pointerId);
    } else if (point.x === this.touchPosition?.x && point.y === this.touchPosition?.y) return;
    this.touchPosition = point;
    this.sendSignal({ kind: 'touch', down: true, ...point });
  }
  private releaseTouch() {
    if (this.touchPointer !== undefined && this.touchPosition)
      this.sendSignal({ kind: 'touch', down: false, ...this.touchPosition });
    this.touchPointer = undefined;
    this.touchPosition = undefined;
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
  /**
   * Publishes one forecast to the watch's weather database. Live readings come
   * from Open-Meteo for the simulated position, which is the location the rest
   * of the emulator reports; manual values go through the same record, so what
   * the watch reads is identical either way.
   */
  async applyWeather() {
    if (!this.watchReady()) {
      this.weatherStatus.set('Wait for the watch to finish booting.');
      return;
    }
    if (this.weatherMode === 'off') {
      this.withdrawWeather();
      return;
    }
    const name = this.weatherLocationName.trim();
    if (!name && (!Number.isFinite(this.latitude) || !Number.isFinite(this.longitude))) {
      this.weatherStatus.set('Set a location name or valid coordinates first.');
      return;
    }
    this.weatherBusy.set(true);
    try {
      let reading;
      if (this.weatherMode === 'live') {
        this.weatherStatus.set('Fetching the forecast…');
        const forecast = await fetchForecast({
          latitude: this.latitude,
          longitude: this.longitude,
          units: this.weatherUnits,
        });
        reading = weatherReading(
          forecast,
          name || coordinateName(this.latitude, this.longitude),
          true,
        );
        // Show the user what was actually received rather than leaving the
        // manual fields saying something else.
        this.weatherCondition = forecast.condition;
        this.weatherPhrase = forecast.shortPhrase;
        this.weatherTemperature = forecast.currentTemperature;
        this.weatherTodayHigh = forecast.todayHigh;
        this.weatherTodayLow = forecast.todayLow;
        this.weatherTomorrowCondition = forecast.tomorrowCondition;
        this.weatherTomorrowHigh = forecast.tomorrowHigh;
        this.weatherTomorrowLow = forecast.tomorrowLow;
      } else {
        reading = weatherReading(
          {
            locationName: name,
            shortPhrase: this.weatherPhrase.trim(),
            condition: this.weatherCondition,
            currentTemperature: Math.round(this.weatherTemperature),
            todayHigh: Math.round(this.weatherTodayHigh),
            todayLow: Math.round(this.weatherTodayLow),
            tomorrowCondition: this.weatherTomorrowCondition,
            tomorrowHigh: Math.round(this.weatherTomorrowHigh),
            tomorrowLow: Math.round(this.weatherTomorrowLow),
          },
          name || coordinateName(this.latitude, this.longitude),
          false,
        );
      }
      this.weatherStatus.set('Sending to the watch…');
      this.qemuWorker?.postMessage({ type: 'weather', reading });
    } catch (error) {
      // A forecast we could not fetch is reported, never replaced with one we
      // made up.
      this.weatherStatus.set(`Weather unavailable: ${(error as Error).message}`);
    } finally {
      this.weatherBusy.set(false);
    }
  }
  /** Takes the forecast back off the watch, leaving no stale reading behind. */
  withdrawWeather() {
    if (!this.watchReady()) {
      this.weatherStatus.set('Wait for the watch to finish booting.');
      return;
    }
    this.weatherStatus.set('Removing the forecast…');
    this.qemuWorker?.postMessage({ type: 'weather', reading: null });
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
    this.packetUpdates.flush();
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
    this.appConfigurable.set(
      Array.isArray(this.phoneAppInfo['capabilities']) &&
        this.phoneAppInfo['capabilities'].includes('configurable'),
    );
    this.phoneScript.set(data.source);
    this.phoneScriptName.set(data.name);
  }
  startPhone() {
    this.clearConfiguration();
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
      if (data.type === 'network-result' || data.type === 'websocket-result') {
        this.recordPhoneNetwork(data);
        // A blocked or failed request is the usual reason a phone script sits on
        // a spinner forever. The Phone tab keeps the raw record; say plainly in
        // the log that the request failed, and for which host.
        const id = (data as { requestId?: number }).requestId;
        const target = id === undefined ? undefined : this.phoneRequestHosts.get(id);
        if (id !== undefined) this.phoneRequestHosts.delete(id);
        const where = target ? ' to ' + target : '';
        if ('error' in data && typeof data['error'] === 'string')
          this.log(
            'PHONE',
            `Network request${where} failed (${data['error']}): ` +
              String((data as { message?: unknown }).message ?? 'no detail'),
          );
        // A reply is logged too. Without it a trace shows a request and then
        // nothing, and whether the host answered cannot be told apart from
        // whether the app ignored what it received.
        else if ('status' in data)
          this.log(
            'PHONE',
            `Network request${where} answered ${data['status']}` +
              ((data as { responseBytes?: number }).responseBytes === undefined
                ? ''
                : `, ${(data as { responseBytes?: number }).responseBytes} bytes`),
          );
      }
      if (data.type === 'error') {
        this.clearConfiguration();
        this.phoneAccepting = false;
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
          this.clearConfiguration();
          this.configuration.set({
            url: event.url,
            requestId: event.requestId,
            generation: data.phoneGeneration,
            appId: this.phoneAppId,
            title: String(
              this.phoneAppInfo['shortName'] ??
                this.phoneAppInfo['displayName'] ??
                this.phoneScriptName(),
            ),
          });
          this.configurationResponse = '';
          this.showPreview();
        }
        if (
          event.type === 'network-request' ||
          event.type === 'network-cancel' ||
          event.type === 'websocket-command'
        )
          this.recordPhoneNetwork(event);
        if (event.type === 'network-request') this.rememberPhoneRequest(event.request);
        this.log(
          'PHONE',
          event.type === 'configuration'
            ? `Configuration ${event.requestId}: ${event.url.length} characters`
            : event.type === 'websocket-command'
              ? `WebSocket ${event.socketId}: ${event.action}${event.url ? ' ' + event.url : ''}`
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
          localStorage.setItem('pebble.phone.' + data.appId, JSON.stringify(data.storage));
        } catch {
          try {
            sessionStorage.setItem('pebble.phone.' + data.appId, JSON.stringify(data.storage));
          } catch {}
          this.configurationNotice.set(
            'This browser could not retain app settings between visits.',
          );
        }
      }
    };
    this.phoneWorker.onerror = (e) => {
      if (this.phoneWorker !== phone) return;
      this.clearConfiguration();
      this.phoneAccepting = false;
      this.qemuWorker?.postMessage({
        type: 'phone-clock',
        generation: this.watchGeneration,
        enabled: false,
      });
      this.phoneStatus.set('Error');
      this.log('PHONE', e.message);
    };
    let storage = {};
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('pebble.phone.' + this.phoneAppId);
    } catch {}
    try {
      stored ??= sessionStorage.getItem('pebble.phone.' + this.phoneAppId);
    } catch {}
    try {
      storage = JSON.parse(stored ?? '{}');
    } catch {}
    const clockChannel = this.isFirmware() && this.qemuWorker ? new MessageChannel() : undefined;
    this.phoneWorker.postMessage(
      {
        type: 'start',
        clockPort: clockChannel?.port1,
        wasmUrl: new URL('wasm/quickjs.wasm', document.baseURI).href,
        source: this.phoneScript(),
        name: this.phoneScriptName(),
        appId: this.phoneAppId,
        messageKeys: this.phoneKeys,
        appInfo: this.phoneAppInfo,
        watchInfo,
        accountToken: this.accountToken,
        watchToken: this.watchToken,
        timelineToken: this.timelineToken,
        network: { mode: this.phoneNetworkMode, fixtures },
        storage,
        // Omitted when location is switched off, so the script is told the
        // position is unavailable rather than handed one it was denied.
        coordinates: this.demoSettings().location ? this.currentCoordinates() : undefined,
        connected: this.linked(),
        clock: this.isFirmware() ? 'watch' : 'wall',
        nowMs: this.isFirmware() ? Math.floor(this.watchEpochMs) : Date.now(),
        virtualUs: Math.round(this.virtualSeconds() * 1e6),
        randomSeed: 1,
      },
      clockChannel ? [clockChannel.port1] : [],
    );
    if (this.isFirmware())
      this.qemuWorker?.postMessage(
        {
          type: 'phone-clock',
          generation: this.watchGeneration,
          enabled: true,
          port: clockChannel?.port2,
        },
        clockChannel ? [clockChannel.port2] : [],
      );
  }
  stopPhone() {
    this.clearConfiguration();
    this.qemuWorker?.postMessage({
      type: 'phone-clock',
      generation: this.watchGeneration,
      enabled: false,
    });
    this.configuration.set(null);
    this.phoneAccepting = false;
    this.phoneWorker?.postMessage({ type: 'stop' });
  }
  /** Request hosts, kept only long enough to name the target of a failure. */
  private phoneRequestHosts = new Map<number, string>();
  private rememberPhoneRequest(request: { id?: number; url?: string }) {
    if (typeof request?.id !== 'number' || typeof request.url !== 'string') return;
    let host: string;
    try {
      host = new URL(request.url).host;
    } catch {
      return;
    }
    if (this.phoneRequestHosts.size >= 64)
      this.phoneRequestHosts.delete(this.phoneRequestHosts.keys().next().value!);
    this.phoneRequestHosts.set(request.id, host);
  }
  private recordPhoneNetwork(value: unknown) {
    const text = JSON.stringify(value);
    const record =
      text.length <= 8192
        ? text
        : JSON.stringify({
            truncated: true,
            characters: text.length,
            preview: text.slice(0, 8192),
          });
    this.phoneHttp.update((rows) => [...rows, record].slice(-100));
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
    if (this.phoneStatus() !== 'Running' || this.configurationPending() || this.configuration())
      return;
    this.configurationNotice.set('');
    this.configurationPending.set(true);
    this.configurationTimeout = setTimeout(() => {
      this.configurationPending.set(false);
      this.configurationNotice.set('The app did not open a settings page. You can try again.');
    }, 10000);
    this.phoneWorker?.postMessage({ type: 'configuration' });
  }
  private clearConfiguration() {
    clearTimeout(this.configurationTimeout);
    this.configurationPending.set(false);
    this.configurationNotice.set('');
    this.configuration.set(null);
  }
  returnConfiguration({ request, response }: PhoneConfigurationResult) {
    const view = this.configuration();
    if (
      !view ||
      view !== request ||
      !this.phoneAccepting ||
      request.generation !== this.phoneGeneration ||
      request.appId !== this.phoneAppId
    )
      return;
    this.configurationResponse = response ?? '';
    this.closeConfiguration(response === null);
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
    this.clearConfiguration();
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
    this.phoneWorker?.postMessage({ type: 'location', coordinates: this.currentCoordinates() });
  }
  private currentCoordinates() {
    return {
      latitude: this.latitude,
      longitude: this.longitude,
      accuracy: this.accuracy,
      altitude: this.altitude,
      heading: this.locationHeading,
      speed: this.speed,
    };
  }
  /** Brings a running phone in line with the location switch. */
  private deliverLocationAvailability(available: boolean) {
    if (this.phoneStatus() !== 'Running') return;
    this.phoneWorker?.postMessage(
      available
        ? { type: 'location', coordinates: this.currentCoordinates() }
        : {
            type: 'location-error',
            code: 2,
            message: 'Location is switched off in simulated inputs.',
          },
    );
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
