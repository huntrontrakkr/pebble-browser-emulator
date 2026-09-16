import type { AppMessageDictionary, AppMessageValue } from './virtual-phone.types.ts';

/** Original portable implementation of Pebble's documented protocol wire formats.
 * References: MIT pebble/libpebble2 protocol/{apps,blobdb,system,putbytes}.py,
 * communication/transports/qemu/protocol.py, util/stm32_crc.py, services/install.py.
 * The QEMU envelope is UART transport framing, separate from raw Pebble framing.
 */
export interface PebblePacket {
  endpoint: number;
  payload: Uint8Array;
  sequence: number;
}
export interface PebbleTransportHost {
  /** Write ALL bytes to UART1 in order, handling partial hardware FIFO writes. */
  writeUart(bytes: Uint8Array): Promise<void>;
  /** Advance the CPU; drain UART1 output through transport.feedUart(). */
  advance(): Promise<void>;
  /** Monotonic virtual milliseconds, derived from CPU ticks. */
  nowMs(): number;
}
export interface PebbleTransportOptions {
  onPacket?(direction: 'phone' | 'watch', packet: PebblePacket): void;
  onControl?(channel: number, payload: Uint8Array): void;
  timeoutMs?: number;
}
export interface PebbleAppParts {
  app: Uint8Array;
  resources?: Uint8Array;
  worker?: Uint8Array;
}
export interface PebbleInstallProgress {
  phase: 'metadata' | 'app' | 'resources' | 'worker' | 'launch';
  sentBytes: number;
  totalBytes: number;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const join = (a: Uint8Array, b: Uint8Array) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
};
function uint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${label}.`);
}

export function encodePebblePacket(endpoint: number, payload: Uint8Array): Uint8Array {
  uint(endpoint, 65535, 'endpoint');
  uint(payload.length, 65535, 'packet length');
  const result = new Uint8Array(payload.length + 4),
    data = view(result);
  data.setUint16(0, payload.length);
  data.setUint16(2, endpoint);
  result.set(payload, 4);
  return result;
}
export function encodeQemuPacket(channel: number, payload: Uint8Array): Uint8Array {
  uint(channel, 65535, 'QEMU channel');
  uint(payload.length, 65535, 'QEMU length');
  const result = new Uint8Array(payload.length + 8),
    data = view(result);
  data.setUint16(0, 0xfeed);
  data.setUint16(2, channel);
  data.setUint16(4, payload.length);
  result.set(payload, 6);
  data.setUint16(result.length - 2, 0xbeef);
  return result;
}

/** Firmware >= 3 modern installer. It transfers extracted, validated PBW parts.
 * No firmware, ZIP parser, networking, wall clock, or browser globals are used.
 * One transport instance belongs to one CPU boot; discard it on reset/load.
 */
export class PebbleTransport {
  private serial = new Uint8Array(0);
  private spp = new Uint8Array(0);
  private inbox: PebblePacket[] = [];
  private serialWrites: Promise<void> = Promise.resolve();
  private sequence = 0;
  private token = 0;
  private installing = false;
  private dead = false;
  private readonly timeoutMs: number;
  private readonly host: PebbleTransportHost;
  private readonly options: PebbleTransportOptions;
  constructor(host: PebbleTransportHost, options: PebbleTransportOptions = {}) {
    this.host = host;
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error('Invalid transport timeout.');
  }
  /** Arbitrary UART fragmentation/concatenation is accepted. Observers must not throw. */
  feedUart(bytes: Uint8Array): void {
    if (this.dead) return;
    if (bytes.length > 4 * 1024 * 1024) throw new Error('UART input chunk limit exceeded.');
    this.serial = join(this.serial, bytes);
    let offset = 0;
    while (this.serial.length - offset >= 8) {
      const data = view(this.serial.subarray(offset));
      if (data.getUint16(0) !== 0xfeed) throw new Error('Invalid QEMU UART header.');
      const channel = data.getUint16(2),
        length = data.getUint16(4);
      if (this.serial.length - offset < length + 8) break;
      if (data.getUint16(length + 6) !== 0xbeef) throw new Error('Invalid QEMU UART footer.');
      const payload = this.serial.slice(offset + 6, offset + length + 6);
      offset += length + 8;
      if (channel === 1) this.feedSpp(payload);
      else this.options.onControl?.(channel, payload);
    }
    this.serial = this.serial.slice(offset);
  }
  private feedSpp(bytes: Uint8Array): void {
    this.spp = join(this.spp, bytes);
    let offset = 0;
    while (this.spp.length - offset >= 4) {
      const data = view(this.spp.subarray(offset)),
        length = data.getUint16(0);
      if (this.spp.length - offset < length + 4) break;
      const packet: PebblePacket = {
        endpoint: data.getUint16(2),
        payload: this.spp.slice(offset + 4, offset + 4 + length),
        sequence: ++this.sequence,
      };
      offset += length + 4;
      this.inbox.push(packet);
      // Unsolicited packets are observable immediately; retained wait history is bounded.
      if (this.inbox.length > 256) this.inbox.shift();
      this.options.onPacket?.('watch', packet);
    }
    this.spp = this.spp.slice(offset);
  }
  /** Validate end-of-stream; a live UART normally stays open until reset. */
  finish(): void {
    if (this.serial.length || this.spp.length) throw new Error('Truncated QEMU or Pebble packet.');
  }
  dispose(): void {
    this.dead = true;
    this.inbox = [];
    this.serial = new Uint8Array(0);
    this.spp = new Uint8Array(0);
  }
  private checkAlive(): void {
    if (this.dead) throw new Error('Pebble transport was disposed.');
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.checkAlive();
    const next = this.serialWrites.then(() => {
      this.checkAlive();
      return operation();
    });
    // A rejected write must not leave an unhandled rejection in the queue tail.
    this.serialWrites = next.catch(() => {});
    return next;
  }
  send(endpoint: number, payload: Uint8Array): Promise<void> {
    const raw = encodePebblePacket(endpoint, payload),
      copy = payload.slice();
    return this.enqueue(async () => {
      this.options.onPacket?.('phone', { endpoint, payload: copy, sequence: this.sequence });
      for (let offset = 0; offset < raw.length; offset += 2048) {
        this.checkAlive();
        await this.host.writeUart(encodeQemuPacket(1, raw.subarray(offset, offset + 2048)));
      }
    });
  }
  control(channel: number, payload: Uint8Array): Promise<void> {
    const raw = encodeQemuPacket(channel, payload);
    return this.enqueue(() => this.host.writeUart(raw));
  }
  setBluetooth(connected: boolean): Promise<void> {
    return this.control(3, Uint8Array.of(Number(connected)));
  }
  setBattery(percent: number, charging: boolean): Promise<void> {
    uint(percent, 100, 'battery percent');
    return this.control(5, Uint8Array.of(percent, Number(charging)));
  }
  async waitPacket(
    endpoint: number,
    predicate: (payload: Uint8Array) => boolean = () => true,
    afterSequence = 0,
    timeoutMs = this.timeoutMs,
  ): Promise<PebblePacket> {
    const started = this.host.nowMs();
    if (!Number.isFinite(started)) throw new Error('Invalid transport virtual clock.');
    let stagnant = 0,
      previous = started;
    while (true) {
      this.checkAlive();
      const index = this.inbox.findIndex(
        (p) => p.sequence > afterSequence && p.endpoint === endpoint && predicate(p.payload),
      );
      if (index !== -1) return this.inbox.splice(index, 1)[0]!;
      const now = this.host.nowMs();
      if (!Number.isFinite(now) || now < previous)
        throw new Error('Transport clock must advance monotonically.');
      if (now - started >= timeoutMs)
        throw new Error(`Timeout waiting for Pebble endpoint 0x${endpoint.toString(16)}.`);
      if (now === previous && ++stagnant > 10000)
        throw new Error('CPU did not advance while waiting for a packet.');
      if (now !== previous) stagnant = 0;
      previous = now;
      await this.host.advance();
    }
  }
  /** Install, await all real transfer ACKs, then await the firmware's running-app event. */
  async install(
    parts: PebbleAppParts,
    progress?: (value: PebbleInstallProgress) => void,
  ): Promise<{ uuid: string; appId: number }> {
    this.checkAlive();
    if (this.installing) throw new Error('An app installation is already running.');
    const app = parts.app.slice(),
      resources = parts.resources?.slice(),
      worker = parts.worker?.slice();
    const metadata = appMetadata(app),
      uuid = metadata.subarray(0, 16);
    for (const part of [app, resources, worker]) {
      if (part && (part.length === 0 || part.length > 16 * 1024 * 1024))
        throw new Error('Invalid app part size.');
    }
    this.installing = true;
    let sentBytes = 0;
    const totalBytes = app.length + (resources?.length ?? 0) + (worker?.length ?? 0);
    const report = (phase: PebbleInstallProgress['phase']) =>
      progress?.({ phase, sentBytes, totalBytes });
    try {
      report('metadata');
      const token = (this.token = (this.token + 1) & 0xffff);
      const insert = new Uint8Array(149),
        data = view(insert);
      insert[0] = 1;
      data.setUint16(1, token, true);
      insert[3] = 2;
      insert[4] = 16;
      insert.set(uuid, 5);
      data.setUint16(21, metadata.length, true);
      insert.set(metadata, 23);
      let mark = this.sequence;
      await this.send(0xb1db, insert);
      const blob = (
        await this.waitPacket(
          0xb1db,
          (p) => p.length >= 2 && view(p).getUint16(0, true) === token,
          mark,
        )
      ).payload;
      if (blob.length !== 3 || blob[2] !== 1)
        throw new Error(`App metadata rejected: BlobDB status ${blob[2] ?? 'malformed'}.`);
      mark = this.sequence;
      await this.send(0x34, join(Uint8Array.of(1), uuid));
      const fetch = (await this.waitPacket(0x1771, (p) => p[0] === 1, mark)).payload;
      if (fetch.length !== 21 || !equal(fetch.subarray(1, 17), uuid)) {
        await this.send(0x1771, Uint8Array.of(1, 3));
        throw new Error('Firmware requested an unexpected app UUID.');
      }
      const appId = view(fetch).getUint32(17, true);
      const launchMark = this.sequence;
      for (const [type, part, phase] of [
        [5, app, 'app'],
        [4, resources, 'resources'],
        [7, worker, 'worker'],
      ] as const) {
        if (!part) continue;
        report(phase);
        await this.putBytes(type, part, appId, (count) => {
          sentBytes += count;
          report(phase);
        });
      }
      report('launch');
      await this.waitPacket(
        0x34,
        (p) => p.length === 17 && p[0] === 1 && equal(p.subarray(1), uuid),
        launchMark,
      );
      return { uuid: formatUuid(uuid), appId };
    } finally {
      this.installing = false;
    }
  }
  private async putBytes(
    type: number,
    bytes: Uint8Array,
    appId: number,
    progress: (count: number) => void,
  ): Promise<void> {
    const init = new Uint8Array(10),
      initView = view(init);
    init[0] = 1;
    initView.setUint32(1, bytes.length);
    init[5] = type | 0x80;
    initView.setUint32(6, appId);
    const ack = async (message: Uint8Array, expectedCookie?: number, install = false) => {
      const mark = this.sequence;
      await this.send(0xbeef, message);
      const reply = (await this.waitPacket(0xbeef, () => true, mark)).payload;
      if (reply.length !== 5 || reply[0] !== 1)
        throw new Error(`PutBytes rejected (part ${type}, command ${message[0]}).`);
      const cookie = view(reply).getUint32(1);
      // Firmware clears its transfer context before the final Install ACK, hence cookie zero.
      if (expectedCookie !== undefined && cookie !== expectedCookie && !(install && cookie === 0)) {
        throw new Error('PutBytes ACK has an unexpected transfer cookie.');
      }
      return cookie;
    };
    const cookie = await ack(init);
    try {
      for (let offset = 0; offset < bytes.length; offset += 2000) {
        const part = bytes.subarray(offset, offset + 2000),
          payload = new Uint8Array(9 + part.length),
          data = view(payload);
        payload[0] = 2;
        data.setUint32(1, cookie);
        data.setUint32(5, part.length);
        payload.set(part, 9);
        await ack(payload, cookie);
        progress(part.length);
      }
      const commit = new Uint8Array(9);
      commit[0] = 3;
      view(commit).setUint32(1, cookie);
      view(commit).setUint32(5, stm32Crc(bytes));
      await ack(commit, cookie);
      const install = new Uint8Array(5);
      install[0] = 5;
      view(install).setUint32(1, cookie);
      await ack(install, cookie, true);
    } catch (error) {
      if (!this.dead) {
        const abort = new Uint8Array(5);
        abort[0] = 4;
        view(abort).setUint32(1, cookie);
        try {
          await this.send(0xbeef, abort);
        } catch {}
      }
      throw error;
    }
  }
}

/** Extract the fixed modern AppMetadata record from a Pebble executable header. */
export function appMetadata(app: Uint8Array): Uint8Array {
  if (app.length < 124 || !equal(app.subarray(0, 8), Uint8Array.of(80, 66, 76, 65, 80, 80, 0, 0))) {
    throw new Error('Invalid Pebble application header.');
  }
  const data = view(app),
    result = new Uint8Array(126),
    metadata = view(result);
  result.set(app.subarray(104, 120));
  metadata.setUint32(16, data.getUint32(96, true), true);
  metadata.setUint32(20, data.getUint32(88, true), true);
  result[24] = app[12]!;
  result[25] = app[13]!;
  result[26] = app[10]!;
  result[27] = app[11]!;
  const name = app.subarray(24, 56),
    nul = name.indexOf(0);
  // Validate UTF-8 but copy original header bytes without normalizing its app name.
  decoder.decode(nul === -1 ? name : name.subarray(0, nul));
  result.set(nul === -1 ? name : name.subarray(0, nul), 30);
  return result;
}
export function parseUuid(uuid: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid))
    throw new Error('Invalid app UUID.');
  const hex = uuid.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}
export function formatUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Invalid app UUID bytes.');
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});
/** STM32 CRC used by PutBytes/PBZ: LE full words; BE partial-tail integer, no final xor. */
export function stm32Crc(bytes: Uint8Array): number {
  let crc = 0xffffffff,
    offset = 0;
  const word = (value: number) => {
    crc ^= value;
    for (let i = 0; i < 4; i++) crc = ((crc << 8) ^ crcTable[crc >>> 24]!) >>> 0;
  };
  const data = view(bytes);
  while (offset + 4 <= bytes.length) {
    word(data.getUint32(offset, true));
    offset += 4;
  }
  if (offset < bytes.length) {
    let tail = 0;
    while (offset < bytes.length) tail = (tail << 8) | bytes[offset++]!;
    word(tail);
  }
  return crc >>> 0;
}

export type DecodedAppMessage =
  | { kind: 'push'; transactionId: number; uuid: string; payload: AppMessageDictionary }
  | { kind: 'ack' | 'nack'; transactionId: number };
export function encodeAppMessage(
  uuid: string,
  transactionId: number,
  dictionary: AppMessageDictionary,
): Uint8Array {
  uint(transactionId, 255, 'AppMessage transaction');
  const entries = Object.entries(dictionary);
  uint(entries.length, 255, 'AppMessage tuple count');
  const tuples = entries.map(([key, value]) => {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('AppMessage keys must be numeric IDs.');
    const id = Number(key);
    uint(id, 0xffffffff, 'AppMessage key');
    let type: number, bytes: Uint8Array;
    if (typeof value === 'string') {
      if (value.includes('\0')) throw new Error('AppMessage strings cannot contain NUL.');
      type = 1;
      bytes = join(encoder.encode(value), Uint8Array.of(0));
    } else if (Array.isArray(value)) {
      for (const byte of value) uint(byte, 255, 'AppMessage byte');
      type = 0;
      bytes = Uint8Array.from(value);
    } else {
      const integer = typeof value === 'boolean' ? Number(value) : value;
      if (!Number.isInteger(integer) || integer < -0x80000000 || integer > 0xffffffff)
        throw new Error('AppMessage number must be a 32-bit integer.');
      type = integer > 0x7fffffff ? 2 : 3;
      bytes = new Uint8Array(4);
      if (type === 2) view(bytes).setUint32(0, integer, true);
      else view(bytes).setInt32(0, integer, true);
    }
    uint(bytes.length, 65535, 'AppMessage tuple length');
    const tuple = new Uint8Array(bytes.length + 7),
      data = view(tuple);
    data.setUint32(0, id, true);
    tuple[4] = type;
    data.setUint16(5, bytes.length, true);
    tuple.set(bytes, 7);
    return tuple;
  });
  const length = 19 + tuples.reduce((total, tuple) => total + tuple.length, 0);
  uint(length, 65535, 'AppMessage payload length');
  const result = new Uint8Array(length);
  result[0] = 1;
  result[1] = transactionId;
  result.set(parseUuid(uuid), 2);
  result[18] = entries.length;
  let offset = 19;
  for (const tuple of tuples) {
    result.set(tuple, offset);
    offset += tuple.length;
  }
  return result;
}
export function decodeAppMessage(payload: Uint8Array): DecodedAppMessage {
  if (payload.length < 2) throw new Error('Truncated AppMessage header.');
  const transactionId = payload[1]!;
  if (payload[0] === 0xff || payload[0] === 0x7f) {
    if (payload.length !== 2) throw new Error('Invalid AppMessage acknowledgement size.');
    return { kind: payload[0] === 0xff ? 'ack' : 'nack', transactionId };
  }
  if (payload[0] !== 1 || payload.length < 19) throw new Error('Invalid AppMessage push header.');
  const dictionary: AppMessageDictionary = Object.create(null),
    data = view(payload);
  let offset = 19;
  for (let count = 0; count < payload[18]!; count++) {
    if (offset + 7 > payload.length) throw new Error('Truncated AppMessage tuple.');
    const key = String(data.getUint32(offset, true)),
      type = payload[offset + 4],
      length = data.getUint16(offset + 5, true);
    offset += 7;
    if (offset + length > payload.length) throw new Error('Truncated AppMessage tuple value.');
    const bytes = payload.subarray(offset, offset + length),
      valueView = view(bytes);
    let value: AppMessageValue;
    if (type === 0) value = Array.from(bytes);
    else if (type === 1) {
      if (!length || bytes[length - 1] !== 0 || bytes.subarray(0, -1).includes(0))
        throw new Error('Invalid AppMessage C string.');
      value = decoder.decode(bytes.subarray(0, -1));
    } else if ((type === 2 || type === 3) && [1, 2, 4].includes(length)) {
      value =
        type === 2
          ? length === 1
            ? valueView.getUint8(0)
            : length === 2
              ? valueView.getUint16(0, true)
              : valueView.getUint32(0, true)
          : length === 1
            ? valueView.getInt8(0)
            : length === 2
              ? valueView.getInt16(0, true)
              : valueView.getInt32(0, true);
    } else throw new Error('Unsupported AppMessage tuple type or integer width.');
    dictionary[key] = value;
    offset += length;
  }
  if (offset !== payload.length) throw new Error('Trailing AppMessage bytes.');
  return {
    kind: 'push',
    transactionId,
    uuid: formatUuid(payload.subarray(2, 18)),
    payload: dictionary,
  };
}
