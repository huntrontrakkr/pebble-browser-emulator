import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  OnInit,
  OnDestroy,
  isDevMode,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  resourceSettings,
  saveResourceSettings,
  normalizeResourceSettings,
} from './resource-fetch.ts';
import { clearResourceCache } from './resource-cache.ts';
import { STARTUP_SETTINGS_KEY, startupCheckpointsEnabled } from './startup-checkpoint.ts';
type OfflineStatus = {
  version: string;
  bytes: number;
  profiles: Record<string, { ready: boolean; bytes: number }>;
};
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

@Component({
  selector: 'app-preferences',
  imports: [FormsModule],
  template: `
    <button class="preferences-trigger" (click)="open()" aria-haspopup="dialog">Preferences</button>
    @if (updateReady() && !deferred()) {
      <aside class="pwa-update" aria-label="Application update">
        <span
          >A new version is ready.{{
            otherTabs() ? ' Your other emulator tabs reload too.' : ''
          }}</span
        >
        <button (click)="applyUpdate()" [disabled]="downloading()">
          {{ otherTabs() ? 'Reload all tabs' : 'Reload' }}</button
        ><button class="text-button" (click)="deferred.set(true)">Later</button>
      </aside>
    }
    <dialog #dialog class="preferences-dialog" aria-labelledby="preferences-title">
      <header class="settings-header">
        <h2 id="preferences-title">Preferences</h2>
        <button (click)="dialog.close()" aria-label="Close preferences">Done</button>
      </header>
      <div class="preferences-content">
        <section>
          <h3>Appearance</h3>
          <label
            >Theme<select
              aria-label="Theme"
              [ngModel]="theme"
              (ngModelChange)="themeChanged.emit($event)"
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select></label
          >
        </section>
        <section>
          <h3>Install on this device</h3>
          @if (installPrompt()) {
            <button class="primary" (click)="install()">Install app</button>
          } @else {
            <p class="help">
              {{
                installed()
                  ? 'Installed on this device.'
                  : 'Use your browser’s Install app or Add to Home Screen option when available.'
              }}
            </p>
          }
        </section>
        <section>
          <h3>Offline access</h3>
          <p class="help">
            Save the selected watch and Clock example, including phone configuration.
          </p>
          <label
            >Offline watch<select
              aria-label="Offline watch"
              [(ngModel)]="offlineProfile"
              [disabled]="downloading()"
            >
              <option value="qemu_emery">Pebble Time 2</option>
              <option value="qemu_flint">Pebble 2 Duo</option>
              <option value="qemu_gabbro">Pebble Round 2</option>
            </select></label
          >
          @if (offlineStatus(); as state) {
            <p class="offline-state">
              {{ state.profiles[offlineProfile].ready ? 'Ready offline' : 'Not fully downloaded' }}
              · {{ megabytes(state.profiles[offlineProfile].bytes) }} MB
            </p>
            <div class="actions">
              <button
                class="primary"
                (click)="download()"
                [disabled]="downloading() || !online() || state.profiles[offlineProfile].ready"
              >
                Download for offline use
              </button>
              @if (downloading()) {
                <button (click)="cancelDownload()">Cancel download</button>
              }
            </div>
            @if (downloading()) {
              <progress
                max="100"
                [value]="progress()"
                aria-label="Offline download progress"
              ></progress>
              <p class="help" role="status">Downloading · {{ progress() }}%</p>
            }
            <p class="help">{{ megabytes(state.bytes) }} MB of app downloads stored.</p>
            <button class="text-button" (click)="clearDownloads()" [disabled]="downloading()">
              Remove offline downloads
            </button>
          } @else {
            <p class="help">{{ offlineNotice() }}</p>
          }
          @if (!online()) {
            <p class="help">You’re offline. Downloaded watches are still available.</p>
          }
          <p class="help">
            Your last watchface is saved on this device. GitHub imports, 3D models and online
            services need a connection.
          </p>
        </section>
        <section>
          <h3>Download service</h3>
          <p class="help">
            Optional assistance for public downloads blocked by the source website. The watch and
            phone run on this device.
          </p>
          <label class="check"
            ><input
              type="checkbox"
              [(ngModel)]="serviceEnabled"
              (ngModelChange)="serviceChanged()"
            />Use a download service</label
          >
          <label
            >Service URL<input
              [(ngModel)]="serviceEndpoint"
              (change)="serviceChanged()"
              placeholder="https://downloads.example.com"
              type="url"
          /></label>
          <p class="help">
            Direct downloads are tried first. An enabled service receives the public download URLs
            it handles.
          </p>
          <label
            >Relay key (optional)<input
              [(ngModel)]="serviceRelayKey"
              (change)="serviceChanged()"
              placeholder="Leave empty for downloads only"
              type="password"
              autocomplete="off"
          /></label>
          <p class="help">
            A watchface's phone script can only reach sites that permit browser requests. With a
            relay key, requests the browser refuses are retried through the service above. Without
            one they simply fail, and nothing is sent anywhere. The key authorizes the relay; it is
            not a password, and a hosted copy may supply its own.
          </p>
          <div class="actions">
            <button
              (click)="checkService()"
              [disabled]="checkingService() || !serviceEndpoint.trim()"
            >
              Test connection</button
            ><button (click)="removeResources()">Clear cached downloads</button>
          </div>
          @if (serviceNotice()) {
            <p class="help" role="status">{{ serviceNotice() }}</p>
          }
        </section>
        <section>
          <h3>Watch startup</h3>
          <label class="check"
            ><input
              type="checkbox"
              [(ngModel)]="fastStartup"
              (ngModelChange)="startupChanged()"
            />Use prepared startup state</label
          >
          <p class="help">
            Resume a matching firmware checkpoint before loading your watchface. Turn off to test a
            complete boot. Applies to the next preview session.
          </p>
        </section>
        @if (updateReady()) {
          <section>
            <h3>Application update</h3>
            <p class="help">
              Updating reloads every open emulator tab and restarts the watch. Saved app settings,
              firmware and offline downloads are kept. It also happens by itself the next time you
              open the app.
            </p>
            <button (click)="applyUpdate()" [disabled]="downloading()">Reload &amp; update</button>
          </section>
        }
        @if (message()) {
          <p class="preferences-message" role="status">{{ message() }}</p>
        }
      </div>
    </dialog>
  `,
})
export class PreferencesPanel implements OnInit, OnDestroy {
  @Input() theme = 'light';
  @Input() profile = 'qemu_emery';
  @Output() themeChanged = new EventEmitter<string>();
  @ViewChild('dialog') dialog!: ElementRef<HTMLDialogElement>;
  installPrompt = signal<InstallEvent | null>(null);
  installed = signal(false);
  online = signal(navigator.onLine);
  updateReady = signal(false);
  deferred = signal(false);
  /** Other open emulator tabs that an update would also reload. */
  otherTabs = signal(0);
  offlineStatus = signal<OfflineStatus | null>(null);
  offlineNotice = signal('Preparing offline support…');
  downloading = signal(false);
  progress = signal(0);
  message = signal('');
  offlineProfile = 'qemu_emery';
  serviceEnabled = resourceSettings().enabled;
  fastStartup = startupCheckpointsEnabled();
  startupChanged() {
    try {
      localStorage.setItem(STARTUP_SETTINGS_KEY, this.fastStartup ? 'enabled' : 'disabled');
    } catch {
      this.message.set('This browser could not save the startup preference.');
    }
  }
  serviceEndpoint = resourceSettings().endpoint;
  serviceRelayKey = resourceSettings().relayKey;
  serviceNotice = signal('');
  checkingService = signal(false);
  serviceChanged() {
    try {
      saveResourceSettings({
        enabled: this.serviceEnabled,
        endpoint: this.serviceEndpoint,
        relayKey: this.serviceRelayKey,
      });
      this.serviceNotice.set(
        this.serviceEnabled
          ? 'Service enabled for supported public downloads.'
          : 'Service disabled. Direct downloads and local files remain available.',
      );
    } catch (error) {
      this.serviceNotice.set(String((error as Error).message));
    }
  }
  async checkService() {
    this.checkingService.set(true);
    try {
      const settings = normalizeResourceSettings({
        enabled: true,
        endpoint: this.serviceEndpoint,
        relayKey: this.serviceRelayKey,
      });
      const response = await fetch(settings.endpoint + '/v1/status', {
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (!response.ok || data.protocol !== 'pebble-resources-v1')
        throw new Error('The endpoint is not a compatible download service.');
      this.serviceNotice.set('Download service is reachable.');
    } catch (error) {
      this.serviceNotice.set('Connection failed: ' + String((error as Error).message));
    } finally {
      this.checkingService.set(false);
    }
  }
  async removeResources() {
    try {
      await clearResourceCache();
      this.serviceNotice.set(
        'Cached public downloads removed. Saved firmware, watchface and settings are kept.',
      );
    } catch {
      this.serviceNotice.set('Cached downloads could not be cleared.');
    }
  }
  private registration?: ServiceWorkerRegistration;
  private downloadId?: string;
  private reloadForUpdate = false;
  /** Whether this page was already served by a worker when it loaded. */
  private hadController = !!navigator.serviceWorker?.controller;
  private lastCheck = 0;
  private destroyed = false;
  private cleanup: (() => void)[] = [];
  private network = () => this.online.set(navigator.onLine);
  private prompt = (event: Event) => {
    event.preventDefault();
    this.installPrompt.set(event as InstallEvent);
  };
  private didInstall = () => {
    this.installed.set(true);
    this.installPrompt.set(null);
  };
  // A new version took over, from this tab or another. The cache now holds
  // only the new build, so this page reloads rather than keep running old code
  // that could fetch mismatched files. A first install is not an update.
  private controller = () => {
    if (this.reloadForUpdate || this.hadController) location.reload();
    else void this.refresh();
  };
  // Looks for a new deployment when the tab comes back into view or back
  // online, and on a timer, not only at page load. At most every five minutes.
  private checkForUpdate = () => {
    if (document.visibilityState !== 'visible') return;
    // Tabs may have opened or closed while this one was in the background.
    if (this.updateReady()) void this.countTabs();
    if (!navigator.onLine) return;
    if (Date.now() - this.lastCheck < 5 * 60_000) return;
    this.lastCheck = Date.now();
    void this.registration?.update().catch(() => {});
  };
  async ngOnInit() {
    this.installed.set(matchMedia('(display-mode: standalone)').matches);
    addEventListener('beforeinstallprompt', this.prompt);
    addEventListener('appinstalled', this.didInstall);
    addEventListener('online', this.network);
    addEventListener('offline', this.network);
    if (!('serviceWorker' in navigator) || !isSecureContext || isDevMode()) {
      this.offlineNotice.set(
        isDevMode()
          ? 'Offline downloads are available in the published app.'
          : 'Offline installation is unavailable in this browser.',
      );
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', this.controller);
    try {
      const registration = await navigator.serviceWorker.register(
        new URL('sw.js', document.baseURI),
        { updateViaCache: 'none' },
      );
      if (this.destroyed) return;
      this.registration = registration;
      const inspect = () => {
        if (this.destroyed) return;
        this.updateReady.set(!!registration.waiting && !!navigator.serviceWorker.controller);
        void this.countTabs();
        if (registration.active?.state === 'activated') void this.refresh();
      };
      const watch = () => {
        const worker = registration.installing;
        if (worker) {
          const changed = () => {
            inspect();
            if (worker.state === 'redundant' && !registration.active)
              this.offlineNotice.set(
                'Offline support could not start. Try reopening the app online.',
              );
          };
          worker.addEventListener('statechange', changed);
          this.cleanup.push(() => worker.removeEventListener('statechange', changed));
        }
        inspect();
      };
      registration.addEventListener('updatefound', watch);
      this.cleanup.push(() => registration.removeEventListener('updatefound', watch));
      watch();
      this.lastCheck = Date.now();
      await registration.update().catch(() => {});
      document.addEventListener('visibilitychange', this.checkForUpdate);
      addEventListener('online', this.checkForUpdate);
      const timer = setInterval(this.checkForUpdate, 30 * 60_000);
      this.cleanup.push(() => {
        document.removeEventListener('visibilitychange', this.checkForUpdate);
        removeEventListener('online', this.checkForUpdate);
        clearInterval(timer);
      });
    } catch {
      this.offlineNotice.set('Offline support could not start. Try reopening the app online.');
    }
  }
  open() {
    if (!this.downloading())
      this.offlineProfile = this.profile.startsWith('qemu_') ? this.profile : 'qemu_emery';
    this.dialog.nativeElement.showModal();
    void this.refresh();
  }
  megabytes(bytes: number) {
    return (bytes / 1000000).toFixed(1);
  }
  private request(
    type: string,
    data: object = {},
    worker = this.registration?.active,
    progress?: (value: number) => void,
  ): Promise<any> {
    if (!worker) return Promise.reject(new Error('Offline support is still starting.'));
    const id = type === 'CACHE_PROFILE' ? this.downloadId! : crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          worker.postMessage({ type: 'CANCEL_CACHE', id });
          channel.port1.close();
          reject(new Error('The download stopped responding. Please try again.'));
        }, 120000);
      };
      arm();
      channel.port1.onmessage = ({ data }) => {
        arm();
        if (typeof data.progress === 'number') progress?.(data.progress);
        if (data.done) {
          clearTimeout(timeout);
          channel.port1.close();
          data.error ? reject(new Error(data.error)) : resolve(data.value);
        }
      };
      try {
        worker.postMessage({ type, id, ...data }, [channel.port2]);
      } catch (error) {
        clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        reject(error);
      }
    });
  }
  async refresh() {
    if (!this.registration?.active) return;
    this.updateReady.set(!!this.registration.waiting && !!navigator.serviceWorker.controller);
    try {
      this.offlineStatus.set(await this.request('STATUS'));
    } catch {
      this.offlineNotice.set('Offline status is unavailable. Try reopening Preferences.');
    }
  }
  async download() {
    if (this.downloading()) return;
    this.downloading.set(true);
    this.message.set('');
    this.progress.set(0);
    this.downloadId = crypto.randomUUID();
    try {
      this.offlineStatus.set(
        await this.request('CACHE_PROFILE', { profile: this.offlineProfile }, undefined, (value) =>
          this.progress.set(value),
        ),
      );
      this.message.set('This watch and its example are ready offline.');
    } catch (error) {
      this.message.set(String((error as Error).message));
    } finally {
      this.downloading.set(false);
      this.downloadId = undefined;
    }
  }
  cancelDownload() {
    if (this.downloadId)
      this.registration?.active?.postMessage({ type: 'CANCEL_CACHE', id: this.downloadId });
  }
  async clearDownloads() {
    try {
      this.offlineStatus.set(await this.request('CLEAR_DOWNLOADS'));
      this.message.set(
        'App downloads removed. Saved firmware, watchfaces and app settings are kept.',
      );
    } catch (error) {
      this.message.set(String((error as Error).message));
    }
  }
  async install() {
    const prompt = this.installPrompt();
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      this.message.set(
        'Installation was not completed. Use your browser’s Install app option to try again.',
      );
    } finally {
      this.installPrompt.set(null);
    }
  }
  private async countTabs() {
    const waiting = this.registration?.waiting;
    if (!waiting || !navigator.serviceWorker.controller) return;
    try {
      this.otherTabs.set(Math.max(0, (await this.request('TABS', {}, waiting)) - 1));
    } catch {
      this.otherTabs.set(0);
    }
  }
  async applyUpdate() {
    const waiting = this.registration?.waiting;
    if (!waiting) return;
    this.reloadForUpdate = true;
    try {
      await this.request('APPLY_UPDATE', {}, waiting);
    } catch (error) {
      this.reloadForUpdate = false;
      this.message.set(String((error as Error).message));
    }
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.cancelDownload();
    for (const cleanup of this.cleanup) cleanup();
    removeEventListener('beforeinstallprompt', this.prompt);
    removeEventListener('appinstalled', this.didInstall);
    removeEventListener('online', this.network);
    removeEventListener('offline', this.network);
    navigator.serviceWorker?.removeEventListener('controllerchange', this.controller);
  }
}
