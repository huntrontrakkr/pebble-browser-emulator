/**
 * The JavaScript engine for the libpebble3 phone's PebbleKit JS runner
 * (`BrowserJsRunner` in tools/phone-spike). libpebble3 asks for one engine per running
 * app through `pebblePhoneHost.pkjs.create`; each is a separate QuickJS runtime,
 * isolated from the page and from other apps, with memory, stack and time limits so
 * app code stays bounded and cancellable. The engine knows nothing about Pebble: the
 * runner loads upstream's scripts into it and answers the app's calls through the one
 * native function, `__nativeDispatch`.
 */
import {
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

/** Answers a call from app JS: object and method names, arguments as a JSON array. */
export type PkjsDispatch = (object: string, method: string, argsJson: string) => string;

export interface PkjsEngine {
  /** Runs code; returns `{"v": result}` or `{"e": message}` as JSON. */
  eval(code: string, fileName: string): string;
  destroy(): void;
}

export interface PkjsHost {
  create(label: string, dispatch: PkjsDispatch): PkjsEngine;
}

export interface PkjsLimits {
  memoryBytes: number;
  stackBytes: number;
  /** Longest one evaluation (a script, a timer, a message) may run. */
  evalMilliseconds: number;
  pendingJobs: number;
}

export const DEFAULT_PKJS_LIMITS: PkjsLimits = {
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  evalMilliseconds: 1000,
  pendingJobs: 1000,
};

export type PkjsConsole = (label: string, level: string, text: string) => void;

export function quickJsPkjsHost(
  quickjs: QuickJSWASMModule,
  options: { limits?: Partial<PkjsLimits>; console?: PkjsConsole } = {},
): PkjsHost {
  const limits = { ...DEFAULT_PKJS_LIMITS, ...options.limits };
  const log = options.console ?? (() => {});
  return { create: (label, dispatch) => new QuickJsEngine(quickjs, limits, label, dispatch, log) };
}

class QuickJsEngine implements PkjsEngine {
  private runtime: QuickJSRuntime | undefined;
  private context: QuickJSContext | undefined;
  private readonly limits: PkjsLimits;
  private readonly label: string;

  constructor(
    quickjs: QuickJSWASMModule,
    limits: PkjsLimits,
    label: string,
    dispatch: PkjsDispatch,
    log: PkjsConsole,
  ) {
    this.limits = limits;
    this.label = label;
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const context = runtime.newContext();
    this.runtime = runtime;
    this.context = context;

    const native = context.newFunction('__nativeDispatch', (object, method, args) =>
      context.newString(
        dispatch(context.getString(object), context.getString(method), context.getString(args)),
      ),
    );
    context.setProp(context.global, '__nativeDispatch', native);
    native.dispose();

    // A base console for startup.js to wrap; upstream routes app logs through _Pebble.
    const consoleObject = context.newObject();
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      const fn = context.newFunction(level, (...args: QuickJSHandle[]) => {
        log(label, level, args.map((arg) => String(context.dump(arg))).join(' '));
      });
      context.setProp(consoleObject, level, fn);
      fn.dispose();
    }
    const assert = context.newFunction('assert', (condition, ...args: QuickJSHandle[]) => {
      if (!context.dump(condition))
        log(label, 'assert', args.map((arg) => String(context.dump(arg))).join(' '));
    });
    context.setProp(consoleObject, 'assert', assert);
    assert.dispose();
    context.setProp(context.global, 'console', consoleObject);
    consoleObject.dispose();

    const builtins = context.evalCode(BASE64_BUILTINS, 'base64-builtins.js');
    if (builtins.error) {
      const failure = describe(context.dump(builtins.error));
      builtins.error.dispose();
      this.destroy();
      throw new Error(`The PebbleKit JS engine could not start: ${failure}`);
    }
    builtins.value.dispose();
  }

  eval(code: string, fileName: string): string {
    const runtime = this.runtime;
    const context = this.context;
    if (!runtime || !context) return JSON.stringify({ e: `${this.label} has stopped` });
    runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + this.limits.evalMilliseconds),
    );
    const result = context.evalCode(code, fileName);
    let outcome: { v: unknown } | { e: string };
    if (result.error) {
      outcome = { e: describe(context.dump(result.error)) };
      if (result.error.alive) result.error.dispose();
    } else {
      // dump() consumes a promise's handle itself.
      outcome = { v: context.dump(result.value) ?? null };
      if (result.value.alive) result.value.dispose();
    }
    const jobs = runtime.executePendingJobs(this.limits.pendingJobs);
    if (jobs.error) {
      const failure = describe(context.dump(jobs.error));
      if (jobs.error.alive) jobs.error.dispose();
      if (!('e' in outcome)) outcome = { e: `in a pending job: ${failure}` };
    }
    try {
      return JSON.stringify(outcome);
    } catch {
      return JSON.stringify({ v: null });
    }
  }

  destroy(): void {
    this.context?.dispose();
    this.runtime?.dispose();
    this.context = undefined;
    this.runtime = undefined;
  }
}

/**
 * `Uint8Array.fromBase64` and `Uint8Array.prototype.toBase64` (ECMAScript 2026), which
 * upstream's XMLHttpRequest and WebSocket use for binary data and which this QuickJS
 * release lacks. Standard alphabets and padding; `lastChunkHandling` is `loose` only.
 * Installed only where the engine has none.
 */
export const BASE64_BUILTINS = String.raw`(function () {
  var tables = {
    base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  };
  function alphabet(options) {
    var name = options && options.alphabet !== undefined ? options.alphabet : 'base64';
    if (!Object.prototype.hasOwnProperty.call(tables, name))
      throw new TypeError('Invalid base64 alphabet');
    return tables[name];
  }
  function define(target, name, fn) {
    if (typeof target[name] === 'function') return;
    Object.defineProperty(target, name, { value: fn, writable: true, configurable: true });
  }
  define(Uint8Array, 'fromBase64', function fromBase64(string, options) {
    if (typeof string !== 'string') throw new TypeError('fromBase64 needs a string');
    if (options && options.lastChunkHandling !== undefined && options.lastChunkHandling !== 'loose')
      throw new TypeError('Only loose lastChunkHandling is supported');
    var table = alphabet(options);
    var text = string.replace(/[\t\n\f\r ]/g, '');
    var padding = /=+$/.exec(text);
    var body = padding ? text.slice(0, -padding[0].length) : text;
    if ((padding && (padding[0].length > 2 || text.length % 4 !== 0)) || body.length % 4 === 1)
      throw new SyntaxError('Invalid base64 string');
    var out = new Uint8Array(Math.floor((body.length * 3) / 4));
    var bits = 0, value = 0, offset = 0;
    for (var i = 0; i < body.length; i++) {
      var digit = table.indexOf(body[i]);
      if (digit < 0) throw new SyntaxError('Invalid base64 character');
      value = (value << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[offset++] = (value >> bits) & 255;
      }
    }
    return out;
  });
  define(Uint8Array.prototype, 'toBase64', function toBase64(options) {
    var table = alphabet(options);
    var pad = !(options && options.omitPadding);
    var out = '';
    for (var i = 0; i < this.length; i += 3) {
      var n = (this[i] << 16) | ((this[i + 1] || 0) << 8) | (this[i + 2] || 0);
      var left = this.length - i;
      out += table[(n >> 18) & 63] + table[(n >> 12) & 63];
      out += left > 1 ? table[(n >> 6) & 63] : pad ? '=' : '';
      out += left > 2 ? table[n & 63] : pad ? '=' : '';
    }
    return out;
  });
})();`;

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, message, stack } = error as { name?: string; message?: string; stack?: string };
    return [`${name ?? 'Error'}: ${message ?? ''}`, stack].filter(Boolean).join('\n');
  }
  return String(error);
}
