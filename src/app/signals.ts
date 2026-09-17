/** Versioned external signals. Values are inputs to a device or documented service,
 * never a substitute for executing firmware. Units follow the SDK at the boundary. */
export type DeviceSignal =
  | { kind: 'acceleration'; x: number; y: number; z: number }
  | { kind: 'tap'; axis: 0 | 1 | 2; direction: -1 | 1 }
  | { kind: 'compass'; heading: number; calibration: -1 | 0 | 1 | 2 }
  | { kind: 'heart-rate'; bpm: number; quality: number }
  | { kind: 'health'; metric: 0 | 1 | 2 | 3 | 4 | 5 | 6; value: number }
  | { kind: 'touch'; down: boolean; x: number; y: number }
  | { kind: 'buttons'; mask: number }
  | { kind: 'battery'; percent: number; charging: boolean }
  | { kind: 'connection'; connected: boolean }
  | { kind: 'time-format'; twentyFourHour: boolean }
  | { kind: 'content-size'; size: number }
  | { kind: 'timeline-peek'; enabled: boolean }
  | {
      kind: 'location';
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude?: number | null;
      altitudeAccuracy?: number | null;
      heading?: number | null;
      speed?: number | null;
    }
  | { kind: 'location-error'; code: 1 | 2 | 3; message: string };

export interface ScheduledSignal {
  atUs: number;
  signal: DeviceSignal;
}
export interface SignalScenario {
  version: 1;
  name: string;
  seed: number;
  events: ScheduledSignal[];
}
export const HEALTH_METRICS = [
  'Steps',
  'Active seconds',
  'Resting calories',
  'Active calories',
  'Distance (m)',
  'Sleep seconds',
  'Restful sleep seconds',
] as const;

function numeric(value: unknown, min: number, max: number, name: string, integer = true): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`);
  return value;
}
/** Rebuild records instead of retaining untrusted prototypes, getters or extra fields. */
export function normalizeSignal(value: unknown): DeviceSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A signal must be an object.');
  const v = value as Record<string, any>;
  const kind = v['kind'];
  const n = (key: string, min: number, max: number, integer = true) =>
    numeric(v[key], min, max, key, integer);
  switch (kind) {
    case 'acceleration':
      return { kind, x: n('x', -32768, 32767), y: n('y', -32768, 32767), z: n('z', -32768, 32767) };
    case 'tap': {
      const direction = n('direction', -1, 1);
      if (direction === 0) throw new Error('Tap direction must be -1 or 1.');
      return { kind, axis: n('axis', 0, 2) as 0 | 1 | 2, direction: direction as -1 | 1 };
    }
    case 'compass':
      return {
        kind,
        heading: n('heading', 0, 360, false),
        calibration: n('calibration', -1, 2) as -1 | 0 | 1 | 2,
      };
    case 'heart-rate':
      return { kind, bpm: n('bpm', 0, 255), quality: n('quality', -1, 4) };
    case 'health':
      return {
        kind,
        metric: n('metric', 0, 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        value: n('value', 0, 2147483647),
      };
    case 'touch':
      return { kind, down: boolean(v['down'], 'down'), x: n('x', 0, 65535), y: n('y', 0, 65535) };
    case 'buttons':
      return { kind, mask: n('mask', 0, 15) };
    case 'battery':
      return { kind, percent: n('percent', 0, 100), charging: boolean(v['charging'], 'charging') };
    case 'connection':
      return { kind, connected: boolean(v['connected'], 'connected') };
    case 'time-format':
      return { kind, twentyFourHour: boolean(v['twentyFourHour'], 'twentyFourHour') };
    case 'content-size':
      return { kind, size: n('size', 0, 3) };
    case 'timeline-peek':
      return { kind, enabled: boolean(v['enabled'], 'enabled') };
    case 'location': {
      const result: Extract<DeviceSignal, { kind: 'location' }> = {
        kind,
        latitude: n('latitude', -90, 90, false),
        longitude: n('longitude', -180, 180, false),
        accuracy: n('accuracy', 0, 1e9, false),
      };
      for (const key of ['altitude', 'altitudeAccuracy', 'heading', 'speed'] as const) {
        if (v[key] !== undefined)
          result[key] =
            v[key] === null
              ? null
              : n(key, key === 'altitude' ? -1e9 : 0, key === 'heading' ? 360 : 1e9, false);
      }
      if (result.heading === 360)
        throw new Error('Location heading must be less than 360 degrees.');
      return result;
    }
    case 'location-error': {
      if (typeof v['message'] !== 'string' || v['message'].length > 1000)
        throw new Error('Location error message exceeds 1000 characters.');
      return { kind, code: n('code', 1, 3) as 1 | 2 | 3, message: v['message'] };
    }
    default:
      throw new Error('Unknown signal type: ' + String(kind));
  }
}

/** PebbleOS QEMU protocol: pinned v4.37.0 include/pbl/drivers/qemu/qemu_serial.h.
 * Multi-byte fields are network order. No successful device response is synthesized. */
export function signalControl(
  signal: DeviceSignal,
): { channel: number; payload: Uint8Array } | null {
  const v = normalizeSignal(signal);
  const bytes = (channel: number, ...values: number[]) => ({
    channel,
    payload: Uint8Array.from(values),
  });
  switch (v.kind) {
    case 'tap':
      return bytes(2, v.axis, v.direction);
    case 'connection':
      return bytes(3, Number(v.connected));
    case 'compass': {
      const payload = new Uint8Array(5);
      new DataView(payload.buffer).setUint32(0, Math.round((v.heading / 360) * 65536) % 65536);
      payload[4] = v.calibration;
      return { channel: 4, payload };
    }
    case 'battery':
      return bytes(5, v.percent, Number(v.charging));
    case 'acceleration': {
      const payload = new Uint8Array(7),
        view = new DataView(payload.buffer);
      payload[0] = 1;
      [v.x, v.y, v.z].forEach((n, i) => view.setInt16(1 + 2 * i, n));
      return { channel: 6, payload };
    }
    case 'time-format':
      return bytes(9, Number(v.twentyFourHour));
    case 'timeline-peek':
      return bytes(10, Number(v.enabled));
    case 'content-size':
      return bytes(11, v.size);
    case 'health': {
      const payload = new Uint8Array(5);
      payload[0] = v.metric;
      new DataView(payload.buffer).setInt32(1, v.value);
      return { channel: 12, payload };
    }
    case 'heart-rate':
      return bytes(13, v.bpm, v.quality);
    default:
      return null;
  }
}

export function normalizeScenario(value: unknown): SignalScenario {
  if (!value || typeof value !== 'object') throw new Error('A scenario must be an object.');
  const v = value as SignalScenario;
  if (v.version !== 1) throw new Error('Unsupported scenario version.');
  if (typeof v.name !== 'string' || v.name.length > 200)
    throw new Error('Scenario name exceeds 200 characters.');
  const seed = numeric(v.seed, 0, 4294967295, 'seed');
  if (!Array.isArray(v.events) || v.events.length > 100000)
    throw new Error('Scenario limit is 100,000 events.');
  const events = v.events.map((e) => ({
    atUs: numeric(e?.atUs, 0, 86400000000, 'atUs'),
    signal: normalizeSignal(e?.signal),
  }));
  // Stable sort preserves user ordering at identical timestamps.
  events.sort((a, b) => a.atUs - b.atUs);
  return { version: 1, name: v.name, seed, events };
}

/** Pure virtual-time queue. Wall-clock timers never decide when a signal is due. */
export class SignalTimeline {
  private events: ScheduledSignal[] = [];
  private cursor = 0;
  private originUs = 0;
  load(value: unknown, originUs: number): SignalScenario {
    const scenario = normalizeScenario(value);
    numeric(originUs, 0, Number.MAX_SAFE_INTEGER - 86400000000, 'originUs');
    this.events = scenario.events;
    this.cursor = 0;
    this.originUs = originUs;
    return scenario;
  }
  clear(): void {
    this.events = [];
    this.cursor = 0;
  }
  get pending(): number {
    return this.events.length - this.cursor;
  }
  get nextUs(): number {
    return this.events[this.cursor] ? this.originUs + this.events[this.cursor]!.atUs : Infinity;
  }
  takeDue(nowUs: number): ScheduledSignal[] {
    const out: ScheduledSignal[] = [];
    while (this.nextUs <= nowUs) {
      const event = this.events[this.cursor++]!;
      out.push({ atUs: this.originUs + event.atUs, signal: event.signal });
    }
    return out;
  }
}

/** Mulberry32, a specified synthetic source. Not a hardware random-number model. */
export function seededRandom(seed: number): () => number {
  let state = numeric(seed, 0, 4294967295, 'seed') >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
export function motionScenario(options: {
  preset: 'stationary' | 'walking' | 'running' | 'rotate';
  seconds: number;
  rate: number;
  seed: number;
  noise: number;
}): SignalScenario {
  const { preset, seed } = options,
    seconds = numeric(options.seconds, 0.1, 3600, 'seconds', false),
    rate = numeric(options.rate, 1, 100, 'rate'),
    noise = numeric(options.noise, 0, 1000, 'noise', false);
  if (!['stationary', 'walking', 'running', 'rotate'].includes(preset))
    throw new Error('Unknown motion preset.');
  const count = Math.ceil(seconds * rate);
  if (count > 100000) throw new Error('Scenario limit is 100,000 events.');
  const random = seededRandom(seed),
    events: ScheduledSignal[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / rate,
      frequency = preset === 'running' ? 3 : 1.8,
      amplitude = preset === 'running' ? 600 : preset === 'walking' ? 180 : 0;
    const jitter = () => noise * (random() * 2 - 1);
    const angle = preset === 'rotate' ? (t * Math.PI) / 2 : 0;
    events.push({
      atUs: Math.round(t * 1e6),
      signal: {
        kind: 'acceleration',
        x: Math.round(Math.sin(angle) * 1000 + jitter()),
        y: Math.round((amplitude / 3) * Math.sin(t * frequency * Math.PI * 2) + jitter()),
        z: Math.round(
          -Math.cos(angle) * 1000 + amplitude * Math.sin(t * frequency * Math.PI * 2) + jitter(),
        ),
      },
    });
  }
  return normalizeScenario({ version: 1, name: preset, seed, events });
}

export function accelerationCsv(text: string, seed = 0): SignalScenario {
  if (text.length > 16 * 1048576) throw new Error('CSV exceeds 16 MiB.');
  const rows = text.trim().split(/\r?\n/);
  if (rows.shift()?.trim() !== 'time_ms,x_mg,y_mg,z_mg')
    throw new Error('CSV header must be time_ms,x_mg,y_mg,z_mg.');
  const events = rows
    .filter((r) => r.trim())
    .map((line, i) => {
      const fields = line.split(',').map((s) => s.trim());
      if (fields.length !== 4 || fields.some((s) => !s || !Number.isFinite(Number(s))))
        throw new Error(`Invalid CSV row ${i + 2}.`);
      const [ms, x, y, z] = fields.map(Number) as [number, number, number, number];
      return { atUs: ms * 1000, signal: { kind: 'acceleration', x, y, z } };
    });
  return normalizeScenario({ version: 1, name: 'Imported acceleration', seed, events });
}
