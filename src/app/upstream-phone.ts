import { signal } from '@angular/core';
import type { PhoneNetworkSetting } from './libpebble-network.ts';

/**
 * Preview's experimental second phone: upstream's companion-app library (libpebble3),
 * run by libpebble.worker.ts, as the phone of the emulated QEMU watch. It is separate
 * from the built-in virtual phone and replaces it on the watch link while connected;
 * the two never share the watch.
 *
 * The libpebble3 build is optional in a build of this site. `libpebble3/manifest.json`
 * says whether it is present and which upstream release it is; without it the option
 * reports itself unavailable.
 */
export interface UpstreamPhoneManifest {
  /** The upstream repository and release tag the library was built from. */
  upstream: string;
  tag: string;
  bundle: string;
  sqlite: string;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class UpstreamPhone {
  readonly manifest = signal<UpstreamPhoneManifest | null>(null);
  readonly status = signal('Checking this build…');
  readonly connected = signal(false);
  readonly busy = signal(false);
  readonly runningApp = signal('');

  private worker?: Worker;
  private started?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private linkWaiter?: Pending;
  private readonly log: (text: string) => void;

  constructor(log: (text: string) => void) {
    this.log = log;
  }

  /** Reads the build's manifest; the option is unavailable without one. */
  async detect(): Promise<void> {
    try {
      const response = await fetch(new URL('libpebble3/manifest.json', document.baseURI));
      if (!response.ok) throw new Error(String(response.status));
      // Every build publishes this file; one without the phone says `included: false`.
      const manifest = (await response.json()) as UpstreamPhoneManifest & { included?: boolean };
      if (manifest.included === false) throw new Error('not included');
      if (typeof manifest.bundle !== 'string' || typeof manifest.sqlite !== 'string')
        throw new Error('incomplete manifest');
      this.manifest.set(manifest);
      this.status.set('Not connected');
    } catch {
      this.manifest.set(null);
      this.status.set('Not included in this build');
    }
  }

  /**
   * Connects the upstream phone to the QEMU watch: starts the phone worker if needed and
   * hands it the QEMU worker's `phone-link` port. The built-in phone must already be
   * off the link; the QEMU worker refuses the link otherwise. Apps' PebbleKit JS gets
   * the session's phone network setting, as the built-in phone's scripts do.
   */
  async connect(qemu: Worker, network: PhoneNetworkSetting): Promise<void> {
    const manifest = this.manifest();
    if (!manifest) throw new Error('This build does not include the upstream phone.');
    await this.run('Starting the upstream phone…', async () => {
      await this.start(manifest);
      await this.ask({ type: 'network', setting: network });
      const channel = new MessageChannel();
      const attached = new Promise<void>((resolve, reject) => {
        this.linkWaiter = { resolve, reject };
      });
      qemu.postMessage({ type: 'phone-link', port: channel.port2 }, [channel.port2]);
      await attached;
      await this.ask({ type: 'link', port: channel.port1 }, [channel.port1]);
      this.connected.set(true);
      this.status.set('Connected');
    });
  }

  /** Hands the watch link back: the QEMU worker closes it, and libpebble3 sees a disconnection. */
  async disconnect(qemu?: Worker): Promise<void> {
    qemu?.postMessage({ type: 'phone-link', port: null });
    this.linkClosed();
    if (this.worker) await this.ask({ type: 'unlink' }).catch(() => {});
  }

  /** The QEMU worker's link ended (a new session, or a reset): the phone is disconnected. */
  linkClosed(): void {
    if (!this.connected()) return;
    this.connected.set(false);
    this.runningApp.set('');
    this.status.set('Disconnected');
    // -1: no caller waits on this; 0 is start()'s.
    this.worker?.postMessage({ type: 'unlink', id: -1 });
  }

  /** Messages from the QEMU worker that concern the link. */
  handleQemuMessage(data: any): void {
    if (data?.type === 'phone-link') {
      if (data.attached) this.linkWaiter?.resolve(undefined);
      this.linkWaiter = undefined;
    } else if (data?.type === 'error' && data.command === 'phone-link' && this.linkWaiter) {
      this.linkWaiter.reject(new Error(data.message));
      this.linkWaiter = undefined;
    } else if (data?.type === 'session') this.linkClosed();
  }

  /** Sideloads a bundle through libpebble3, which syncs it to the watch and launches it. */
  install(bytes: Uint8Array, name: string): Promise<void> {
    return this.run(`Installing ${name} through libpebble3…`, async () => {
      await this.ask({ type: 'install', bytes: bytes.slice(), name }, [], 120000);
      this.status.set(`Installed ${name}`);
    });
  }

  /** The running app's configuration page, from its PebbleKit JS. */
  configure(): Promise<string> {
    return this.ask({ type: 'configure' }, [], 40000);
  }

  /**
   * The configuration page closed. `response` is the page's return data as the settings
   * frame decodes it (upstream's own navigation code), which upstream's app passes to
   * the app's PebbleKit JS as it is; null is a cancellation, which upstream does not
   * deliver.
   */
  async configurationClosed(response: string | null): Promise<void> {
    if (response === null || response === '') return;
    await this.ask({ type: 'configuration-closed', url: 'pebblejs://close#' + response });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.started = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error('The phone stopped.'));
    this.pending.clear();
    this.connected.set(false);
  }

  private start(manifest: UpstreamPhoneManifest): Promise<void> {
    if (this.started) return this.started;
    const worker = new Worker(new URL('./libpebble.worker', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = ({ data }) => this.handle(data);
    worker.onerror = (event) => {
      this.status.set(`Phone worker failed: ${event.message}`);
      this.dispose();
    };
    this.started = new Promise<void>((resolve, reject) => {
      this.pending.set(0, { resolve, reject });
      worker.postMessage({
        type: 'init',
        bundleUrl: new URL('libpebble3/' + manifest.bundle, document.baseURI).href,
        sqliteUrl: new URL('libpebble3/' + manifest.sqlite, document.baseURI).href,
        quickjsWasmUrl: new URL('wasm/quickjs.wasm', document.baseURI).href,
      });
    });
    this.started.catch(() => (this.started = undefined));
    return this.started;
  }

  private handle(data: any): void {
    if (data?.type === 'ready') this.settle(0, undefined);
    else if (data?.type === 'done') this.settle(data.id, data.value);
    else if (data?.type === 'failed') this.settle(data.id ?? 0, undefined, data.message);
    else if (data?.type === 'running-app') {
      this.runningApp.set(data.uuid);
      if (data.uuid) this.log(`Watch reports ${data.uuid} running`);
    } else if (data?.type === 'pkjs-console') this.log(`[${data.app}] ${data.text}`);
  }

  private settle(id: number, value: unknown, failure?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (failure === undefined) pending.resolve(value);
    else pending.reject(new Error(failure));
  }

  private ask(message: object, transfer: Transferable[] = [], timeout = 30000): Promise<any> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('The upstream phone is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The upstream phone did not answer in time.'));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  private async run(status: string, work: () => Promise<void>): Promise<void> {
    if (this.busy()) throw new Error('The upstream phone is busy.');
    this.busy.set(true);
    this.status.set(status);
    try {
      await work();
    } catch (error) {
      this.status.set(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.busy.set(false);
    }
  }
}
