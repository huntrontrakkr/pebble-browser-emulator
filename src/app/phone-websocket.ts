import type { PhoneSocketEvent, VirtualPhoneEvent } from './virtual-phone.types.ts';
const size = (text: string) => new TextEncoder().encode(text).length;
function dataSize(data: string | number[], maximum: number): number {
  if (
    typeof data !== 'string' &&
    (!Array.isArray(data) ||
      data.length > maximum ||
      data.some((b) => !Number.isInteger(b) || b < 0 || b > 255))
  )
    throw new Error('Invalid WebSocket data.');
  const bytes = typeof data === 'string' ? size(data) : data.length;
  if (bytes > maximum) throw new Error('WebSocket message size limit exceeded.');
  return bytes;
}
export function normalizeSocketUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid WebSocket URL.');
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.includes('#')
  )
    throw new Error('Only absolute WS(S) URLs without credentials or fragments are supported.');
  if (url.href.length > 4096) throw new Error('WebSocket URL size limit exceeded.');
  return url.href;
}
export function normalizeSocketEvent(value: PhoneSocketEvent, maximum: number): PhoneSocketEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid WebSocket event.');
  switch (value.type) {
    case 'open':
      if (
        typeof value.protocol !== 'string' ||
        typeof value.extensions !== 'string' ||
        value.protocol.length > 256 ||
        value.extensions.length > 4096
      )
        throw new Error('Invalid WebSocket negotiation.');
      return { type: 'open', protocol: value.protocol, extensions: value.extensions };
    case 'message':
      dataSize(value.data, maximum);
      return {
        type: 'message',
        data: typeof value.data === 'string' ? value.data : [...value.data],
      };
    case 'buffered':
      if (
        ![value.sentBytes ?? 0, value.bufferedAmount].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        )
      )
        throw new Error('Invalid socket buffer count.');
      return {
        type: 'buffered',
        sentBytes: value.sentBytes ?? 0,
        bufferedAmount: value.bufferedAmount,
      };
    case 'error':
      return { type: 'error', message: String(value.message).slice(0, 1024) };
    case 'close':
      if (
        !Number.isInteger(value.code) ||
        value.code < 1000 ||
        value.code > 4999 ||
        typeof value.reason !== 'string' ||
        size(value.reason) > 123 ||
        typeof value.wasClean !== 'boolean'
      )
        throw new Error('Invalid WebSocket close event.');
      return { type: 'close', code: value.code, reason: value.reason, wasClean: value.wasClean };
    default:
      throw new Error('Unknown WebSocket event.');
  }
}
export interface PhoneSocketLimits {
  pendingSockets: number;
  messageBytes: number;
  bufferedBytes: number;
  timeoutMs: number;
}
type SocketFactory = (url: string, protocols: string[]) => WebSocket;
/** Optional browser network capability. No socket/host object crosses into QuickJS. */
export class PhoneWebSocketNetwork {
  private readonly sockets = new Map<
    number,
    {
      socket: WebSocket;
      timer?: ReturnType<typeof setTimeout>;
      drain?: ReturnType<typeof setTimeout>;
    }
  >();
  private disposed = false;
  private readonly limits: PhoneSocketLimits;
  private readonly deliver: (id: number, event: PhoneSocketEvent) => void;
  private readonly factory: SocketFactory;
  constructor(
    deliver: (id: number, event: PhoneSocketEvent) => void,
    limits: Partial<PhoneSocketLimits> = {},
    factory: SocketFactory = (url, protocols) => new WebSocket(url, protocols),
  ) {
    this.deliver = deliver;
    this.factory = factory;
    this.limits = {
      pendingSockets: 4,
      messageBytes: 65536,
      bufferedBytes: 131072,
      timeoutMs: 30000,
      ...limits,
    };
    if (Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0))
      throw new Error('Invalid WebSocket limits.');
  }
  handle(event: VirtualPhoneEvent): void {
    if (this.disposed || event.type !== 'websocket-command') return;
    const id = event.socketId;
    if (!Number.isSafeInteger(id) || id < 1) return;
    try {
      if (event.action === 'open') {
        if (this.sockets.has(id)) return;
        const url = normalizeSocketUrl(event.url);
        if (
          !Array.isArray(event.protocols) ||
          event.protocols.length > 16 ||
          new Set(event.protocols).size !== event.protocols.length ||
          event.protocols.some(
            (p) =>
              typeof p !== 'string' || p.length > 256 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(p),
          )
        )
          throw new Error('Invalid WebSocket protocols.');
        if (this.sockets.size >= this.limits.pendingSockets)
          throw new Error('Pending WebSocket limit exceeded.');
        const socket = this.factory(url, event.protocols);
        socket.binaryType = 'arraybuffer';
        const item: {
          socket: WebSocket;
          timer?: ReturnType<typeof setTimeout>;
          drain?: ReturnType<typeof setTimeout>;
        } = { socket };
        this.sockets.set(id, item);
        const active = () => !this.disposed && this.sockets.get(id) === item;
        item.timer = setTimeout(
          () => this.fail(id, 'WebSocket connection timed out.'),
          this.limits.timeoutMs,
        );
        socket.onopen = () => {
          if (!active()) return;
          clearTimeout(item.timer);
          this.deliver(id, {
            type: 'open',
            protocol: socket.protocol,
            extensions: socket.extensions,
          });
        };
        socket.onmessage = (e) => {
          if (!active()) return;
          try {
            if (typeof e.data !== 'string' && !(e.data instanceof ArrayBuffer))
              throw new Error('Unsupported WebSocket message type.');
            if (e.data instanceof ArrayBuffer && e.data.byteLength > this.limits.messageBytes)
              throw new Error('WebSocket message size limit exceeded.');
            const data = typeof e.data === 'string' ? e.data : Array.from(new Uint8Array(e.data));
            dataSize(data, this.limits.messageBytes);
            this.deliver(id, { type: 'message', data });
          } catch (error) {
            this.fail(id, String(error));
          }
        };
        socket.onerror = () => {
          if (active()) this.fail(id, 'Browser WebSocket connection failed.');
        };
        socket.onclose = (e) => {
          if (!active()) return;
          this.remove(id);
          this.deliver(id, { type: 'close', code: e.code, reason: e.reason, wasClean: e.wasClean });
        };
      } else {
        const item = this.sockets.get(id);
        if (!item) return;
        if (event.action === 'send') {
          const n = dataSize(event.data, this.limits.messageBytes);
          if (item.socket.readyState !== 1) throw new Error('WebSocket is not open.');
          if (item.socket.bufferedAmount + n > this.limits.bufferedBytes)
            throw new Error('WebSocket send buffer limit exceeded.');
          item.socket.send(
            typeof event.data === 'string' ? event.data : Uint8Array.from(event.data),
          );
          this.deliver(id, {
            type: 'buffered',
            sentBytes: n,
            bufferedAmount: item.socket.bufferedAmount,
          });
          if (!item.drain && item.socket.bufferedAmount) {
            const drain = () => {
              item.drain = undefined;
              if (this.disposed || this.sockets.get(id) !== item) return;
              this.deliver(id, { type: 'buffered', bufferedAmount: item.socket.bufferedAmount });
              if (item.socket.bufferedAmount) item.drain = setTimeout(drain, 20);
            };
            item.drain = setTimeout(drain, 20);
          }
        } else if (event.action === 'close') {
          if (
            event.code !== undefined &&
            (!Number.isInteger(event.code) ||
              (event.code !== 1000 && (event.code < 3000 || event.code > 4999)))
          )
            throw new Error('Invalid WebSocket close code.');
          if (size(event.reason ?? '') > 123) throw new Error('WebSocket close reason too long.');
          item.socket.close(event.code, event.reason);
          if (this.sockets.get(id) !== item) return;
          clearTimeout(item.timer);
          item.timer = setTimeout(
            () => this.fail(id, 'WebSocket close timed out.'),
            this.limits.timeoutMs,
          );
        }
      }
    } catch (error) {
      this.fail(id, String(error));
    }
  }
  private remove(id: number): WebSocket | undefined {
    const item = this.sockets.get(id);
    if (!item) return;
    this.sockets.delete(id);
    clearTimeout(item.timer);
    clearTimeout(item.drain);
    item.socket.onopen = item.socket.onmessage = item.socket.onerror = item.socket.onclose = null;
    return item.socket;
  }
  private fail(id: number, message: string): void {
    const socket = this.remove(id);
    try {
      socket?.close();
    } catch {}
    if (this.disposed) return;
    this.deliver(id, { type: 'error', message });
    if (!this.disposed)
      this.deliver(id, { type: 'close', code: 1006, reason: '', wasClean: false });
  }
  dispose(): void {
    this.disposed = true;
    for (const id of this.sockets.keys()) {
      const socket = this.remove(id);
      try {
        socket?.close();
      } catch {}
    }
  }
}
