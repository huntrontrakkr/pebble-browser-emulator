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
import { parseRepository, readLimited, type SourceSnapshot } from './projects.ts';
import { FIRMWARE_PROFILES, type FirmwareProfile } from './watch-profiles.ts';
import {
  parsePreviewLink,
  previewLink,
  repositoryPreview,
  type PreviewTarget,
  type PreviewPackage,
} from './preview-links.ts';
import {
  firmwareDownload,
  previewFirmwareFiles,
  savedFirmware,
  saveFirmware,
  type PreviewFirmware,
} from './preview-firmware.ts';

export interface PreviewLaunch {
  profile: FirmwareProfile;
  package: PreviewPackage;
  firmware?: PreviewFirmware;
}

@Component({
  selector: 'preview-panel',
  imports: [FormsModule],
  template: `
    <div class="section-heading"><h1>Watchface preview</h1></div>
    <details
      class="preview-chooser"
      [open]="expanded()"
      (toggle)="expanded.set($any($event.target).open)"
    >
      <summary>{{ title() ? 'Choose another watchface' : 'Choose a watchface or app' }}</summary>
      <label
        >Watch<select
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
        <button class="primary" (click)="example()" [disabled]="busy() || sessionBusy">
          Try example
        </button>
        <label class="file-button"
          >Open watchface .pbw<input
            type="file"
            accept=".pbw"
            (change)="openPackage($event)"
            [disabled]="busy() || sessionBusy"
        /></label>
      </div>
      <p class="help">The Clock example is ready to run. No compiler needed.</p>
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
        </details>
        <button type="submit" [disabled]="!repo.trim() || busy() || sessionBusy">
          Open project
        </button>
      </form>
    </details>
    @if (title()) {
      <div class="preview-selection">
        <strong>{{ title() }}</strong>
        @if (sourceLink()) {
          <a [href]="sourceLink()" target="_blank" rel="noopener noreferrer">Source ↗</a>
        }
      </div>
    }
    @if (setup()) {
      <section class="firmware-setup" aria-label="Preview watch setup">
        <h2>Set up this watch once</h2>
        <p>The browser needs two firmware files. They stay on this device for future previews.</p>
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
        <p class="help">
          GitHub does not allow this site to download these files automatically. After this step,
          the selected watchface starts automatically.
        </p>
        <button (click)="tools.emit('Firmware')">Use different firmware</button>
      </section>
    }
    @if (status() || sessionStatus) {
      <p class="preview-progress" role="status">
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
        @if (copyStatus()) {
          <p class="help" role="status">{{ copyStatus() }}</p>
        }
      </div>
    }
    @if (expanded()) {
      <p class="help preview-note">
        Prepared GitHub previews open directly. Source-only projects open in Developer tools for a
        local build.
      </p>
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
  busy = signal(false);
  setup = signal(false);
  status = signal('');
  failure = signal('');
  title = signal('');
  target = signal<PreviewTarget | null>(null);
  package = signal<PreviewPackage | null>(null);
  linkVisible = signal(false);
  copyStatus = signal('');
  expanded = signal(true);
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
    addEventListener('hashchange', this.route);
    queueMicrotask(this.route);
  }
  ngOnDestroy() {
    this.controller?.abort();
    removeEventListener('hashchange', this.route);
    this.generation++;
  }
  changeWatch(profile: FirmwareProfile) {
    this.cancel();
    this.profile.set(profile);
  }
  download(role: 'micro' | 'spi') {
    return firmwareDownload(this.profile(), role);
  }
  example() {
    void this.open({ kind: 'example', profile: this.profile() });
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
      } else {
        this.repo = `${target.repository.owner}/${target.repository.repository}`;
        this.ref = target.repository.ref;
        this.root = target.repository.root;
        this.pbw = target.pbw ?? '';
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
  private async prepareWatch(generation: number) {
    const firmware =
      this.watchLoaded && this.currentProfile === this.profile()
        ? undefined
        : await savedFirmware(this.profile()).catch(() => undefined);
    if (generation !== this.generation) return;
    if (!firmware && (!this.watchLoaded || this.currentProfile !== this.profile())) {
      this.status.set('Watchface ready. Complete watch setup to start it.');
      this.setup.set(true);
      return;
    }
    this.status.set('');
    this.setup.set(false);
    this.launch.emit({
      profile: this.profile(),
      package: this.package()!,
      ...(firmware ? { firmware } : {}),
    });
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
      this.copyStatus.set('Link copied. New visitors need to set up firmware once.');
    } catch {
      this.copyStatus.set(
        'Select and copy the link below. New visitors need to set up firmware once.',
      );
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
