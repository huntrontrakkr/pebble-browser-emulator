import { normalizeSignal, type DeviceSignal } from './signals.ts';

export interface DemoNotification {
  id: number;
  title: string;
  body: string;
  enabled: boolean;
}
export interface DemoCalendarEvent {
  id: number;
  title: string;
  location: string;
  startMinutes: number;
  duration: number;
  enabled: boolean;
}
export interface DemoSettings {
  version: 1;
  enabled: boolean;
  battery: number;
  charging: boolean;
  pulse: boolean;
  bpm: number;
  variation: number;
  motion: 'off' | 'stationary' | 'walking' | 'running';
  health: boolean;
  metrics: number[];
  location: boolean;
  latitude: number;
  longitude: number;
  accuracy: number;
  notifications: DemoNotification[];
  calendar: DemoCalendarEvent[];
}

export function defaultDemoSettings(): DemoSettings {
  return {
    version: 1,
    enabled: true,
    battery: 69,
    charging: false,
    pulse: true,
    bpm: 72,
    variation: 4,
    motion: 'stationary',
    health: true,
    metrics: [4200, 1800, 1200, 180, 3000, 27000, 21600],
    location: true,
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 10,
    notifications: [
      { id: 0, title: 'Alex · Demo', body: 'Meet for coffee at 3?', enabled: true },
      { id: 1, title: 'Delivery · Demo', body: 'Your package has arrived.', enabled: true },
    ],
    calendar: [
      {
        id: 0,
        title: 'Design review',
        location: 'Demo studio',
        startMinutes: 30,
        duration: 45,
        enabled: true,
      },
      {
        id: 1,
        title: 'Lunch with Alex',
        location: 'Demo café',
        startMinutes: 120,
        duration: 60,
        enabled: true,
      },
    ],
  };
}

const number = (value: unknown, min: number, max: number, label: string, integer = true) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(
      `${label} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`,
    );
  return value;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid demo switch.');
  return value;
};
const text = (value: unknown, max: number, label: string) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    new TextEncoder().encode(value).length > max ||
    /[\x00-\x08\x0b-\x1f]/.test(value)
  )
    throw new Error(`${label} must contain 1–${max} UTF-8 bytes of text.`);
  return value;
};

/** Rebuild untrusted persisted/Worker input; never merge unknown object properties. */
export function normalizeDemoSettings(value: unknown): DemoSettings {
  const v = value as DemoSettings;
  if (!v || v.version !== 1) throw new Error('Unsupported demo settings.');
  const rows = <T extends { id: number }>(input: unknown, parse: (row: any) => T): T[] => {
    if (!Array.isArray(input) || input.length > 8)
      throw new Error('Use up to eight sample items per list.');
    const result = input.map(parse);
    if (new Set(result.map((r) => r.id)).size !== result.length)
      throw new Error('Duplicate sample item ID.');
    return result;
  };
  if (!['off', 'stationary', 'walking', 'running'].includes(v.motion))
    throw new Error('Invalid motion preset.');
  if (!Array.isArray(v.metrics) || v.metrics.length !== 7)
    throw new Error('Seven health totals are required.');
  const location = normalizeSignal({
    kind: 'location',
    latitude: v.latitude,
    longitude: v.longitude,
    accuracy: v.accuracy,
  });
  if (location.kind !== 'location') throw new Error('Invalid location.');
  return {
    version: 1,
    enabled: flag(v.enabled),
    battery: number(v.battery, 0, 100, 'Battery'),
    charging: flag(v.charging),
    pulse: flag(v.pulse),
    bpm: number(v.bpm, 30, 220, 'Heart rate'),
    variation: number(v.variation, 0, 30, 'Heart rate variation'),
    motion: v.motion,
    health: flag(v.health),
    metrics: v.metrics.map((n) => number(n, 0, 2147483647, 'Health total')),
    location: flag(v.location),
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    notifications: rows(v.notifications, (n) => ({
      id: number(n?.id, 0, 7, 'Notification ID'),
      enabled: flag(n.enabled),
      title: text(n.title, 96, 'Notification title'),
      body: text(n.body, 512, 'Notification body'),
    })),
    calendar: rows(v.calendar, (e) => ({
      id: number(e?.id, 0, 7, 'Calendar ID'),
      enabled: flag(e.enabled),
      title: text(e.title, 96, 'Event title'),
      location: e.location === '' ? '' : text(e.location, 128, 'Event location'),
      startMinutes: number(e.startMinutes, -1440, 10080, 'Event start'),
      duration: number(e.duration, 1, 1440, 'Event duration'),
    })),
  };
}

export const DEMO_STORAGE_KEY = 'pebble.demo.v1';
export function readDemoSettings(): DemoSettings {
  try {
    const value = localStorage.getItem(DEMO_STORAGE_KEY);
    if (value) return normalizeDemoSettings(JSON.parse(value));
  } catch {
    /* Unavailable storage or stale/corrupt settings use documented defaults. */
  }
  return defaultDemoSettings();
}

/** Small deterministic stream, evaluated on watch time. No wall timers or preallocated hour of samples. */
export class DemoSignalStream {
  private settings?: DemoSettings;
  private origin = 0;
  private sample = 0;
  private heartRate = false;
  private interval = 1000000;
  nextUs = Infinity;
  start(settings: DemoSettings, originUs: number, heartRate: boolean) {
    this.stop();
    if (!settings.enabled) return;
    this.settings = settings;
    this.origin = originUs;
    this.heartRate = heartRate;
    this.interval = ['walking', 'running'].includes(settings.motion) ? 100000 : 1000000;
    if ((settings.pulse && heartRate) || settings.motion !== 'off') this.nextUs = originUs;
  }
  stop() {
    this.settings = undefined;
    this.nextUs = Infinity;
    this.sample = 0;
  }
  takeDue(nowUs: number): { atUs: number; signal: DeviceSignal }[] {
    const s = this.settings,
      events: { atUs: number; signal: DeviceSignal }[] = [];
    if (!s) return events;
    while (this.nextUs <= nowUs) {
      const atUs = this.nextUs,
        elapsed = (atUs - this.origin) / 1e6;
      if (s.pulse && this.heartRate && (this.interval === 1000000 || this.sample % 10 === 0))
        events.push({
          atUs,
          signal: {
            kind: 'heart-rate',
            bpm: Math.round(s.bpm + s.variation * Math.sin((elapsed * Math.PI) / 10)),
            quality: 3,
          },
        });
      if (s.motion !== 'off' && (s.motion !== 'stationary' || this.sample === 0)) {
        const active = s.motion !== 'stationary',
          amplitude = s.motion === 'running' ? 450 : 180;
        const phase = elapsed * Math.PI * 2 * (s.motion === 'running' ? 2.8 : 1.8);
        events.push({
          atUs,
          signal: {
            kind: 'acceleration',
            x: active ? Math.round(amplitude * Math.sin(phase)) : 0,
            y: active ? Math.round((amplitude / 3) * Math.cos(phase)) : 0,
            z: active ? -1000 + Math.round(amplitude * Math.cos(phase)) : -1000,
          },
        });
      }
      this.sample++;
      this.nextUs = this.origin + this.sample * this.interval;
      if (!(s.pulse && this.heartRate) && !['walking', 'running'].includes(s.motion))
        this.nextUs = Infinity;
    }
    return events;
  }
}
