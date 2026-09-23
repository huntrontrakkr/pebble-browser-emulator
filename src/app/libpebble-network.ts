/**
 * The network for the libpebble3 phone's PebbleKit JS: upstream's own XMLHttpRequest
 * and WebSocket classes run unchanged inside the app's engine, and their requests
 * reach the browser through here. It uses the built-in phone's network layer
 * (phone-network.ts, phone-websocket.ts), so both phones follow the same setting,
 * limits and optional relay: off unless the session turns it on, and CORS applies.
 * Nothing is answered here: a request the browser cannot make fails as a network error.
 *
 * Calls from `HostHttpEngine` and `BrowserWebSocketManager` (tools/phone-spike) cross
 * as JSON strings.
 */
import { PhoneCorsNetwork, type CorsNetworkOptions } from './phone-network.ts';
import { PhoneWebSocketNetwork, type PhoneSocketLimits } from './phone-websocket.ts';
import type { PhoneNetworkResult, PhoneSocketEvent } from './virtual-phone.types.ts';

export interface PhoneNetworkSetting {
  /** The session's phone network setting; only `cors` reaches the network. */
  mode: 'disabled' | 'fixtures' | 'cors';
  relay?: { endpoint: string; key: string };
}

export interface LibPebbleNetworkHost {
  /**
   * Starts one request, `{method, url, headers, body}` (body is text or null), and
   * returns its id. `done` receives `{status, statusText, headers, bodyBase64}` or
   * `{error, message}` as JSON, once.
   */
  request(json: string, done: (result: string) => void): number;
  cancel(id: number): void;
  /**
   * Opens a WebSocket; `protocols` is comma-separated, as upstream passes it. `event`
   * receives `{type: 'open', protocol}`, `{type: 'message', text}` or
   * `{type: 'message', base64}`, `{type: 'error', message}` and, last,
   * `{type: 'close', code, reason, wasClean}` as JSON.
   */
  openSocket(url: string, protocols: string, event: (json: string) => void): number;
  /** Sends text, or bytes as base64 when `binary`. */
  sendSocket(id: number, data: string, binary: boolean): void;
  closeSocket(id: number, code: number, reason: string): void;
  /** Applies a new setting; requests and sockets already open are cancelled. */
  configure(setting: PhoneNetworkSetting): void;
  dispose(): void;
}

export interface LibPebbleNetworkOptions {
  requestLimits?: Omit<CorsNetworkOptions, 'relay'>;
  socketLimits?: Partial<PhoneSocketLimits>;
  fetcher?: typeof fetch;
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
}

const OFF_MESSAGE = 'Phone network access is off in this session.';
const FIXTURES_MESSAGE = 'Network fixtures apply only to the built-in phone.';

export function libPebbleNetworkHost(
  initial: PhoneNetworkSetting,
  options: LibPebbleNetworkOptions = {},
): LibPebbleNetworkHost {
  let setting = initial;
  let nextId = 1;
  let requests: PhoneCorsNetwork | undefined;
  let sockets: PhoneWebSocketNetwork | undefined;
  const waiting = new Map<number, (result: string) => void>();
  const listeners = new Map<number, (json: string) => void>();

  const refused = () =>
    setting.mode === 'cors'
      ? undefined
      : setting.mode === 'fixtures'
        ? FIXTURES_MESSAGE
        : OFF_MESSAGE;

  const later = (work: () => void) => queueMicrotask(work);

  function settle(id: number, result: PhoneNetworkResult) {
    const done = waiting.get(id);
    if (!done) return;
    waiting.delete(id);
    if ('error' in result) done(JSON.stringify({ error: result.error, message: result.message }));
    else
      done(
        JSON.stringify({
          status: result.status,
          statusText: result.statusText ?? '',
          headers: result.headers ?? {},
          bodyBase64: result.bodyBase64 ?? '',
        }),
      );
  }

  function socketEvent(id: number, event: PhoneSocketEvent) {
    const listener = listeners.get(id);
    if (!listener) return;
    switch (event.type) {
      case 'open':
        listener(JSON.stringify({ type: 'open', protocol: event.protocol }));
        break;
      case 'message':
        listener(
          JSON.stringify(
            typeof event.data === 'string'
              ? { type: 'message', text: event.data }
              : { type: 'message', base64: toBase64(Uint8Array.from(event.data)) },
          ),
        );
        break;
      case 'error':
        listener(JSON.stringify({ type: 'error', message: event.message }));
        break;
      case 'close':
        listeners.delete(id);
        listener(JSON.stringify(event));
        break;
    }
  }

  function start() {
    requests = new PhoneCorsNetwork(
      settle,
      { ...options.requestLimits, relay: setting.relay },
      options.fetcher,
    );
    sockets = new PhoneWebSocketNetwork(socketEvent, options.socketLimits, options.socketFactory);
  }

  function stop() {
    requests?.dispose();
    sockets?.dispose();
    requests = sockets = undefined;
    for (const [id, done] of waiting) {
      waiting.delete(id);
      done(JSON.stringify({ error: 'abort', message: 'The phone network setting changed.' }));
    }
    for (const [id, listener] of listeners) {
      listeners.delete(id);
      listener(JSON.stringify({ type: 'close', code: 1006, reason: '', wasClean: false }));
    }
  }

  start();
  return {
    request(json, done) {
      const id = nextId++;
      waiting.set(id, done);
      const refusal = refused();
      if (refusal) {
        later(() => settle(id, { error: 'disabled', message: refusal }));
        return id;
      }
      let request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body: string | null;
      };
      try {
        request = JSON.parse(json);
      } catch {
        later(() => settle(id, { error: 'network', message: 'Malformed request from the phone.' }));
        return id;
      }
      requests!.handle({
        type: 'network-request',
        timestamp: 0,
        request: {
          id,
          method: String(request.method).toUpperCase(),
          url: String(request.url),
          headers: request.headers ?? {},
          body: request.body ?? null,
          timeoutMs: 0,
          // The engine gets exact bytes and decodes them by the response's charset.
          responseType: 'arraybuffer',
        },
      });
      return id;
    },
    cancel(id) {
      if (!waiting.has(id)) return;
      requests?.handle({ type: 'network-cancel', requestId: id, timestamp: 0 });
      settle(id, { error: 'abort', message: 'Request aborted.' });
    },
    openSocket(url, protocols, event) {
      const id = nextId++;
      listeners.set(id, event);
      const refusal = refused();
      if (refusal) {
        later(() => {
          socketEvent(id, { type: 'error', message: refusal });
          socketEvent(id, { type: 'close', code: 1006, reason: '', wasClean: false });
        });
        return id;
      }
      const list = protocols
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      // Deferred, so the app's constructor returns before any event arrives.
      later(() =>
        sockets?.handle({
          type: 'websocket-command',
          timestamp: 0,
          socketId: id,
          action: 'open',
          url,
          protocols: list,
        }),
      );
      return id;
    },
    sendSocket(id, data, binary) {
      sockets?.handle({
        type: 'websocket-command',
        timestamp: 0,
        socketId: id,
        action: 'send',
        data: binary ? Array.from(fromBase64(data)) : data,
      });
    },
    closeSocket(id, code, reason) {
      sockets?.handle({
        type: 'websocket-command',
        timestamp: 0,
        socketId: id,
        action: 'close',
        code,
        reason,
      });
    },
    configure(next) {
      stop();
      setting = next;
      start();
    },
    dispose() {
      stop();
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
