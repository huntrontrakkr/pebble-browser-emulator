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
import { PhoneCorsNetwork, relayRequestFor, type CorsNetworkOptions } from './phone-network.ts';
import { PhoneWebSocketNetwork, type PhoneSocketLimits } from './phone-websocket.ts';
import type { PhoneNetworkResult, PhoneSocketEvent } from './virtual-phone.types.ts';

export interface PhoneNetworkSetting {
  /** The session's phone network setting; only `cors` reaches the network. */
  mode: 'disabled' | 'fixtures' | 'cors';
  relay?: { endpoint: string; key: string };
}

export interface LibPebbleNetworkHost {
  /**
   * Starts one request, `{method, url, headers, body}` or, for bytes, `{…, bodyBase64}`
   * (body is text or null), and
   * returns its id. `done` receives `{status, statusText, headers, bodyBase64}` or
   * `{error, message}` as JSON, once.
   */
  request(json: string, done: (result: string) => void): number;
  /**
   * The same request made synchronously, for upstream's synchronous XMLHttpRequest: the
   * phone's worker waits on the browser's own blocking request. Same setting, limits,
   * CORS and relay; the result is returned instead of passed to a callback.
   */
  requestSync(json: string): string;
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
  /** A blocking-capable XMLHttpRequest; by default the worker's own, none elsewhere. */
  syncRequest?: () => XMLHttpRequest;
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

  const limits = {
    requestBytes: 8192,
    responseBytes: 1024 * 1024,
    timeoutMs: 30000,
    ...options.requestLimits,
  };
  const syncRequest =
    options.syncRequest ??
    ('WorkerGlobalScope' in globalThis && typeof XMLHttpRequest === 'function'
      ? () => new XMLHttpRequest()
      : undefined);

  function requestSync(json: string): PhoneNetworkResult {
    const refusal = refused();
    if (refusal) return { error: 'disabled', message: refusal };
    if (!syncRequest)
      return { error: 'network', message: 'Synchronous requests need the phone worker.' };
    let request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string | null;
      bodyBase64?: string;
    };
    let url: URL;
    let body: string | Uint8Array | null;
    try {
      request = JSON.parse(json);
      body =
        typeof request.bodyBase64 === 'string'
          ? fromBase64(request.bodyBase64)
          : (request.body ?? null);
      request.method = String(request.method).toUpperCase();
      url = new URL(request.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method))
        throw new Error('Unsupported HTTP method.');
      if (new TextEncoder().encode(json).length > limits.requestBytes + 256)
        throw new Error('Network request size limit exceeded.');
    } catch (error) {
      return { error: 'network', message: String(error) };
    }
    const attempt = (
      target: URL,
      headers: Record<string, string>,
      body: string | Uint8Array | null,
    ) => {
      const xhr = syncRequest();
      xhr.open(request.method, target.href, false);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = limits.timeoutMs;
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.send(body as XMLHttpRequestBodyInit | null);
      return xhr;
    };
    let xhr: XMLHttpRequest;
    let relayed = false;
    try {
      xhr = attempt(url, request.headers ?? {}, body);
    } catch (error) {
      // The browser refused it; a configured relay may still read this host, as for
      // asynchronous requests.
      const retry = relayRequestFor(setting.relay, url, {
        method: request.method,
        body: typeof body === 'string' ? body : null,
        bodyBytes: body instanceof Uint8Array ? body : undefined,
      });
      if (!retry)
        return {
          error: 'network',
          message: `Browser CORS/network request failed: ${String(error)}`,
        };
      try {
        xhr = attempt(retry, { 'X-Pebble-Relay-Key': setting.relay!.key }, null);
        relayed = true;
      } catch (relayError) {
        return {
          error: 'network',
          message: `Browser CORS/network request failed: ${String(relayError)}`,
        };
      }
    }
    if (xhr.status === 0)
      return { error: 'network', message: 'The response is unavailable through browser CORS.' };
    if (relayed && xhr.status === 502)
      return { error: 'network', message: 'The download service could not reach this host.' };
    if (relayed && (xhr.status === 401 || xhr.status === 404))
      return {
        error: 'network',
        message: 'The download service is not relaying app requests for this site.',
      };
    const bytes = new Uint8Array(xhr.response ?? new ArrayBuffer(0));
    if (bytes.length > Math.min(limits.responseBytes, 256 * 1024))
      return { error: 'limit', message: 'Network response size limit exceeded.' };
    const headers: Record<string, string> = {};
    for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      if (name === 'set-cookie' || name === 'set-cookie2') continue;
      headers[name] = line.slice(colon + 1).trim();
    }
    return { status: xhr.status, statusText: xhr.statusText, headers, bodyBase64: toBase64(bytes) };
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
        bodyBase64?: string;
      };
      let bodyBytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        request = JSON.parse(json);
        if (typeof request.bodyBase64 === 'string') bodyBytes = fromBase64(request.bodyBase64);
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
          body: bodyBytes ? null : (request.body ?? null),
          ...(bodyBytes ? { bodyBytes } : {}),
          timeoutMs: 0,
          // The engine gets exact bytes and decodes them by the response's charset.
          responseType: 'arraybuffer',
        },
      });
      return id;
    },
    requestSync(json) {
      let reply = '';
      const id = nextId++;
      waiting.set(id, (result) => (reply = result));
      settle(id, requestSync(json));
      return reply;
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

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
