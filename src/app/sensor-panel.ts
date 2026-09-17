import { Component, EventEmitter, Input, Output, ChangeDetectorRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  accelerationCsv,
  HEALTH_METRICS,
  motionScenario,
  normalizeScenario,
  normalizeSignal,
  type DeviceSignal,
  type SignalScenario,
} from './signals.ts';
import type { MachineProfile } from './watch-profiles.ts';

export interface SignalObservation {
  signal: DeviceSignal;
  stage: string;
  actualUs: number;
  scheduledUs: number;
}
@Component({
  selector: 'sensor-panel',
  imports: [FormsModule],
  templateUrl: './sensor-panel.html',
})
export class SensorPanel {
  private readonly changeDetector = inject(ChangeDetectorRef);
  @Input() profile: MachineProfile = 'diagnostic-v1';
  @Input() ready = false;
  @Input() pending = 0;
  @Input() observations: SignalObservation[] = [];
  @Input() vibrating = false;
  @Input() healthStatus = '';
  @Output() healthSettings = new EventEmitter<{ enabled: boolean; heartRate: boolean }>();
  @Output() signalInput = new EventEmitter<DeviceSignal>();
  @Output() scenarioInput = new EventEmitter<SignalScenario>();
  @Output() cancelScenario = new EventEmitter<void>();
  readonly metrics = HEALTH_METRICS;
  x = 0;
  y = 0;
  z = -1000;
  heading = 0;
  calibration = 2;
  axis = 2;
  direction = 1;
  bpm = 72;
  quality = 4;
  metric = 0;
  healthValue = 0;
  tracking = true;
  hrTracking = true;
  touchX = 100;
  touchY = 100;
  preset: 'stationary' | 'walking' | 'running' | 'rotate' = 'walking';
  seconds = 10;
  rate = 25;
  noise = 0;
  seed = 1;
  twentyFourHour = true;
  contentSize = 1;
  peek = false;
  message = '';
  error = '';
  scenario: SignalScenario = motionScenario({
    preset: 'walking',
    seconds: 10,
    rate: 25,
    seed: 1,
    noise: 0,
  });
  scenarioJson = JSON.stringify(this.scenario, null, 2);
  get touchAvailable() {
    return this.profile === 'qemu_emery' || this.profile === 'qemu_gabbro';
  }
  get hrAvailable() {
    return this.profile === 'qemu_emery';
  }
  send(value: unknown) {
    try {
      this.error = '';
      this.signalInput.emit(normalizeSignal(value));
    } catch (e) {
      this.error = String(e);
    }
  }
  acceleration() {
    this.send({ kind: 'acceleration', x: this.x, y: this.y, z: this.z });
  }
  tap() {
    this.send({ kind: 'tap', axis: this.axis, direction: this.direction });
  }
  compass() {
    this.send({ kind: 'compass', heading: this.heading, calibration: this.calibration });
  }
  heartRate() {
    this.send({ kind: 'heart-rate', bpm: this.bpm, quality: this.quality });
  }
  health() {
    this.send({ kind: 'health', metric: this.metric, value: this.healthValue });
  }
  touch(down: boolean) {
    this.send({ kind: 'touch', down, x: this.touchX, y: this.touchY });
  }
  buildPreset() {
    try {
      this.error = '';
      this.scenario = motionScenario({
        preset: this.preset,
        seconds: this.seconds,
        rate: this.rate,
        noise: this.noise,
        seed: this.seed,
      });
      this.scenarioJson = JSON.stringify(this.scenario, null, 2);
      this.message = `${this.scenario.events.length} samples prepared`;
    } catch (e) {
      this.error = String(e);
    }
  }
  play() {
    try {
      this.error = '';
      if (this.scenarioJson.length > 16 * 1048576) throw new Error('Scenario exceeds 16 MiB.');
      this.scenario = normalizeScenario(JSON.parse(this.scenarioJson));
      this.scenarioInput.emit(this.scenario);
      this.message = 'Scheduled on the watch clock. Run the watch to advance playback.';
    } catch (e) {
      this.error = String(e);
    }
  }
  async import(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    try {
      this.error = '';
      if (file.size > 16 * 1048576) throw new Error('Scenario exceeds 16 MiB.');
      const text = await file.text();
      this.scenario = file.name.toLowerCase().endsWith('.csv')
        ? accelerationCsv(text, this.seed)
        : normalizeScenario(JSON.parse(text));
      this.scenarioJson = JSON.stringify(this.scenario, null, 2);
      this.message = `${this.scenario.events.length} events loaded`;
    } catch (e) {
      this.error = String(e);
    } finally {
      input.value = '';
      this.changeDetector.markForCheck();
    }
  }
  download() {
    try {
      const scenario = normalizeScenario(JSON.parse(this.scenarioJson)),
        url = URL.createObjectURL(
          new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' }),
        );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pebble-scenario.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      this.error = String(e);
    }
  }
  points(axis: 'x' | 'y' | 'z'): string {
    const rows = this.observations
      .filter((e) => e.signal.kind === 'acceleration' && e.stage === 'written to UART')
      .slice(-100);
    if (rows.length < 2) return '';
    const start = rows[0]!.actualUs,
      span = Math.max(1, rows.at(-1)!.actualUs - start);
    return rows
      .map(
        (r) =>
          `${((r.actualUs - start) / span) * 400},${75 - (Math.max(-2000, Math.min(2000, (r.signal as Extract<DeviceSignal, { kind: 'acceleration' }>)[axis])) / 2000) * 65}`,
      )
      .join(' ');
  }
}
