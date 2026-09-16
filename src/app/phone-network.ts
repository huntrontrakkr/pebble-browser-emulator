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
  if (typeof result.body !== 'string') throw new TypeError('Network responses must contain text.');
  if (byteLength(result.body) > maxBytes)
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
    body: result.body,
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
/** The only optional network capability. It remains outside QuickJS and requires CORS. */
export class PhoneCorsNetwork {
  private readonly pending = new Map<
    number,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private readonly limits: Required<CorsNetworkLimits>;
  private readonly deliver: (requestId: number, result: PhoneNetworkResult) => void;
  private readonly fetcher: typeof fetch;
  constructor(
    deliver: (requestId: number, result: PhoneNetworkResult) => void,
    options: CorsNetworkLimits = {},
    fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.deliver = deliver;
    this.fetcher = fetcher;
    this.limits = {
      pendingRequests: 8,
      requestBytes: 8192,
      responseBytes: 1024 * 1024,
      timeoutMs: 30000,
      ...options,
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
      if (byteLength(JSON.stringify(request)) > this.limits.requestBytes + 256)
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
      const response = await this.fetcher(url.href, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
      });
      if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0)
        throw new Error('The response is unavailable through browser CORS.');
      const advertised = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertised) && advertised > this.limits.responseBytes) {
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
            if (bytes > this.limits.responseBytes) {
              await reader.cancel();
              finish({
                error: 'limit',
                message: 'Network response size limit exceeded.',
              });
              return;
            }
            body += decoder.decode(part.value, { stream: true });
          }
          body += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      finish(
        normalizeNetworkResult(
          {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body,
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
}
