import { WEBSOCKET_BOOTSTRAP } from './websocket-bootstrap.ts';
import { normalizeSocketEvent, normalizeSocketUrl } from './phone-websocket.ts';
import { NETWORK_BOOTSTRAP } from './network-bootstrap.ts';
import { normalizeNetworkResult, normalizeNetworkOptions } from './phone-network.ts';
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten';
import type {
  PhoneNetworkResult,
  AppMessageDictionary,
  PhoneCoordinates,
  PhoneSocketEvent,
  VirtualPhoneEvent,
  VirtualPhoneLimits,
  VirtualPhoneOptions,
} from './virtual-phone.types.ts';
export type {
  PhoneNetworkResult,
  AppMessageDictionary,
  PhoneCoordinates,
  PhoneSocketEvent,
  VirtualPhoneEvent,
  VirtualPhoneLimits,
  VirtualPhoneOptions,
} from './virtual-phone.types.ts';

const DEFAULT_LIMITS: VirtualPhoneLimits = {
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  turnMilliseconds: 100,
  sourceBytes: 2 * 1024 * 1024,
  storageBytes: 256 * 1024,
  eventBytes: 16 * 1024,
  eventCount: 256,
  outputBytes: 1024 * 1024,
  timers: 128,
  timerCallbacks: 1000,
  pendingJobs: 1000,
  pendingMessages: 32,
  messageTimeoutMs: 10000,
  pendingNetworkRequests: 8,
  networkRequestBytes: 8 * 1024,
  networkResponseBytes: 1024 * 1024,
  networkTimeoutMs: 30000,
  configurationBytes: 512 * 1024,
  pendingSockets: 4,
  socketMessageBytes: 64 * 1024,
  socketBufferedBytes: 128 * 1024,
  socketTimeoutMs: 30000,
};
const utf8 = new TextEncoder();

/**
 * Actual QuickJS execution, with no browser/Node/network objects passed into the VM.
 * The supplied module can come from getQuickJS() in tests or a self-hosted Wasm
 * variant in a Worker. Virtual time advances only through advanceTime().
 * Outbound app messages are intentions: only acknowledgeAppMessage() can ACK one.
 */
export class VirtualPhone {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly limits: VirtualPhoneLimits;
  private control!: QuickJSHandle;
  private events: VirtualPhoneEvent[] = [];
  private outputBytes = 0;
  private storageRevision = 0;
  private storageReadRevision = -1;
  private deadline = Infinity;
  private started = false;
  private dead = false;
  private failed = false;
  private nowMs: number;

  constructor(module: QuickJSWASMModule, options: VirtualPhoneOptions) {
    if (!options.appId || options.appId.length > 128) throw new Error('A valid appId is required.');
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid limit: ${key}`);
    }
    if (
      this.limits.eventCount < 2 ||
      this.limits.eventBytes < 256 ||
      this.limits.outputBytes < 512
    ) {
      throw new Error('Output limits must allow at least two events and a limit notice.');
    }
    this.nowMs = options.nowMs ?? 0;
    this.checkTime(this.nowMs);
    if (
      options.randomSeed !== undefined &&
      (!Number.isInteger(options.randomSeed) ||
        options.randomSeed < 0 ||
        options.randomSeed > 4294967295)
    )
      throw new Error('Invalid random seed.');
    const coordinates = normalizeCoordinates(
      options.coordinates ?? { latitude: 0, longitude: 0, accuracy: 0 },
    );
    const language = options.language ?? 'en-US';
    if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(language) || language.length > 64)
      throw new Error('Invalid phone language tag.');
    const config = {
      language,
      appId: options.appId,
      nowMs: this.nowMs,
      randomSeed: options.randomSeed,
      coordinates,
      storage: options.storage ?? {},
      messageKeys: options.messageKeys ?? {},
      limits: this.limits,
      network: normalizeNetworkOptions(options.network, this.limits),
      watchInfo: options.watchInfo ?? null,
      appInfo: options.appInfo ?? { uuid: options.appId },
      accountToken: String(options.accountToken ?? ''),
      watchToken: String(options.watchToken ?? ''),
    };
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(this.limits.memoryBytes);
    this.runtime.setMaxStackSize(this.limits.stackBytes);
    this.runtime.setInterruptHandler(() => Date.now() >= this.deadline);
    // No module loader is installed. import()/require cannot fetch host modules.
    this.context = this.runtime.newContext();
    const bridge = this.context.newFunction('__phoneEmit', (value) => {
      const serialized = this.context.getString(value);
      return this.record(serialized) ? this.context.true : this.context.false;
    });
    this.context.setProp(this.context.global, '__phoneEmit', bridge);
    bridge.dispose();
    // A synchronous, string-only URL parser; no host objects or network access enter the VM.
    const socketUrl = this.context.newFunction('__phoneSocketUrl', (value) => {
      let result;
      try {
        result = { url: normalizeSocketUrl(this.context.getString(value)) };
      } catch (error) {
        result = { error: String(error) };
      }
      return this.context.newString(JSON.stringify(result));
    });
    this.context.setProp(this.context.global, '__phoneSocketUrl', socketUrl);
    socketUrl.dispose();
    try {
      this.withBudget(() => {
        const result = this.context.evalCode(
          `(${BOOTSTRAP})(${JSON.stringify(config)})`,
          'virtual-phone-bootstrap.js',
        );
        if (result.error) throw this.takeError(result.error);
        this.control = result.value;
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  start(source: string, filename = 'pebble-js-app.js'): void {
    this.assertAlive();
    if (this.started)
      throw new Error(
        'This phone has already started an app. Create a new instance to replace it.',
      );
    if (utf8.encode(source).length > this.limits.sourceBytes)
      throw new Error('PKJS source limit exceeded.');
    this.started = true;
    this.withBudget(() => {
      const result = this.context.evalCode(source, filename, {
        type: 'global',
      });
      if (result.error) throw this.takeError(result.error);
      result.value.dispose();
      this.drainJobs();
      this.call('ready');
      this.drainAt(this.nowMs);
    });
  }

  /** Absolute Unix milliseconds; moving virtual time backwards is rejected. */
  advanceTime(nowMs: number): void {
    this.checkTime(nowMs);
    if (nowMs < this.nowMs) throw new Error('Virtual time cannot move backwards.');
    this.assertAlive();
    this.withBudget(() => this.drainAt(nowMs));
    this.nowMs = nowMs;
  }
  setLocation(coordinates: PhoneCoordinates): void {
    this.perform('location', JSON.stringify(normalizeCoordinates(coordinates)));
  }
  setLocationError(code: 1 | 2 | 3, message = 'Location unavailable'): void {
    if (![1, 2, 3].includes(code) || typeof message !== 'string' || message.length > 1000)
      throw new Error('Invalid geolocation error.');
    this.perform('locationError', code, message);
  }
  injectAppMessage(payload: AppMessageDictionary): void {
    this.perform('appmessage', JSON.stringify(payload));
  }
  showConfiguration(): void {
    this.perform('configuration');
  }
  closeConfiguration(response: string | null, requestId?: number): boolean {
    if (response !== null && typeof response !== 'string')
      throw new TypeError('Configuration response must be a string or null.');
    if (response !== null && utf8.encode(response).length > this.limits.configurationBytes)
      throw new Error('Configuration response limit exceeded.');
    return this.perform('configurationClosed', response ?? '', requestId ?? null) === true;
  }
  /** Delivers only bounded text/JSON response data, never a host object or function. */
  deliverNetworkResponse(requestId: number, result: PhoneNetworkResult): boolean {
    if (!Number.isSafeInteger(requestId) || requestId < 1) return false;
    const normalized = normalizeNetworkResult(result, this.limits.networkResponseBytes);
    return this.perform('networkResponse', requestId, JSON.stringify(normalized)) === true;
  }
  deliverWebSocketEvent(socketId: number, event: PhoneSocketEvent): boolean {
    if (!Number.isSafeInteger(socketId) || socketId < 1) return false;
    return (
      this.perform(
        'websocketEvent',
        socketId,
        JSON.stringify(normalizeSocketEvent(event, this.limits.socketMessageBytes)),
      ) === true
    );
  }
  setConnected(connected: boolean): void {
    this.perform('connection', connected);
  }
  /** Returns false for unknown/expired transactions; no synthetic success is generated. */
  acknowledgeAppMessage(transactionId: number, accepted: boolean): boolean {
    if (!Number.isInteger(transactionId) || transactionId < 0 || transactionId > 255) return false;
    return this.perform('ack', transactionId, accepted) === true;
  }
  getStorage(): Record<string, string> {
    return JSON.parse(String(this.perform('storage'))) as Record<string, string>;
  }
  /** Initial snapshot and subsequent mutations, including writes beyond the log quota. */
  readStorageIfChanged(): Record<string, string> | undefined {
    this.assertAlive();
    if (this.storageReadRevision === this.storageRevision) return;
    const revision = this.storageRevision;
    const values = this.getStorage();
    this.storageReadRevision = revision;
    return values;
  }
  drainEvents(): VirtualPhoneEvent[] {
    const result = this.events;
    this.events = [];
    this.outputBytes = 0;
    return result;
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.control?.dispose();
    this.context.dispose();
    this.runtime.dispose();
  }
  private checkTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8.64e15)
      throw new Error('Invalid virtual time.');
  }
  private assertAlive(): void {
    if (this.dead) throw new Error('Virtual phone has been disposed.');
    if (this.failed) throw new Error('Virtual phone stopped after an execution error.');
  }
  private perform(name: string, ...args: (string | number | boolean | null)[]): unknown {
    this.assertAlive();
    return this.withBudget(() => {
      const value = this.call(name, ...args);
      this.drainAt(this.nowMs);
      return value;
    });
  }
  private call(name: string, ...args: (string | number | boolean | null)[]): unknown {
    const fn = this.context.getProp(this.control, name);
    const handles = args.map((value) =>
      typeof value === 'string'
        ? this.context.newString(value)
        : typeof value === 'number'
          ? this.context.newNumber(value)
          : value === null
            ? this.context.null.dup()
            : (value ? this.context.true : this.context.false).dup(),
    );
    try {
      const result = this.context.callFunction(fn, this.control, handles);
      if (result.error) throw this.takeError(result.error);
      try {
        return this.context.dump(result.value);
      } finally {
        result.value.dispose();
      }
    } finally {
      fn.dispose();
      for (const value of handles) value.dispose();
    }
  }
  private withBudget<T>(fn: () => T): T {
    this.deadline = Date.now() + this.limits.turnMilliseconds;
    try {
      return fn();
    } catch (error) {
      this.failed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.record(JSON.stringify({ type: 'error', message, timestamp: this.nowMs }));
      throw error;
    } finally {
      this.deadline = Infinity;
    }
  }
  private takeError(handle: QuickJSHandle): Error {
    try {
      const value = this.context.dump(handle) as
        { name?: string; message?: string; stack?: string } | string;
      return new Error(
        typeof value === 'string'
          ? value
          : `${value.name ?? 'PKJS error'}: ${value.message ?? 'Execution failed'}${value.stack ? '\n' + value.stack : ''}`,
      );
    } finally {
      handle.dispose();
    }
  }
  private drainAt(target: number): void {
    let callbacks = 0;
    while (true) {
      this.drainJobs();
      if (this.call('timer', target) !== true) return;
      if (++callbacks > this.limits.timerCallbacks)
        throw new Error('Timer callback limit exceeded.');
    }
  }
  private drainJobs(): void {
    const result = this.runtime.executePendingJobs(this.limits.pendingJobs);
    if (result.error) throw this.takeError(result.error);
    if (this.runtime.hasPendingJob()) throw new Error('PKJS pending-job limit exceeded.');
  }
  private record(serialized: string): boolean {
    const size = utf8.encode(serialized).length;
    const parsed = JSON.parse(serialized) as VirtualPhoneEvent;
    // Persistence must remain correct even when diagnostic output is full.
    if (parsed.type === 'storage') this.storageRevision++;
    const eventLimit =
      parsed.type === 'configuration'
        ? this.limits.configurationBytes + 256
        : parsed.type === 'websocket-command'
          ? this.limits.socketMessageBytes * 4 + 4096
          : this.limits.eventBytes;
    if (
      size > eventLimit ||
      this.events.length >= this.limits.eventCount - 1 ||
      this.outputBytes + size > this.limits.outputBytes - 192
    ) {
      if (this.events.at(-1)?.type !== 'limit') {
        const notice: VirtualPhoneEvent = {
          type: 'limit',
          resource: 'output',
          message: 'Virtual phone output limit reached; drainEvents() to resume capture.',
          timestamp: this.nowMs,
        };
        this.events.push(notice);
        this.outputBytes += utf8.encode(JSON.stringify(notice)).length;
      }
      return false;
    }
    this.events.push(parsed);
    this.outputBytes += size;
    return true;
  }
}

function normalizeCoordinates(value: PhoneCoordinates): Required<PhoneCoordinates> {
  if (
    !Number.isFinite(value.latitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    !Number.isFinite(value.longitude) ||
    value.longitude < -180 ||
    value.longitude > 180
  ) {
    throw new Error('Invalid latitude/longitude.');
  }
  const accuracy = value.accuracy ?? 0;
  if (!Number.isFinite(accuracy) || accuracy < 0) throw new Error('Invalid geolocation accuracy.');
  const output: Required<PhoneCoordinates> = {
    latitude: value.latitude,
    longitude: value.longitude,
    accuracy,
    altitude: value.altitude ?? null,
    altitudeAccuracy: value.altitudeAccuracy ?? null,
    heading: value.heading ?? null,
    speed: value.speed ?? null,
  };
  for (const key of ['altitude', 'altitudeAccuracy', 'heading', 'speed'] as const) {
    if (output[key] !== null && !Number.isFinite(output[key]))
      throw new Error(`Invalid geolocation ${key}.`);
  }
  if (
    (output.altitudeAccuracy !== null && output.altitudeAccuracy < 0) ||
    (output.speed !== null && output.speed < 0) ||
    (output.heading !== null && (output.heading < 0 || output.heading >= 360))
  )
    throw new Error('Invalid geolocation altitude accuracy, speed, or heading.');
  return output;
}

// Every function below runs inside QuickJS. Its sole host capability accepts a
// bounded JSON event string; the capability and controller are hidden from apps.
const BOOTSTRAP = String.raw`function(config) {
  'use strict';
  const emitHost = globalThis.__phoneEmit;
  delete globalThis.__phoneEmit;
  const socketUrlHost = globalThis.__phoneSocketUrl;
  delete globalThis.__phoneSocketUrl;
  // The official PKJS startup script aliases window to its own JS global.
  // This remains the isolated QuickJS global; no browser window/DOM is exposed.
  globalThis.window = globalThis;
  const stringify = JSON.stringify, parse = JSON.parse, keys = Object.keys;
  const NativeDate = Date;
  const limits = config.limits, appId = config.appId;
  let now = config.nowMs, connected = false, nextTimer = 1, nextWatch = 1, nextTransaction = 1;
  let coordinates = config.coordinates, ready = false, nextConfiguration = 1, activeConfiguration = null;
  const startedAt = now, timers = new Map(), watchers = new Map(), listeners = new Map(), pending = new Map();
  const keyMap = Object.create(null), reverseKeys = Object.create(null), stored = Object.create(null);
  const messageKeys = config.messageKeys;
  if (Array.isArray(messageKeys)) {
    let nextKey = 10000;
    const blocks = [], singles = [];
    for (const key of messageKeys) {
      if (typeof key !== 'string') throw new TypeError('Message keys must be strings.');
      if (key.includes(']')) {
        const match = /^([_a-zA-Z][_a-zA-Z0-9]*)\[(\d+)\]$/.exec(key);
        if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) throw new Error('Invalid message key block.');
        blocks.push([match[1],Number(match[2])]);
      } else {
        if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(key)) throw new Error('Invalid message key name.');
        singles.push([key,1]);
      }
    }
    // SDK allocation: reserve array blocks first, then singles in declaration order.
    for (const [key,count] of [...blocks,...singles]) {
      if (Object.hasOwn(keyMap,key) || nextKey + count > 4294967296) throw new Error('Duplicate or overflowing message key.');
      keyMap[key] = nextKey; nextKey += count;
    }
  } else for (const key of keys(messageKeys)) keyMap[key] = messageKeys[key];
  for (const key of keys(keyMap)) reverseKeys[String(keyMap[key])] = key;
  function emit(event) { event.timestamp = now; return emitHost(stringify(event)); }
  function byteLength(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i+1) >= 0xdc00 && value.charCodeAt(i+1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }
  function storageSize() { let size = 0; for (const key of keys(stored)) size += byteLength(key) + byteLength(stored[key]); return size; }
  for (const key of keys(config.storage)) stored[key] = String(config.storage[key]);
  if (storageSize() > limits.storageBytes) throw new Error('localStorage limit exceeded.');
  const storageMethods = {
    getItem(key) { key = String(key); return Object.hasOwn(stored, key) ? stored[key] : null; },
    setItem(key, value) {
      key = String(key); value = String(value);
      const old = Object.hasOwn(stored,key) ? byteLength(key) + byteLength(stored[key]) : 0;
      if (storageSize() - old + byteLength(key) + byteLength(value) > limits.storageBytes) throw new Error('localStorage limit exceeded.');
      stored[key] = value; emit({type: 'storage', key, value});
    },
    removeItem(key) { key = String(key); delete stored[key]; emit({type: 'storage', key, value: null}); },
    clear() { for (const key of keys(stored)) delete stored[key]; emit({type: 'storage', key: null, value: null}); },
    key(index) { return keys(stored)[Number(index)] ?? null; },
  };
  globalThis.localStorage = new Proxy(Object.create(null), {
    get(_target, key) { if (key === 'length') return keys(stored).length;
      if (Object.hasOwn(storageMethods,key)) return storageMethods[key]; return stored[key]; },
    set(_target, key, value) { storageMethods.setItem(key,value); return true; },
    deleteProperty(_target,key) { storageMethods.removeItem(key); return true; },
    ownKeys() { return keys(stored); },
    getOwnPropertyDescriptor(_target,key) { if (Object.hasOwn(stored,key)) return {value:stored[key],writable:true,enumerable:true,configurable:true}; },
    defineProperty() { return false; },
  });
  function VirtualDate(...args) {
    if (!new.target) return new NativeDate(now).toString();
    return Reflect.construct(NativeDate, args.length ? args : [now], new.target);
  }
  VirtualDate.prototype = NativeDate.prototype;
  Object.defineProperty(VirtualDate.prototype, 'constructor', {value:VirtualDate,writable:true,configurable:true});
  VirtualDate.now = () => now; VirtualDate.parse = NativeDate.parse; VirtualDate.UTC = NativeDate.UTC;
  globalThis.Date = VirtualDate;
  globalThis.performance = Object.freeze({now: () => now - startedAt});
  if(config.randomSeed!==undefined) {
    let state=config.randomSeed>>>0;
    Math.random=()=>{state=(state+0x6d2b79f5)>>>0;let n=Math.imul(state^(state>>>15),state|1);n^=n+Math.imul(n^(n>>>7),n|61);return ((n^(n>>>14))>>>0)/4294967296;};
  }
  function schedule(callback, delay, repeat, args) {
    if (typeof callback !== 'function' && typeof callback !== 'string') throw new TypeError('Timer requires a callback.');
    if (timers.size >= limits.timers) throw new Error('Timer limit exceeded.');
    delay = Number(delay) || 0; delay = Math.max(repeat ? 1 : 0, Math.min(2147483647, delay));
    const id = nextTimer++; timers.set(id, {callback, due:now+delay, delay, repeat, args}); return id;
  }
  globalThis.setTimeout = (fn,delay,...args) => schedule(fn,delay,false,args);
  globalThis.setInterval = (fn,delay,...args) => schedule(fn,delay,true,args);
  globalThis.clearTimeout = globalThis.clearInterval = id => {timers.delete(Number(id));};
  function timer(target) {
    if (target < now) throw new Error('Virtual time cannot move backwards.');
    let chosen = null, chosenId = 0;
    for (const [id,item] of timers) if (item.due <= target && (!chosen || item.due < chosen.due || (item.due === chosen.due && id < chosenId))) {chosen=item;chosenId=id;}
    if (!chosen) {now=target; return false;}
    now = chosen.due;
    if (chosen.repeat) chosen.due += chosen.delay; else timers.delete(chosenId);
    if (typeof chosen.callback === 'string') (0,eval)(chosen.callback); else chosen.callback(...chosen.args);
    return true;
  }
  const network = (${NETWORK_BOOTSTRAP})({emit, schedule, cancelTimer:id=>timers.delete(id), byteLength, limits, mode:config.network.mode, fixtures:config.network.fixtures});
  const sockets = (${WEBSOCKET_BOOTSTRAP})({emit,schedule,cancelTimer:id=>timers.delete(id),byteLength,limits,mode:config.network.mode,normalizeUrl:value=>parse(socketUrlHost(value))});
  function locationValue() { return {coords:{...coordinates},timestamp:now}; }
  let locationError=null;
  function locationResult(success,error) {if(locationError){if(typeof error==='function')error({...locationError,PERMISSION_DENIED:1,POSITION_UNAVAILABLE:2,TIMEOUT:3});}else success(locationValue());}
  globalThis.navigator = Object.freeze({language:config.language,languages:Object.freeze([config.language]),geolocation:Object.freeze({
    getCurrentPosition(success,error,_options) { if (typeof success !== 'function') throw new TypeError('Geolocation success callback is required.'); schedule(() => locationResult(success,error),0,false,[]); },
    watchPosition(success,error,_options) { if (typeof success !== 'function') throw new TypeError('Geolocation success callback is required.');
      if (watchers.size >= limits.timers) throw new Error('Geolocation watcher limit exceeded.');
      const id = nextWatch++; watchers.set(id,{success,error}); schedule(() => {if(watchers.has(id))locationResult(success,error);},0,false,[]); return id; },
    clearWatch(id) { watchers.delete(Number(id)); },
  })});
  function log(level,args) {
    const text = args.map(value => {try {return typeof value === 'string' ? value : stringify(value) ?? String(value);} catch {return String(value);}}).join(' ').slice(0,4096);
    emit({type:'log',level,text});
  }
  globalThis.console = Object.freeze({log:(...a)=>log('log',a),info:(...a)=>log('info',a),warn:(...a)=>log('warn',a),error:(...a)=>log('error',a),debug:(...a)=>log('debug',a)});
  function dispatch(type,event) { event.type = type; for (const callback of [...(listeners.get(type) ?? [])]) callback(event); }
  function dictionary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('AppMessage requires a dictionary.');
    const result = Object.create(null);
    for (const key of keys(value)) {
      const numeric = /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : keyMap[key];
      if (numeric === undefined) continue;
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 4294967295) throw new Error('Invalid AppMessage key.');
      let item = value[key];
      if (typeof item === 'number') {if (!Number.isFinite(item)) throw new TypeError('Non-finite AppMessage number.'); item = item | 0;}
      else if (Array.isArray(item)) {if (!item.every(x=>Number.isInteger(x)&&x>=0&&x<=255)) throw new TypeError('AppMessage byte array must contain bytes.'); item=[...item];}
      else if (typeof item !== 'string' && typeof item !== 'boolean') throw new TypeError('Unsupported AppMessage value.');
      result[String(numeric)] = item;
    }
    if (keys(result).length > 255 || byteLength(stringify(result)) > limits.eventBytes - 256) throw new Error('AppMessage size limit exceeded.');
    return result;
  }
  function settle(id,accepted,code) {
    const item = pending.get(id); if (!item) return false;
    pending.delete(id); timers.delete(item.timeout);
    schedule(() => {const fn = accepted ? item.success : item.failure;
      if (typeof fn === 'function') fn(accepted ? {data:{transactionId:id}} : {data:{transactionId:id},error:{code:code,message:code},message:code});
    },0,false,[]);
    return true;
  }
  const pebble = globalThis.Pebble = Object.freeze({
    addEventListener(type,callback) { if(typeof callback !== 'function') throw new TypeError('Event listener must be a function.');
      type=String(type); if (!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(callback); return true; },
    removeEventListener(type,callback) {return listeners.get(String(type))?.delete(callback) ?? false;},
    on(type,callback) {return pebble.addEventListener(type,callback);},
    off(type,callback) {return pebble.removeEventListener(type,callback);},
    sendAppMessage(value,success,failure) {
      const payload = dictionary(value);
      if (pending.size >= limits.pendingMessages) throw new Error('Pending AppMessage limit exceeded.');
      while (pending.has(nextTransaction)) nextTransaction = nextTransaction % 255 + 1;
      const id = nextTransaction; nextTransaction = nextTransaction % 255 + 1;
      const item = {success,failure,timeout:0}; pending.set(id,item);
      item.timeout = schedule(() => settle(id,false,'TIMEOUT'),limits.messageTimeoutMs,false,[]);
      const captured = emit({type:'outbound',transactionId:id,appId,payload});
      if (!captured) settle(id,false,'OUTPUT_LIMIT');
      else if (!connected) settle(id,false,'NOT_CONNECTED');
      return id;
    },
    getActiveWatchInfo() {return config.watchInfo === null ? null : parse(stringify(config.watchInfo));},
    getAppInfo() {return parse(stringify(config.appInfo));},
    getWatchToken() {return config.watchToken;},
    getAccountToken() {return config.accountToken;},
    openURL(url) {
      url=String(url);
      if (!/^(https?:\/\/|data:text\/html(?:[;,]))/i.test(url)) throw new TypeError('Configuration requires HTTP(S) or an HTML data URL.');
      if (byteLength(url)>limits.configurationBytes) throw new Error('Configuration URL limit exceeded.');
      const requestId=nextConfiguration++;
      if(!emit({type:'configuration',requestId,url}))throw new Error('Configuration output limit exceeded.');
      activeConfiguration=requestId; return url;
    },
  });
  // A small CommonJS hook matches the SDK's generated message_keys module.
  // It never loads code, files, packages, or modules from the host.
  globalThis.require = name => {if(name === 'message_keys') return {...keyMap}; throw new Error('Module is unavailable: '+String(name));};
  return Object.freeze({
    ready() {if (!ready) {ready=true; dispatch('ready',{});}},
    timer,
    location(json) {coordinates=parse(json);locationError=null; for (const [id,callbacks] of watchers) schedule(()=>{if(watchers.has(id))locationResult(callbacks.success,callbacks.error);},0,false,[]);},
    locationError(code,message) {locationError={code,message};for(const [id,callbacks] of watchers)schedule(()=>{if(watchers.has(id))locationResult(callbacks.success,callbacks.error);},0,false,[]);},
    appmessage(json) {const incoming=parse(json), payload=Object.create(null); for(const key of keys(incoming)) payload[reverseKeys[key] ?? key]=incoming[key]; dispatch('appmessage',{payload});},
    configuration() {dispatch('showConfiguration',{});},
    configurationClosed(response,requestId) {if(activeConfiguration===null || (requestId!==null && requestId!==activeConfiguration))return false; activeConfiguration=null;dispatch('webviewclosed',{response});return true;},
    websocketEvent(id,json) {return sockets.receive(id,parse(json));},
    networkResponse(id,json) {return network.respond(id,json);},
    connection(value) {connected=!!value; if (!connected) for(const id of [...pending.keys()]) settle(id,false,'NOT_CONNECTED');},
    ack(id,accepted) {const result=settle(id,!!accepted,accepted?'ACK':'NACK'); return result;},
    storage() {return stringify(stored);},
  });
}`;
