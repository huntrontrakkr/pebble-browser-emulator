import type {
  PhoneNetworkOptions,
  PhoneNetworkRequest,
  PhoneNetworkResult,
  VirtualPhoneEvent,
  VirtualPhoneLimits,
} from './virtual-phone.types.ts';
const utf8 = new TextEncoder();
const byteLength = (value: string) => utf8.encode(value).length;

export function normalizeNetworkResult(
  result: PhoneNetworkResult,
  maxBytes: number,
): PhoneNetworkResult {
  if (!result || typeof result !== 'object') throw new TypeError('Invalid network result.');
  if ('error' in result) {
    if (!['network', 'timeout', 'abort', 'disabled', 'limit'].includes(result.error))
      throw new TypeError('Invalid network error.');
    return {
      error: result.error,
      message: String(result.message ?? result.error).slice(0, 1024),
    };
  }
  if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599)
    throw new TypeError('Invalid HTTP response status.');
  if (
    (typeof result.body !== 'string' && typeof result.bodyBase64 !== 'string') ||
    (result.body !== undefined && result.bodyBase64 !== undefined)
  )
    throw new TypeError('Network responses must contain text or base64 bytes.');
  if (
    result.bodyBase64 !== undefined &&
    (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.bodyBase64) ||
      result.bodyBase64.length > Math.ceil(Math.min(maxBytes, 256 * 1024) / 3) * 4 ||
      atob(result.bodyBase64).length > Math.min(maxBytes, 256 * 1024))
  )
    return {
      error: 'limit',
      message: 'Network binary response limit exceeded or encoding invalid.',
    };
  if (result.body !== undefined && byteLength(result.body) > maxBytes)
    return { error: 'limit', message: 'Network response size limit exceeded.' };
  const headers: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || /[\r\n\0]/.test(String(value)))
      throw new TypeError('Invalid response header.');
    if (key.toLowerCase() === 'set-cookie' || key.toLowerCase() === 'set-cookie2') continue;
    headers[key.toLowerCase()] = String(value);
  }
  if (byteLength(JSON.stringify(headers)) > 16384)
    return { error: 'limit', message: 'Response header size limit exceeded.' };
  return {
    status: result.status,
    statusText: String(result.statusText ?? '').slice(0, 256),
    headers,
    ...(result.body === undefined ? {} : { body: result.body }),
    ...(result.bodyBase64 === undefined ? {} : { bodyBase64: result.bodyBase64 }),
    ...(result.url === undefined ? {} : { url: String(result.url).slice(0, 4096) }),
    redirected: !!result.redirected,
  };
}

export function normalizeNetworkOptions(
  options: PhoneNetworkOptions | undefined,
  limits: VirtualPhoneLimits,
): Required<PhoneNetworkOptions> {
  const mode = options?.mode ?? 'disabled';
  if (!['disabled', 'fixtures', 'cors'].includes(mode))
    throw new Error('Invalid phone network mode.');
  const fixtures = options?.fixtures ?? [];
  if (fixtures.length > 128) throw new Error('Network fixture count limit exceeded.');
  let total = 0;
  return {
    mode,
    fixtures: fixtures.map((fixture) => {
      if (
        typeof fixture.url !== 'string' ||
        fixture.url.length > 4096 ||
        !/^https?:\/\//i.test(fixture.url)
      )
        throw new TypeError('Invalid fixture URL.');
      const method = (fixture.method ?? 'GET').toUpperCase();
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method))
        throw new TypeError('Invalid fixture method.');
      if (fixture.body !== undefined && fixture.body !== null && typeof fixture.body !== 'string')
        throw new TypeError('Invalid fixture request body.');
      const delayMs = fixture.delayMs ?? 0;
      if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > limits.networkTimeoutMs * 2)
        throw new TypeError('Invalid fixture delay.');
      const normalized = {
        url: fixture.url,
        method,
        ...(fixture.body === undefined ? {} : { body: fixture.body }),
        response: normalizeNetworkResult(fixture.response, limits.networkResponseBytes),
        delayMs,
      };
      total += byteLength(JSON.stringify(normalized));
      if (total > Math.min(limits.memoryBytes / 2, limits.networkResponseBytes * 4))
        throw new Error('Network fixture data limit exceeded.');
      return normalized;
    }),
  };
}

export interface CorsNetworkLimits {
  pendingRequests?: number;
  requestBytes?: number;
  responseBytes?: number;
  timeoutMs?: number;
}
export interface CorsNetworkOptions extends CorsNetworkLimits {
  /** Optional service that can read hosts the browser refuses. */
  relay?: { endpoint: string; key: string };
}
/** The only optional network capability. It remains outside QuickJS and requires CORS. */
export class PhoneCorsNetwork {
  private readonly pending = new Map<
    number,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private readonly limits: Required<CorsNetworkLimits>;
  private readonly relay?: { endpoint: string; key: string };
  private readonly deliver: (requestId: number, result: PhoneNetworkResult) => void;
  private readonly fetcher: typeof fetch;
  constructor(
    deliver: (requestId: number, result: PhoneNetworkResult) => void,
    options: CorsNetworkOptions = {},
    fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    // The relay is not a numeric limit and must stay out of the bounds below.
    const { relay, ...limits } = options;
    this.deliver = deliver;
    this.fetcher = fetcher;
    this.relay = relay;
    this.limits = {
      pendingRequests: 8,
      requestBytes: 8192,
      responseBytes: 1024 * 1024,
      timeoutMs: 30000,
      ...limits,
    };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error('Invalid CORS network limit.');
  }
  handle(event: VirtualPhoneEvent): void {
    if (this.closed) return;
    if (event.type === 'network-cancel') {
      this.cancel(event.requestId);
      return;
    }
    if (event.type !== 'network-request') return;
    void this.start(event.request);
  }
  dispose(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
  private cancel(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.controller.abort();
  }
  private async start(request: PhoneNetworkRequest): Promise<void> {
    const id = request.id;
    if (!Number.isSafeInteger(id) || id < 1 || this.pending.has(id)) return;
    let url: URL;
    try {
      url = new URL(request.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method))
        throw new Error('Unsupported HTTP method.');
      const binary = request.bodyBytes?.length ?? 0;
      if (
        byteLength(JSON.stringify({ ...request, bodyBytes: undefined })) + binary >
        this.limits.requestBytes + 256
      )
        throw new Error('Network request size limit exceeded.');
      if (this.pending.size >= this.limits.pendingRequests)
        throw new Error('Pending network request limit exceeded.');
    } catch (error) {
      this.deliver(id, { error: 'network', message: String(error) });
      return;
    }
    const controller = new AbortController();
    const timeout = Math.max(
      1,
      Math.min(request.timeoutMs || this.limits.timeoutMs, this.limits.timeoutMs),
    );
    const item = {
      controller,
      timer: setTimeout(
        () =>
          finish({
            error: 'timeout',
            message: 'Browser network request timed out.',
          }),
        timeout,
      ),
    };
    const finish = (result: PhoneNetworkResult) => {
      if (this.closed || this.pending.get(id) !== item) return;
      this.pending.delete(id);
      clearTimeout(item.timer);
      controller.abort();
      this.deliver(id, result);
    };
    this.pending.set(id, item);
    try {
      let relayed = false;
      let response = await this.fetcher(url.href, {
        method: request.method,
        headers: request.headers,
        body: request.bodyBytes ?? request.body,
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
      }).catch(async (error: unknown) => {
        // The browser refused it. A configured relay may still be able to read
        // this host; anything it cannot do surfaces as the relay's own reason.
        const retry = this.relayRequestFor(url, request);
        if (!retry) throw error;
        relayed = true;
        return this.fetcher(retry.href, {
          method: request.method,
          headers: { 'X-Pebble-Relay-Key': this.relay!.key },
          signal: controller.signal,
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
        });
      });
      if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0)
        throw new Error('The response is unavailable through browser CORS.');
      if (relayed && response.status === 502) {
        const detail = await response
          .clone()
          .json()
          .catch(() => null);
        throw new Error(
          `The download service could not reach this host: ${detail?.error ?? response.status}`,
        );
      }
      if (relayed && (response.status === 401 || response.status === 404))
        throw new Error('The download service is not relaying app requests for this site.');
      const binary = request.responseType === 'arraybuffer' || request.responseType === 'blob';
      const maximum = binary
        ? Math.min(this.limits.responseBytes, 256 * 1024)
        : this.limits.responseBytes;
      const advertised = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertised) && advertised > maximum) {
        finish({
          error: 'limit',
          message: 'Network response size limit exceeded.',
        });
        return;
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let bytes = 0,
        body = '';
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (this.closed || this.pending.get(id) !== item) {
              await reader.cancel();
              return;
            }
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maximum) {
              await reader.cancel();
              finish({
                error: 'limit',
                message: 'Network response size limit exceeded.',
              });
              return;
            }
            if (binary) chunks.push(part.value.slice());
            else body += decoder.decode(part.value, { stream: true });
          }
          if (!binary) body += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      let bodyBase64: string | undefined;
      if (binary) {
        const all = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let encoded = '';
        for (let i = 0; i < all.length; i += 8192)
          encoded += String.fromCharCode(...all.subarray(i, i + 8192));
        bodyBase64 = btoa(encoded);
      }
      finish(
        normalizeNetworkResult(
          {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            ...(binary ? { bodyBase64 } : { body }),
            url: response.url || url.href,
            redirected: response.redirected,
          },
          this.limits.responseBytes,
        ),
      );
    } catch (error) {
      finish({
        error: 'network',
        message: `Browser CORS/network request failed: ${String(error)}`,
      });
    }
  }
  private relayRequestFor(url: URL, request: PhoneNetworkRequest): URL | undefined {
    return relayRequestFor(this.relay, url, request);
  }
}

/**
 * The relay URL for a request the browser refused, or undefined when relaying
 * is unconfigured or the request is not one the relay accepts. Only plain
 * GET/HEAD without a body qualifies, matching what the service will perform.
 */
export function relayRequestFor(
  relay: { endpoint: string; key: string } | undefined,
  url: URL,
  request: { method: string; body: string | null; bodyBytes?: Uint8Array },
): URL | undefined {
  if (!relay?.endpoint || !relay.key) return undefined;
  if (!['GET', 'HEAD'].includes(request.method)) return undefined;
  if (request.body || request.bodyBytes?.length) return undefined;
  if (url.protocol !== 'https:') return undefined;
  const target = new URL(`${relay.endpoint}/v1/app-fetch`);
  target.searchParams.set('url', url.href);
  return target;
}
