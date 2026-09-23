/**
 * Host glue for the libpebble3 phone: upstream's companion-app library compiled for
 * the browser (tools/phone-spike). It runs beside the emulated watch as a separate
 * phone profile from the built-in virtual phone, and nothing is shared between them.
 *
 * The page supplies the libraries the Kotlin build expects on `globalThis` (the
 * official SQLite WebAssembly build and fflate), then this module starts the phone
 * and carries raw serial bytes between it and the QEMU worker's Pebble Protocol
 * UART over a MessagePort (the worker's `phone-link` command). Bytes are never
 * interpreted or answered here: every protocol response comes from the firmware or
 * from libpebble3.
 */

import type { LibPebbleNetworkHost } from './libpebble-network.ts';
import type { PkjsHost } from './libpebble-pkjs.ts';

/** The functions `browser/BrowserPhone.kt` exports. */
export interface LibPebbleModule {
  phoneStart(): string;
  phoneAttachSerial(sink: ((bytes: Uint8Array) => void) | null): void;
  phoneSerialFromWatch(bytes: Uint8Array): boolean;
  phoneConnectWatch(): string;
  phoneInstall(bytes: Uint8Array, fileName: string): Promise<string>;
  phoneRunningApp(): string;
  phoneRequestConfiguration(): Promise<string>;
  phoneConfigurationClosed(url: string): string;
  phoneStatus(): string;
}

export interface LibPebbleDependencies {
  /** The initialized `@sqlite.org/sqlite-wasm` module. */
  sqlite3: unknown;
  /** fflate's module namespace; the phone inflates app bundles with `inflateSync`. */
  fflate: { inflateSync: unknown };
  /** Engines for apps' PebbleKit JS (`quickJsPkjsHost` in libpebble-pkjs.ts). */
  pkjs: PkjsHost;
  /** Requests and WebSockets for apps' PebbleKit JS (`libPebbleNetworkHost`). */
  network: LibPebbleNetworkHost;
}

/** The part of a MessagePort the link uses, so Node's worker ports work as well. */
export interface SerialPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: any }) => void) | null;
  close(): void;
}

export interface LinkCounters {
  /** Bytes the phone wrote to the watch. */
  toWatch: number;
  /** Bytes the watch wrote that the phone read. */
  fromWatch: number;
  /** Bytes the watch wrote while no phone connection was reading them. */
  dropped: number;
}

/**
 * Publishes the libraries the Kotlin build reads from `globalThis`. They must be in
 * place before the module is imported: the Wasm instance links to them at startup.
 */
export function provideLibPebbleDependencies(dependencies: LibPebbleDependencies): void {
  if (!dependencies.sqlite3) throw new Error('libpebble3 needs the SQLite WebAssembly build.');
  if (typeof dependencies.fflate?.inflateSync !== 'function')
    throw new Error('libpebble3 needs fflate for app bundles.');
  if (typeof dependencies.pkjs?.create !== 'function')
    throw new Error('libpebble3 needs an engine host for PebbleKit JS.');
  if (typeof dependencies.network?.request !== 'function')
    throw new Error('libpebble3 needs a network host for PebbleKit JS.');
  const scope = globalThis as Record<string, unknown>;
  scope['sqlite3'] = dependencies.sqlite3;
  scope['fflate'] = dependencies.fflate;
  scope['pebblePhoneHost'] = { pkjs: dependencies.pkjs, network: dependencies.network };
}

/** Checks that a loaded module is the libpebble3 build this glue was written for. */
export function asLibPebbleModule(module: Record<string, unknown>): LibPebbleModule {
  const missing = [
    'phoneStart',
    'phoneAttachSerial',
    'phoneSerialFromWatch',
    'phoneConnectWatch',
    'phoneInstall',
    'phoneRunningApp',
    'phoneRequestConfiguration',
    'phoneConfigurationClosed',
    'phoneStatus',
  ].filter((name) => typeof module[name] !== 'function');
  if (missing.length)
    throw new Error(`Not a libpebble3 phone build; missing ${missing.join(', ')}.`);
  return module as unknown as LibPebbleModule;
}

/**
 * One phone linked to one watch. `start` starts the phone once; `connect` attaches
 * the serial link and asks libpebble3's watch manager to connect, as a phone does
 * when it finds a watch. `close` detaches the link, which libpebble3 sees as a
 * disconnection.
 */
export class LibPebbleLink {
  readonly counters: LinkCounters = { toWatch: 0, fromWatch: 0, dropped: 0 };
  private port: SerialPort | undefined;
  private started = false;
  private readonly phone: LibPebbleModule;

  constructor(phone: LibPebbleModule) {
    this.phone = phone;
  }

  start(): void {
    if (this.started) return;
    const failure = this.phone.phoneStart();
    if (failure) throw new Error(`libpebble3 did not start: ${failure}`);
    this.started = true;
  }

  connect(port: SerialPort): void {
    if (!this.started) throw new Error('Start the phone before connecting it.');
    if (this.port) throw new Error('The phone is already linked to a watch.');
    this.port = port;
    port.onmessage = ({ data }) => {
      if (this.port !== port || data?.type !== 'serial' || !(data.bytes instanceof Uint8Array))
        return;
      if (this.phone.phoneSerialFromWatch(data.bytes)) this.counters.fromWatch += data.bytes.length;
      else this.counters.dropped += data.bytes.length;
    };
    this.phone.phoneAttachSerial((bytes) => {
      if (this.port !== port) return;
      this.counters.toWatch += bytes.length;
      port.postMessage({ type: 'serial', bytes }, [bytes.buffer as ArrayBuffer]);
    });
    const failure = this.phone.phoneConnectWatch();
    if (failure) {
      this.close();
      throw new Error(`libpebble3 could not connect: ${failure}`);
    }
  }

  /**
   * Sideloads an app bundle through libpebble3, which adds it to the locker, sends it
   * to the connected watch and launches it, as the phone app's own sideload does.
   */
  async install(bytes: Uint8Array, fileName: string): Promise<void> {
    if (!this.port) throw new Error('Connect the phone to a watch before installing.');
    const failure = await this.phone.phoneInstall(bytes, fileName);
    if (failure) throw new Error(`libpebble3 did not install ${fileName}: ${failure}`);
  }

  /** The UUID of the app the watch reports running, or '' before it reports one. */
  runningApp(): string {
    return this.phone.phoneRunningApp();
  }

  /**
   * Asks the running app's PebbleKit JS for its configuration page, as the phone app's
   * settings button does. Resolves to the URL the app opens.
   */
  async requestConfiguration(): Promise<string> {
    const url = await this.phone.phoneRequestConfiguration();
    if (!url) throw new Error('The running app has no configuration page.');
    return url;
  }

  /** Delivers a configuration page's `pebblejs://close#…` URL to the app's PebbleKit JS. */
  configurationClosed(url: string): void {
    const failure = this.phone.phoneConfigurationClosed(url);
    if (failure) throw new Error(failure);
  }

  /** libpebble3's own description of its watches and their connection state. */
  status(): string {
    return this.phone.phoneStatus();
  }

  close(): void {
    const port = this.port;
    if (!port) return;
    this.port = undefined;
    this.phone.phoneAttachSerial(null);
    port.onmessage = null;
    port.close();
  }
}
