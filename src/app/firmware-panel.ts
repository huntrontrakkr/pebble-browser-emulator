import { WATCH_PRODUCTS, fileProfile, type FirmwareProfile } from './watch-profiles.ts';
import { Component, EventEmitter, Output, OnDestroy, signal } from '@angular/core';
import { downloadFirmwareRelease } from './firmware-downloads.ts';
import { resourceFetch } from './resource-fetch.ts';
import { microFlashImage } from './firmware-image.ts';
import { inspectFirmwareBundle } from './firmware-bundle.ts';
import { FormsModule } from '@angular/forms';
import {
  fetchFirmwareReleases,
  fetchFirmwareRelease,
  type FirmwareRelease,
  type FirmwareAsset,
} from './firmware-catalog.ts';
import type { PackageInfo } from './archives.ts';
@Component({
  selector: 'firmware-panel',
  imports: [FormsModule],
  template: `
    <div class="section-heading">
      <h2>Firmware</h2>
      <button (click)="catalog()" [disabled]="busy()">
        {{ releases().length ? 'Browse more releases' : 'Browse official releases' }}
      </button>
    </div>
    <label
      >Watch model<select [ngModel]="productId()" (ngModelChange)="selectProduct($event)">
        @for (product of products; track product.id) {
          <option [value]="product.id">{{ product.name }} · {{ product.platform }}</option>
        }
      </select></label
    >
    <p class="help">{{ product().note }}</p>
    @if (product().runtime) {
      <p class="help">
        Use matching {{ product().runtime }} micro flash and SPI flash images. Load them, then press
        Run. First boot initializes flash and takes several seconds.
      </p>
    } @else {
      <p class="status-message">
        Firmware execution is not available for this hardware yet. You can inspect firmware packages
        and build apps for its platform in Projects.
      </p>
    }
    <label class="check"
      ><input type="checkbox" [(ngModel)]="showLegacy" (change)="legacyChanged()" />Show older watch
      models</label
    >
    <label
      >GitHub firmware source<input
        [(ngModel)]="repository"
        (change)="resetCatalog()"
        placeholder="owner/repository"
    /></label>
    <label
      >Release tag<input [(ngModel)]="releaseTag" placeholder="Exact tag, including any prefix"
    /></label>
    <button (click)="findRelease()" [disabled]="busy()">Find release</button>
    @if (releases().length) {
      <label
        >Release<select [ngModel]="selectedTag()" (ngModelChange)="selectRelease($event)">
          <option value="">Select a release</option>
          @for (release of releases(); track release.tag) {
            <option [value]="release.tag">
              {{ release.tag }} · {{ release.published.slice(0, 10) }}
            </option>
          }
        </select></label
      >
      @for (asset of selectedAssets(); track asset.id) {
        <div class="asset-row">
          <div>
            <strong>{{ asset.name }}</strong
            ><span>{{ (asset.bytes / 1048576).toFixed(1) }} MiB · {{ asset.board }}</span>
          </div>
          <a [href]="asset.url" target="_blank" rel="noopener">Download</a>
        </div>
      }
      @if (selectedTag() && !selectedAssets().length) {
        <p class="help">This release has no images for the selected emulator board.</p>
      }
      @if (product().runtime && selectedAssets().length) {
        <button class="primary" (click)="downloadSelected()" [disabled]="busy()">
          Load selected firmware
        </button>
        @if (downloading()) {
          <button (click)="cancelFirmwareDownload()">Cancel download</button>
        }
      }
      <p class="help">
        Downloads use the browser first, then your optional download service if enabled. You can
        also open files below.
      </p>
    }
    <div class="field-grid">
      <label class="file-button"
        >Open micro flash .bin / .elf<input
          type="file"
          accept=".bin,.elf"
          (change)="read($event, 'micro')" /></label
      ><label class="file-button"
        >Open SPI flash .bin<input type="file" accept=".bin" (change)="read($event, 'flash')"
      /></label>
    </div>
    <dl class="properties">
      <div>
        <dt>Micro flash</dt>
        <dd>{{ microName() || 'No file selected' }}</dd>
      </div>
      <div>
        <dt>SPI flash</dt>
        <dd>{{ flashName() || 'No file selected' }}</dd>
      </div>
    </dl>
    <button
      class="primary"
      [disabled]="!product().runtime || !micro || !flash || busy()"
      (click)="boot()"
    >
      Load firmware
    </button>
    <hr />
    <h3>Firmware bundle</h3>
    <p class="help">
      Select a versioned bundle JSON and all files it names. Board roles and every SHA-256 are
      checked before loading. Stock board bundles remain inspection-only until their hardware
      runtime is implemented.
    </p>
    <label class="file-button"
      >Open bundle and assets<input
        type="file"
        multiple
        accept=".json,.bin,.elf,.pbz"
        (change)="openBundle($event)"
        [disabled]="busy()"
    /></label>
    <hr />
    <h3>Inspect a firmware package</h3>
    <p class="help">
      Open a watch firmware PBZ to inspect its board and slot metadata. It cannot run on the QEMU
      profile.
    </p>
    <label class="file-button"
      >Open .pbz<input type="file" accept=".pbz" (change)="inspect($event)"
    /></label>
    @if (packageSummary()) {
      <pre class="source-preview">{{ packageSummary() }}</pre>
    }
    @if (status()) {
      <p class="status-message" role="status">{{ status() }}</p>
    }
  `,
})
export class FirmwarePanel implements OnDestroy {
  downloading = signal(false);
  private downloadController?: AbortController;
  ngOnDestroy() {
    this.downloadController?.abort();
  }
  cancelFirmwareDownload() {
    this.downloadController?.abort();
  }
  selectRelease(tag: string) {
    this.cancelFirmwareDownload();
    this.selectedTag.set(tag);
  }
  async downloadSelected() {
    const release = this.releases().find((r) => r.tag === this.selectedTag());
    const profile = this.product().runtime;
    if (!release || !profile || this.busy()) return;
    const controller = new AbortController();
    this.downloadController = controller;
    this.begin();
    this.downloading.set(true);
    this.status.set('Downloading firmware…');
    try {
      const firmware = await downloadFirmwareRelease(
        release,
        profile,
        this.repository,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      this.loadFirmware.emit(firmware);
      this.status.set('Firmware downloaded and loaded.');
    } catch (error) {
      this.status.set(
        controller.signal.aborted
          ? 'Firmware download canceled.'
          : String((error as Error).message),
      );
    } finally {
      this.downloading.set(false);
      this.end();
    }
  }
  showLegacy = false;
  legacyChanged() {
    if (!this.showLegacy && !this.product().runtime) this.selectProduct('time-2');
  }
  get products() {
    return WATCH_PRODUCTS.filter((p) => this.showLegacy || p.runtime);
  }
  repository = 'coredevices/PebbleOS';
  private catalogRevision = 0;
  resetCatalog() {
    this.cancelFirmwareDownload();
    this.catalogRevision++;
    this.releases.set([]);
    this.selectedTag.set('');
    this.page = 1;
  }
  productId = signal('time-2');
  product() {
    return WATCH_PRODUCTS.find((p) => p.id === this.productId())!;
  }
  selectProduct(id: string) {
    this.cancelFirmwareDownload();
    if (!this.products.some((p) => p.id === id)) return;
    this.productId.set(id);
    this.revisions.micro++;
    this.revisions.flash++;
    this.micro = undefined;
    this.flash = undefined;
    this.microName.set('');
    this.flashName.set('');
    this.status.set('');
  }
  releaseTag = 'v4.37.0';
  @Output() loadFirmware = new EventEmitter<{
    micro: Uint8Array;
    flash: Uint8Array;
    name: string;
    profile: FirmwareProfile;
  }>();
  @Output() event = new EventEmitter<string>();
  releases = signal<FirmwareRelease[]>([]);
  selectedTag = signal('');
  busy = signal(false);
  status = signal('');
  microName = signal('');
  flashName = signal('');
  packageSummary = signal('');
  micro?: Uint8Array;
  flash?: Uint8Array;
  private page = 1;
  private pending = 0;
  private begin() {
    this.pending++;
    this.busy.set(true);
  }
  private end() {
    this.pending = Math.max(0, this.pending - 1);
    this.busy.set(this.pending > 0);
  }
  private revisions = { micro: 0, flash: 0 };
  selectedAssets() {
    return (this.releases().find((r) => r.tag === this.selectedTag())?.assets ?? []).filter((a) =>
      this.product().runtime ? a.board === this.product().runtime : a.kind === 'production',
    );
  }
  async catalog() {
    const revision = this.catalogRevision;
    this.begin();
    try {
      const items = await fetchFirmwareReleases(
        this.page,
        undefined,
        resourceFetch,
        this.repository,
      );
      if (revision !== this.catalogRevision) return;
      this.releases.update((r) => [
        ...r,
        ...items.filter((item) => !r.some((existing) => existing.tag === item.tag)),
      ]);
      this.page++;
      if (!this.selectedTag())
        this.selectedTag.set(
          items.find((r) => r.assets.some((a) => a.kind === 'qemu-code'))?.tag ??
            items[0]?.tag ??
            '',
        );
      this.status.set(items.length ? '' : 'No more releases.');
    } catch (e) {
      this.status.set(String(e));
    } finally {
      this.end();
    }
  }
  async findRelease() {
    const revision = this.catalogRevision;
    this.begin();
    try {
      const release = await fetchFirmwareRelease(this.releaseTag, this.repository);
      if (revision !== this.catalogRevision) return;
      this.releases.update((items) => [
        release,
        ...items.filter((item) => item.tag !== release.tag),
      ]);
      this.selectedTag.set(release.tag);
      this.status.set('');
    } catch (e) {
      this.status.set(String(e));
    } finally {
      this.end();
    }
  }
  async read(event: Event, kind: 'micro' | 'flash') {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    const revision = ++this.revisions[kind];
    this.begin();
    try {
      if (
        file.size > (kind === 'micro' ? 24 : 32) * 1048576 ||
        file.size < (kind === 'micro' ? 8 : 32 * 1048576)
      )
        throw new Error(
          kind === 'micro'
            ? 'Micro flash input must be at most 24 MiB (ELF) or 4 MiB after normalization.'
            : 'SPI flash must be exactly 32 MiB.',
        );
      if (/normal_|recovery_|\.pbz$/i.test(file.name))
        throw new Error(
          'Physical watch firmware needs its own hardware profile. Select emulator images.',
        );
      const detected = fileProfile(file.name);
      if (!this.product().runtime || (detected && detected !== this.product().runtime))
        throw new Error('Image board does not match the selected watch model.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const asset = this.releases()
        .flatMap((r) => r.assets)
        .find((a) => a.name === file.name);
      if (asset?.sha256) {
        const digest = await sha256(bytes);
        if (digest !== asset.sha256)
          throw new Error('File checksum does not match the official release.');
      }
      if (revision !== this.revisions[kind]) return;
      if (kind === 'micro') {
        const normalized = microFlashImage(bytes);
        if (normalized.length > 4 * 1048576)
          throw new Error('Normalized micro flash exceeds 4 MiB.');
        this.micro = normalized;
        this.microName.set(file.name);
      } else {
        this.flash = bytes;
        this.flashName.set(file.name);
      }
      this.status.set(
        asset?.sha256
          ? 'Official SHA-256 verified.'
          : 'File opened. No matching catalog checksum available.',
      );
    } catch (e) {
      this.status.set(String(e));
    } finally {
      this.end();
      input.value = '';
    }
  }
  boot() {
    const profile = this.product().runtime;
    if (!profile || !this.micro || !this.flash) return;
    const a = this.microName().match(/v\d+\.\d+\.\d+/)?.[0],
      b = this.flashName().match(/v\d+\.\d+\.\d+/)?.[0];
    if (a && b && a !== b) {
      this.status.set(
        'Micro and SPI images have different version numbers. Select a matching pair.',
      );
      return;
    }
    this.loadFirmware.emit({
      micro: this.micro,
      flash: this.flash,
      name: this.microName(),
      profile,
    });
  }
  async inspect(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 80 * 1048576) throw new Error('Package exceeds 80 MiB.');
      const worker = new Worker(new URL('./archive.worker', import.meta.url), { type: 'module' });
      const result = await new Promise<PackageInfo>((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          worker.terminate();
          data.error ? reject(new Error(data.error)) : resolve(data.result);
        };
        worker.onerror = (e) => {
          worker.terminate();
          reject(new Error(e.message));
        };
        file
          .arrayBuffer()
          .then((bytes) =>
            worker.postMessage({ id: 1, kind: 'package', bytes: new Uint8Array(bytes) }),
          )
          .catch((error) => {
            worker.terminate();
            reject(error);
          });
      });
      this.packageSummary.set(JSON.stringify(result.manifest, null, 2));
    } catch (e) {
      this.status.set(String(e));
    } finally {
      input.value = '';
    }
  }
  async openBundle(event: Event) {
    const input = event.target as HTMLInputElement,
      files = Array.from(input.files ?? []);
    if (!files.length) return;
    this.begin();
    try {
      const manifests = files.filter((f) => f.name.endsWith('.json'));
      if (manifests.length !== 1 || manifests[0]!.size > 65536)
        throw new Error('Select one bundle JSON (up to 64 KiB) and its assets.');
      if (files.reduce((n, f) => n + f.size, 0) > 160 * 1048576)
        throw new Error('Firmware bundle exceeds 160 MiB.');
      const assets: Record<string, Uint8Array> = Object.create(null);
      for (const file of files) {
        if (Object.hasOwn(assets, file.name)) throw new Error('Duplicate asset filename.');
        assets[file.name] = new Uint8Array(await file.arrayBuffer());
      }
      const result = await inspectFirmwareBundle(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assets[manifests[0]!.name])),
        assets,
      );
      this.packageSummary.set(JSON.stringify(result.manifest, null, 2));
      if (result.loadable) {
        const product = WATCH_PRODUCTS.find((p) => p.runtime === result.loadable!.profile);
        if (product) this.productId.set(product.id);
        this.loadFirmware.emit(result.loadable);
        this.status.set('Bundle checksums verified; firmware loaded.');
      } else this.status.set(result.reason!);
    } catch (e) {
      this.status.set(String(e));
    } finally {
      input.value = '';
      this.end();
    }
  }
}
export async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
}
