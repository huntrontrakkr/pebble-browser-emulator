import { Component, EventEmitter, Output, signal } from '@angular/core';
import { microFlashImage } from './firmware-image.ts';
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
    <p class="help">
      Use a matching pair of QEMU Emery micro flash and SPI flash images. After loading, press Run;
      first boot initializes flash and takes several seconds. Production Time 2 firmware requires
      the Obelix hardware profile, which is not implemented.
    </p>
    <label>Release tag<input [(ngModel)]="releaseTag" placeholder="v4.37.0" /></label>
    <button (click)="findRelease()" [disabled]="busy()">Find release</button>
    @if (releases().length) {
      <label
        >Release<select [ngModel]="selectedTag()" (ngModelChange)="selectedTag.set($event)">
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
        <p class="help">This release has no QEMU Emery or production Time 2 images.</p>
      }
      <p class="help">
        GitHub release downloads do not permit browser imports across origins. Download the files
        above, then open them below. Matching catalog checksums are verified locally.
      </p>
    }
    <div class="field-grid">
      <label class="file-button"
        >Open micro flash .bin<input
          type="file"
          accept=".bin"
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
    <button class="primary" [disabled]="!micro || !flash || busy()" (click)="boot()">
      Load firmware
    </button>
    <hr />
    <h3>Inspect a firmware package</h3>
    <p class="help">
      Open a production PBZ to inspect its board and slot metadata. It cannot run on the QEMU
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
export class FirmwarePanel {
  releaseTag = 'v4.37.0';
  @Output() loadFirmware = new EventEmitter<{
    micro: Uint8Array;
    flash: Uint8Array;
    name: string;
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
    return this.releases().find((r) => r.tag === this.selectedTag())?.assets ?? [];
  }
  async catalog() {
    this.begin();
    try {
      const items = await fetchFirmwareReleases(this.page);
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
    this.begin();
    try {
      const release = await fetchFirmwareRelease(this.releaseTag);
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
      if (/obelix|normal_|recovery_/.test(file.name))
        throw new Error('Production firmware is not compatible with the QEMU Emery board.');
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
    if (!this.micro || !this.flash) return;
    const a = this.microName().match(/v\d+\.\d+\.\d+/)?.[0],
      b = this.flashName().match(/v\d+\.\d+\.\d+/)?.[0];
    if (a && b && a !== b) {
      this.status.set(
        'Micro and SPI images have different version numbers. Select a matching pair.',
      );
      return;
    }
    this.loadFirmware.emit({ micro: this.micro, flash: this.flash, name: this.microName() });
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
}
export async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
}
