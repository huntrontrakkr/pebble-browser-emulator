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

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, message, stack } = error as { name?: string; message?: string; stack?: string };
    return [`${name ?? 'Error'}: ${message ?? ''}`, stack].filter(Boolean).join('\n');
  }
  return String(error);
}
