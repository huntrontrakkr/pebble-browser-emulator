import {
  Component,
  EventEmitter,
  Input,
  Output,
  OnDestroy,
  AfterViewInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { StoreBrowser } from './store-browser.ts';
import { readLocal, writeLocal } from './local-store.ts';
import { parseRepository, readLimited, type SourceSnapshot } from './projects.ts';
import { FIRMWARE_PROFILES, isFirmwareProfile, type FirmwareProfile } from './watch-profiles.ts';
import {
  parsePreviewLink,
  previewLink,
  repositoryPreview,
  storePreview,
  type PreviewTarget,
  type PreviewPackage,
} from './preview-links.ts';
import {
  firmwareDownload,
  previewFirmwareFiles,
  savedFirmware,
  saveFirmware,
  bundledFirmware,
  type PreviewFirmware,
} from './preview-firmware.ts';

export interface PreviewLaunch {
  profile: FirmwareProfile;
  package: PreviewPackage;
  firmware?: PreviewFirmware;
}
interface SavedWatchface {
  profile: FirmwareProfile;
  name: string;
  bytes: Blob | Uint8Array;
}

@Component({
  selector: 'preview-panel',
  imports: [FormsModule, StoreBrowser],
  template: `
    <div class="section-heading">
      <h2>{{ title() ? loadedLabel() : 'Open' }}</h2>
    </div>
    <details
      class="preview-chooser"
      [open]="expanded()"
      (toggle)="expanded.set($any($event.target).open)"
    >
      <summary [hidden]="!title()">Choose something else</summary>
      <label
        >Watch<select
          aria-label="Watch"
          [ngModel]="profile()"
          (ngModelChange)="changeWatch($event)"
          [disabled]="sessionBusy"
        >
          <option value="qemu_emery">Pebble Time 2</option>
          <option value="qemu_flint">Pebble 2 Duo</option>
          <option value="qemu_gabbro">Pebble Round 2</option>
        </select></label
      >
      <div class="launch-actions">
        <button
          class="primary"
          (click)="showStore.set(!showStore())"
          [disabled]="busy() || sessionBusy"
        >
          Browse watchfaces
        </button>
        <button (click)="example()" [disabled]="busy() || sessionBusy">Try example</button>
        <label class="file-button"
          >Open .pbw<input
            type="file"
            accept=".pbw"
            (change)="openPackage($event)"
            [disabled]="busy() || sessionBusy"
        /></label>
      </div>
      @defer (when showStore()) {
        @if (showStore()) {
          <store-browser
            [profile]="profile()"
            [disabled]="busy() || sessionBusy"
            (selected)="openStore($event)"
            (closed)="showStore.set(false)"
          />
        }
      }
      @if (recent(); as saved) {
        <button class="recent-watchface" (click)="openRecent()" [disabled]="busy() || sessionBusy">
          <span>Open saved</span><strong>{{ saved.name }}</strong>
        </button>
      }
      <details class="repository-disclosure">
        <summary>Open from GitHub</summary>
        <form (ngSubmit)="github()" class="repository-launch">
          <label
            >GitHub project<input
              [(ngModel)]="repo"
              name="repo"
              placeholder="github.com/owner/repository"
              autocomplete="off"
              spellcheck="false"
          /></label>
          <details>
            <summary>Branch, folder or package</summary>
            <label
              >Branch or commit<input [(ngModel)]="ref" name="ref" placeholder="Default branch"
            /></label>
            <label
              >Project folder<input [(ngModel)]="root" name="root" placeholder="Repository root"
            /></label>
            <label
              >PBW path (optional)<input
                [(ngModel)]="pbw"
                name="pbw"
                placeholder="preview/watchface.pbw"
            /></label>
            <label
              >Release tag (optional)<input [(ngModel)]="release" name="release" placeholder="v1.0"
            /></label>
            <label
              >Release attachment<input
                [(ngModel)]="asset"
                name="asset"
                placeholder="watchface.pbw"
            /></label>
          </details>
          <button type="submit" [disabled]="!repo.trim() || busy() || sessionBusy">
            Open project
          </button>
        </form>
      </details>
    </details>
    @if (title()) {
      <div class="preview-selection">
        <strong>{{ title() }}</strong>
        @if (sourceLink()) {
          <a [href]="sourceLink()" target="_blank" rel="noopener noreferrer">{{
            target()?.kind === 'store' ? 'Store details ↗' : 'Source ↗'
          }}</a>
        }
      </div>
    }
    @if (setup()) {
      <section class="firmware-setup" aria-label="Preview watch setup">
        <h2>Open firmware manually</h2>
        <p>The default firmware could not be loaded. You can retry or open these files.</p>
        <button (click)="retryFirmware()" [disabled]="busy()">Retry default firmware</button>
        <ol>
          <li>
            <span>Download both official firmware files.</span>
            <div class="download-pair">
              <a [href]="download('micro')" target="_blank" rel="noopener">Micro flash · 4.37.0</a>
              <a [href]="download('spi')" target="_blank" rel="noopener">SPI flash · 4.37.0</a>
            </div>
          </li>
          <li>
            <label class="file-button"
              >Choose both firmware files<input
                type="file"
                accept=".bin,.elf"
                multiple
                (change)="setupFiles($event)"
                [disabled]="busy()"
            /></label>
          </li>
        </ol>
        <p class="help">Choose both files together. The selection starts automatically.</p>
        <button (click)="tools.emit('Firmware')">Use different firmware</button>
      </section>
    }
    @if (status() || sessionStatus) {
      <p
        class="preview-progress"
        [class.sr-only]="watchLoaded && !busy() && !sessionBusy && !failure() && !setup()"
        role="status"
      >
        {{ busy() || setup() || failure() ? status() : sessionStatus || status() }}
      </p>
    }
    @if (failure()) {
      <p class="error" role="alert">{{ failure() }}</p>
    }
    @if (busy() || setup() || sessionBusy) {
      <button (click)="cancel()">Cancel preview</button>
    }
    @if (target() && !busy()) {
      <div class="preview-sharing">
        <div class="actions">
          <button (click)="copyLink()">Copy preview link</button>
          @if (package()) {
            <button (click)="savePackage()">Download PBW</button>
          }
        </div>
        @if (linkVisible()) {
          <label
            >Preview link<input
              [value]="shareUrl()"
              readonly
              (focus)="$any($event.target).select()"
          /></label>
        }
      </div>
    }
    @if (copyStatus()) {
      <p class="help" role="status">{{ copyStatus() }}</p>
    }
    @if (expanded()) {
      <p class="help preview-note">The example includes everything needed to start.</p>
    }
  `,
})
export class PreviewPanel implements AfterViewInit, OnDestroy {
  @Input() currentProfile = 'diagnostic-v1';
  @Input() watchLoaded = false;
  @Input() sessionBusy = false;
  @Input() sessionStatus = '';
  @Output() launch = new EventEmitter<PreviewLaunch>();
  @Output() source = new EventEmitter<SourceSnapshot>();
  @Output() tools = new EventEmitter<string>();
  @Output() canceled = new EventEmitter<void>();
  @Output() starting = new EventEmitter<void>();
  profile = signal<FirmwareProfile>('qemu_emery');
  repo = '';
  ref = '';
  root = '';
  pbw = '';
  release = '';
  asset = '';
  showStore = signal(false);
  busy = signal(false);
  setup = signal(false);
  status = signal('');
  failure = signal('');
  /** What the watch is running, for labelling. Capability never varies. */
  @Input() installedRole: 'watchface' | 'app' = 'app';
  /** The word for what is loaded: its own kind once the watch reports one. */
  loadedLabel = () => (this.installedRole === 'watchface' ? 'Watchface' : 'App');
  title = signal('');
  target = signal<PreviewTarget | null>(null);
  package = signal<PreviewPackage | null>(null);
  linkVisible = signal(false);
  copyStatus = signal('');
  expanded = signal(true);
  recent = signal<SavedWatchface | null>(null);
  async openRecent() {
    const saved = this.recent();
    if (!saved || this.busy() || this.sessionBusy) return;
    const generation = this.begin();
    this.profile.set(saved.profile);
    this.title.set(saved.name);
    this.target.set(null);
    this.package.set(null);
    history.replaceState(null, '', new URL('.', document.baseURI));
    try {
      const bytes =
        saved.bytes instanceof Blob
          ? new Uint8Array(await saved.bytes.arrayBuffer())
          : saved.bytes.slice();
      if (generation !== this.generation) return;
      this.package.set({ name: saved.name, bytes });
      await this.prepareWatch(generation);
    } catch (error) {
      if (generation === this.generation) this.failure.set(String(error));
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  collapseOnPhone() {
    if (matchMedia('(max-width: 780px)').matches) this.expanded.set(false);
  }
  private controller?: AbortController;
  private generation = 0;
  private route = () => {
    try {
      const target = parsePreviewLink(location.hash);
      if (target) void this.open(target);
    } catch (e) {
      this.failure.set(String(e));
    }
  };
  ngAfterViewInit() {
    const generation = this.generation;
    void readLocal<SavedWatchface>('preview:recent')
      .then((saved) => {
        if (
          generation === this.generation &&
          saved &&
          isFirmwareProfile(saved.profile) &&
          typeof saved.name === 'string' &&
          ((saved.bytes instanceof Blob && saved.bytes.size <= 8 * 1048576) ||
            (saved.bytes instanceof Uint8Array && saved.bytes.byteLength <= 8 * 1048576))
        )
          this.recent.set(saved);
      })
      .catch(() => {});
    addEventListener('hashchange', this.route);
    queueMicrotask(this.route);
  }
  ngOnDestroy() {
    this.controller?.abort();
    removeEventListener('hashchange', this.route);
    this.generation++;
  }
  changeWatch(profile: FirmwareProfile) {
    if (profile === this.profile()) return;
    const target = this.target(),
      file = this.package();
    this.cancel();
    this.profile.set(profile);
    if (target) void this.open({ ...target, profile });
    else if (file) void this.builtPackage(file);
    else this.status.set('');
  }
  download(role: 'micro' | 'spi') {
    return firmwareDownload(this.profile(), role);
  }
  example() {
    void this.open({ kind: 'example', profile: this.profile() });
  }
  openStore(appId: string) {
    this.showStore.set(false);
    void this.open({ kind: 'store', profile: this.profile(), appId });
  }
  github() {
    try {
      const value = this.repo.trim().startsWith('github.com/')
        ? 'https://' + this.repo.trim()
        : this.repo;
      const target: PreviewTarget = {
        kind: 'github',
        profile: this.profile(),
        repository: parseRepository(value, this.ref, this.root),
        ...(this.pbw.trim() ? { pbw: this.pbw.trim() } : {}),
        ...(this.release.trim() || this.asset.trim()
          ? { release: this.release.trim(), asset: this.asset.trim() }
          : {}),
      };
      parsePreviewLink(new URL(previewLink(location.href, target)).hash);
      void this.open(target);
    } catch (e) {
      this.failure.set(String(e));
    }
  }
  private begin() {
    this.starting.emit();
    this.controller?.abort();
    this.controller = new AbortController();
    this.generation++;
    this.busy.set(true);
    this.setup.set(false);
    this.failure.set('');
    this.copyStatus.set('');
    return this.generation;
  }
  async open(target: PreviewTarget) {
    if (this.sessionBusy) this.canceled.emit();
    const generation = this.begin(),
      signal = this.controller!.signal;
    this.profile.set(target.profile);
    this.target.set(target);
    this.package.set(null);
    this.title.set(
      target.kind === 'example'
        ? 'Clock'
        : target.kind === 'store'
          ? 'Store package'
          : `${target.repository.owner}/${target.repository.repository}`,
    );
    history.replaceState(null, '', previewLink(location.href, target));
    try {
      if (target.kind === 'example') {
        this.status.set('Opening Clock…');
        const response = await fetch(
          new URL(
            `examples/clock-${FIRMWARE_PROFILES[target.profile].platform}.pbw`,
            document.baseURI,
          ),
          { signal },
        );
        if (!response.ok) throw new Error('The example could not be downloaded. Please try again.');
        const bytes = await readLimited(response, 1048576);
        signal.throwIfAborted();
        this.package.set({ bytes, name: 'Clock.pbw' });
      } else if (target.kind === 'store') {
        const result = await storePreview(target, signal, (text) => {
          if (generation === this.generation) this.status.set(text);
        });
        signal.throwIfAborted();
        this.title.set(result.title);
        this.package.set(result.package);
        this.target.set(result.target);
        history.replaceState(null, '', previewLink(location.href, result.target));
      } else {
        this.repo = `${target.repository.owner}/${target.repository.repository}`;
        this.ref = target.repository.ref;
        this.root = target.repository.root;
        this.pbw = target.pbw ?? '';
        this.release = target.release ?? '';
        this.asset = target.asset ?? '';
        const result = await repositoryPreview(target, signal, (text) => {
          if (generation === this.generation) this.status.set(text);
        });
        signal.throwIfAborted();
        this.target.set(result.target);
        history.replaceState(null, '', previewLink(location.href, result.target));
        if (result.kind === 'source') {
          this.status.set('Source imported. Build this project in Developer tools.');
          this.source.emit(result.source);
          return;
        }
        this.package.set(result.package);
      }
      await this.prepareWatch(generation);
    } catch (e) {
      if (generation === this.generation && !signal.aborted) this.failure.set(String(e));
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  async openPackage(event: Event) {
    const control = event.target as HTMLInputElement,
      file = control.files?.[0];
    if (!file) return;
    const generation = this.begin();
    this.target.set(null);
    this.title.set(file.name);
    this.package.set(null);
    history.replaceState(null, '', new URL('.', document.baseURI));
    try {
      if (file.size > 8 * 1048576) throw new Error('Preview packages are limited to 8 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation !== this.generation) return;
      this.package.set({ bytes, name: file.name });
      await this.prepareWatch(generation);
    } catch (e) {
      if (generation === this.generation) this.failure.set(String(e));
    } finally {
      if (generation === this.generation) this.busy.set(false);
      control.value = '';
    }
  }
  async builtPackage(value: PreviewPackage) {
    const generation = this.begin();
    this.package.set(value);
    try {
      await this.prepareWatch(generation);
    } catch (e) {
      if (generation === this.generation) this.failure.set(String(e));
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  private async prepareWatch(generation: number, fresh = false) {
    let firmware =
      !fresh && this.watchLoaded && this.currentProfile === this.profile()
        ? undefined
        : await savedFirmware(this.profile()).catch(() => undefined);
    if (generation !== this.generation) return;
    if (!firmware && (fresh || !this.watchLoaded || this.currentProfile !== this.profile())) {
      this.status.set('Loading default firmware…');
      try {
        firmware = await bundledFirmware(this.profile(), this.controller!.signal);
      } catch (error) {
        if (generation === this.generation && !this.controller!.signal.aborted) {
          this.status.set('Watchface ready. Retry the firmware download or open it manually.');
          this.setup.set(true);
        }
        throw error;
      }
      if (generation !== this.generation) return;
      // Persist this known, checksummed default before handing it to the Worker.
      // Canceling during the ensuing boot can then reuse the accepted download.
      await saveFirmware(firmware).catch(() => {
        if (generation === this.generation)
          this.copyStatus.set(
            'Storage is unavailable. Default firmware will download again next visit.',
          );
      });
      if (generation !== this.generation) return;
    }
    this.status.set('');
    this.setup.set(false);
    const file = this.package()!;
    const saved = {
      profile: this.profile(),
      name: file.name,
      // PBWs are bounded to 8 MiB. Typed arrays also work in WebKit environments
      // where IndexedDB rejects Blobs; keep a copy independent of Worker transfers.
      bytes: file.bytes.slice(),
    };
    await writeLocal('preview:recent', saved)
      .then(() => {
        if (generation === this.generation) this.recent.set(saved);
      })
      .catch(() => {
        if (generation === this.generation)
          this.copyStatus.set(
            'This watchface could not be saved on this device. Keep its PBW file to reopen it.',
          );
      });
    if (generation !== this.generation) return;
    this.launch.emit({
      profile: this.profile(),
      package: this.package()!,
      ...(firmware ? { firmware } : {}),
    });
  }
  async retryFirmware() {
    if (this.package()) await this.builtPackage(this.package()!);
  }
  async restart() {
    if (!this.package()) return;
    const generation = this.begin();
    try {
      await this.prepareWatch(generation, true);
    } catch (error) {
      if (generation === this.generation) this.failure.set(String(error));
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  async setupFiles(event: Event) {
    const control = event.target as HTMLInputElement,
      files = Array.from(control.files ?? []);
    if (!files.length) return;
    const generation = this.generation;
    this.busy.set(true);
    this.failure.set('');
    this.status.set('Reading firmware…');
    try {
      const firmware = await previewFirmwareFiles(files, this.profile());
      if (generation !== this.generation) return;
      await saveFirmware(firmware).catch(() => {
        this.copyStatus.set(
          'Storage is unavailable. Firmware will need to be opened again next visit.',
        );
      });
      if (generation !== this.generation) return;
      this.setup.set(false);
      this.status.set('');
      this.launch.emit({ profile: this.profile(), package: this.package()!, firmware });
    } catch (e) {
      if (generation === this.generation) this.failure.set(String(e));
    } finally {
      if (generation === this.generation) this.busy.set(false);
      control.value = '';
    }
  }
  resumeAfterFirmware() {
    if (this.setup() && this.package()) void this.builtPackage(this.package()!);
  }
  cancel() {
    this.controller?.abort();
    this.generation++;
    this.busy.set(false);
    this.setup.set(false);
    this.status.set('Preview canceled.');
    this.failure.set('');
    this.canceled.emit();
  }
  sourceLink() {
    const target = this.target();
    if (!target) return '';
    if (target.kind === 'store') return `https://apps.repebble.com/app_${target.appId}`;
    return target.kind === 'example'
      ? 'https://github.com/huntrontrakkr/pebble-browser-emulator/tree/main/examples/preview-clock'
      : `https://github.com/${target.repository.owner}/${target.repository.repository}/tree/${encodeURIComponent(target.repository.ref || 'HEAD')}/${target.repository.root.split('/').map(encodeURIComponent).join('/')}`;
  }
  shareUrl() {
    return this.target() ? previewLink(location.href, this.target()!) : '';
  }
  async copyLink() {
    this.linkVisible.set(true);
    try {
      await navigator.clipboard.writeText(this.shareUrl());
      this.copyStatus.set('Link copied. Default firmware loads automatically.');
    } catch {
      this.copyStatus.set('Select and copy the link below. Default firmware loads automatically.');
    }
  }
  savePackage() {
    const pkg = this.package();
    if (!pkg) return;
    const url = URL.createObjectURL(new Blob([pkg.bytes.slice().buffer]));
    const link = document.createElement('a');
    link.href = url;
    link.download = pkg.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
