import { compilerSdkFiles } from './sdk-files.ts';
import { LinuxBuildPanel } from './linux-build-panel.ts';
import { APP_PLATFORMS, type AppPlatform } from './watch-profiles.ts';
import { readLocal, writeLocal, clearLocal } from './local-store.ts';
import {
  Component,
  EventEmitter,
  Output,
  Input,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  importRepository,
  parseRepository,
  describeSnapshot,
  type SourceSnapshot,
} from './projects.ts';
import type { PackageInfo } from './archives.ts';
@Component({
  selector: 'project-panel',
  imports: [FormsModule, LinuxBuildPanel],
  template: `
    <div class="section-heading">
      <h2>App project</h2>
      <button (click)="clearSaved()" [disabled]="busy()">Clear saved files</button>
    </div>
    <label
      >Public GitHub repository<input [(ngModel)]="repo" placeholder="owner/repository"
    /></label>
    <div class="field-grid">
      <label>Branch or commit<input [(ngModel)]="ref" placeholder="Default branch" /></label
      ><label>Project folder<input [(ngModel)]="root" placeholder="Repository root" /></label>
    </div>
    <div class="actions">
      <button class="primary" (click)="import()" [disabled]="busy()">Import repository</button
      ><button (click)="demo()" [disabled]="busy()">Load example</button
      ><button (click)="sensorDemo()" [disabled]="busy()">Sensor test</button
      ><label class="file-button"
        >Open source ZIP<input
          type="file"
          accept=".zip"
          (change)="openZip($event)"
          [disabled]="busy()"
      /></label>
      <label class="file-button"
        >Open project folder<input
          type="file"
          webkitdirectory
          multiple
          (change)="openFolder($event)"
          [disabled]="busy()"
      /></label>
    </div>
    @if (project()) {
      <p class="help">
        {{ project()!.owner }}/{{ project()!.repository }}
        <code>{{ project()!.commit.slice(0, 12) }}</code> · {{ paths().length }} files
      </p>
      <label
        >File<select [ngModel]="selected()" (ngModelChange)="selected.set($event)">
          @for (path of paths(); track path) {
            <option [value]="path">{{ path }}</option>
          }
        </select></label
      >
      <pre class="source-preview" tabindex="0">{{ filePreview() }}</pre>
    }
    <hr />
    <h3>Browser compiler</h3>
    <p class="help">
      Builds SDK 4.33.1 native C apps locally. Select the app platform matching your watch. PNG/PBI
      and raw resources, local JS modules, and locked JavaScript packages are supported. Custom
      fonts and native package libraries need the Linux compatibility build below.
    </p>
    <label
      >Build platform<select [(ngModel)]="platform" [disabled]="busy()">
        @for (target of platforms; track target) {
          <option [value]="target">{{ target }}</option>
        }
      </select></label
    >
    <label class="file-button"
      >Open SDK 4.33.1 .tar.gz<input
        type="file"
        accept=".gz,.tgz"
        (change)="openSdk($event)"
        [disabled]="busy()" /></label
    ><span class="help"> {{ sdkName() || 'SDK not loaded' }}</span>
    <p class="help">
      <a href="https://developer.repebble.com/sdk/" target="_blank" rel="noopener"
        >SDK download and setup</a
      >
      · Compiler assets download once (~94 MiB) and are cached locally. Compilation runs in a
      browser Worker. The imported project and required SDK files are saved on this device.
    </p>
    <div class="actions">
      <button class="primary" [disabled]="!project() || !sdk || busy()" (click)="build()">
        Build PBW</button
      ><button [disabled]="!built() || busy()" (click)="install()">Install on watch</button
      ><button [disabled]="!built()" (click)="download()">Save PBW</button>
      @if (busy()) {
        <button (click)="cancel()">Cancel</button>
      }
    </div>
    <linux-build-panel
      [project]="project()"
      [platform]="platform"
      [disabled]="busy() && !linuxBusy"
      (busyChange)="linuxState($event)"
      (packageBuilt)="linuxPackage($event)"
    />
    <hr />
    <h3>Existing app package</h3>
    <label class="file-button"
      >Open .pbw<input type="file" accept=".pbw" (change)="openPbw($event)" [disabled]="busy()"
    /></label>
    @if (status()) {
      <p class="status-message" role="status">{{ status() }}</p>
    }
    @if (buildLog()) {
      <pre class="build-log" tabindex="0">{{ buildLog() }}</pre>
    }
  `,
})
export class ProjectPanel implements OnDestroy {
  @ViewChild(LinuxBuildPanel) linuxPanel?: LinuxBuildPanel;
  linuxBusy = false;
  linuxState(value: boolean) {
    this.linuxBusy = value;
    this.busy.set(value);
    if (value) this.built.set(null);
  }
  linuxPackage(bytes: Uint8Array) {
    this.built.set(bytes);
    this.status.set('Linux build produced a PBW. Install it on a matching watch.');
  }
  @Input() platform: AppPlatform = 'emery';
  readonly platforms = Object.keys(APP_PLATFORMS) as AppPlatform[];
  @Output() packageReady = new EventEmitter<{ bytes: Uint8Array; name: string }>();
  @Output() scriptReady = new EventEmitter<{
    source: string;
    name: string;
    appId?: string;
    messageKeys?: Record<string, number>;
    appInfo?: Record<string, unknown>;
  }>();
  repo = '';
  ref = '';
  root = '';
  project = signal<SourceSnapshot | null>(null);
  selected = signal('package.json');
  sdkName = signal('');
  sdk?: Record<string, Uint8Array>;
  busy = signal(false);
  status = signal('');
  buildLog = signal('');
  built = signal<Uint8Array | null>(null);
  private controller?: AbortController;
  private worker?: Worker;
  private rejectJob?: (e: Error) => void;
  private job = 0;
  private storageRevision = 0;
  constructor() {
    void this.restoreLocal();
  }
  async restoreLocal() {
    const revision = this.storageRevision;
    try {
      const [project, sdk] = await Promise.all([
        readLocal<SourceSnapshot>('project'),
        readLocal<{ name: string; files: Record<string, Uint8Array> }>('sdk'),
      ]);
      if (revision !== this.storageRevision) return;
      if (project) this.setProject(project, false);
      if (sdk) {
        this.sdk = sdk.files;
        this.sdkName.set(sdk.name);
      }
    } catch {}
  }
  async clearSaved() {
    this.storageRevision++;
    try {
      await clearLocal();
      this.status.set('Saved project and SDK files removed from this device.');
    } catch (e) {
      this.status.set(String(e));
    }
  }
  paths() {
    return Object.keys(this.project()?.files ?? {}).sort();
  }
  filePreview() {
    const bytes = this.project()?.files[this.selected()];
    if (!bytes) return '';
    if (bytes.subarray(0, 2048).includes(0)) return `Binary file · ${bytes.length} bytes`;
    return new TextDecoder().decode(bytes.subarray(0, 16000)) + (bytes.length > 16000 ? '\n…' : '');
  }
  async import() {
    const job = ++this.job;
    this.storageRevision++;
    this.busy.set(true);
    const controller = (this.controller = new AbortController());
    try {
      const project = await importRepository(
        parseRepository(this.repo, this.ref, this.root),
        controller.signal,
        (text) => {
          if (job === this.job) this.status.set(text);
        },
      );
      if (job !== this.job) return;
      this.setProject(project);
      this.status.set('Source imported at the displayed commit.');
    } catch (e) {
      if (job === this.job) this.status.set(String(e));
    } finally {
      if (job === this.job) {
        this.busy.set(false);
        this.controller = undefined;
      }
    }
  }
  async demo() {
    this.repo = 'huntrontrakkr/pebble-browser-emulator';
    this.ref = 'main';
    this.root = 'examples/platform-watchface';
    await this.import();
  }
  async sensorDemo() {
    this.repo = 'huntrontrakkr/pebble-browser-emulator';
    this.ref = 'main';
    this.root = 'examples/sensor-test';
    await this.import();
  }
  setProject(p: SourceSnapshot, persist = true) {
    this.storageRevision++;
    if (persist)
      void writeLocal('project', p).catch(() =>
        this.status.set('Project loaded; local storage is unavailable.'),
      );
    this.project.set(p);
    this.built.set(null);
    this.selected.set(p.files['package.json'] ? 'package.json' : Object.keys(p.files)[0]);
    const js = p.files['src/pkjs/index.js'];
    this.scriptReady.emit({
      source:
        js && !/\b(?:require\s*\(|import\s|export\s)/.test(new TextDecoder().decode(js))
          ? new TextDecoder().decode(js)
          : '',
      name: `${p.repository}/src/pkjs/index.js`,
      appId: (p.metadata?.['pebble'] as any)?.uuid,
      messageKeys:
        (p.metadata?.['pebble'] as any)?.messageKeys ??
        (p.metadata?.['appKeys'] as Record<string, number>),
      appInfo: p.metadata ?? {},
    });
  }
  async archive(file: File, kind: 'sdk' | 'package' | 'source'): Promise<any> {
    const job = this.job;
    if (file.size > 80 * 1048576) throw new Error('Archive exceeds 80 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (job !== this.job) throw new Error('Operation canceled.');
    return new Promise((resolve, reject) => {
      this.rejectJob = reject;
      const worker = new Worker(new URL('./archive.worker', import.meta.url), { type: 'module' });
      this.worker = worker;
      const cleanup = () => {
        worker.terminate();
        if (this.worker === worker) {
          this.worker = undefined;
          this.rejectJob = undefined;
        }
      };
      worker.onmessage = ({ data }) => {
        cleanup();
        if (job !== this.job) {
          reject(new Error('Operation canceled.'));
          return;
        }
        data.error ? reject(new Error(data.error)) : resolve(data.result);
      };
      worker.onerror = (e) => {
        cleanup();
        reject(new Error(e.message));
      };
      worker.postMessage({ id: 1, kind, bytes }, [bytes.buffer]);
    });
  }
  async fileAction(event: Event, fn: (file: File) => Promise<void>) {
    const job = ++this.job;
    this.storageRevision++;
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    this.busy.set(true);
    try {
      await fn(file);
    } catch (e) {
      if (job === this.job) this.status.set(String(e));
    } finally {
      if (job === this.job) this.busy.set(false);
      input.value = '';
    }
  }
  openSdk(event: Event) {
    void this.fileAction(event, async (file) => {
      const job = this.job;
      this.status.set('Extracting SDK…');
      const files = await this.archive(file, 'sdk');
      const selected = compilerSdkFiles(files);
      this.sdk = selected;
      this.sdkName.set(file.name);
      this.storageRevision++;
      try {
        await writeLocal('sdk', { name: file.name, files: selected });
        if (job === this.job) this.status.set('SDK saved on this device.');
      } catch {
        if (job === this.job)
          this.status.set('SDK ready for this session; local storage is unavailable.');
      }
    });
  }
  openZip(event: Event) {
    void this.fileAction(event, async (file) => {
      let files = (await this.archive(file, 'source')) as Record<string, Uint8Array>;
      if (!files['package.json']) {
        const paths = Object.keys(files),
          folder = paths[0]?.split('/')[0] + '/';
        if (paths.every((p) => p.startsWith(folder)))
          files = Object.fromEntries(
            Object.entries(files).map(([p, b]) => [p.slice(folder.length), b]),
          );
      }
      this.setProject(
        describeSnapshot({
          version: 1,
          owner: 'local',
          repository: file.name,
          commit: 'local',
          root: '',
          files,
        }),
      );
      this.status.set('Source archive opened.');
    });
  }
  async openFolder(event: Event) {
    const control = event.target as HTMLInputElement,
      entries = Array.from(control.files ?? []);
    if (!entries.length) return;
    const job = ++this.job;
    this.busy.set(true);
    try {
      const { folderSnapshot } = await import('./projects.ts');
      const project = await folderSnapshot(entries, () => job !== this.job);
      if (job === this.job) {
        this.setProject(project);
        this.status.set('Local project folder loaded.');
      }
    } catch (e) {
      if (job === this.job) this.status.set(String(e));
    } finally {
      if (job === this.job) this.busy.set(false);
      control.value = '';
    }
  }
  openPbw(event: Event) {
    void this.fileAction(event, async (file) => {
      const job = this.job;
      const info = (await this.archive(file, 'package')) as PackageInfo;
      if (info.kind !== 'app') throw new Error('Select an app PBW, not a firmware package.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (job !== this.job) throw new Error('Operation canceled.');
      this.built.set(bytes);
      const app = info.files['appinfo.json']
        ? JSON.parse(new TextDecoder().decode(info.files['appinfo.json']))
        : {};
      const js = info.files['pebble-js-app.js'];
      this.scriptReady.emit({
        source: js ? new TextDecoder().decode(js) : '',
        name: file.name + '/pebble-js-app.js',
        appId: app.uuid,
        messageKeys: app.appKeys,
        appInfo: app,
      });
      this.status.set(`${file.name} opened. Use Install on watch to transfer it.`);
    });
  }
  async build() {
    if (!this.project() || !this.sdk) return;
    this.busy.set(true);
    this.buildLog.set('');
    this.built.set(null);
    this.status.set('Loading compiler…');
    const platform = this.platform;
    const job = ++this.job;
    let worker: Worker | undefined;
    try {
      const result = await new Promise<any>((resolve, reject) => {
        this.rejectJob = reject;
        worker = new Worker(new URL('compiler/compiler-worker.mjs', document.baseURI), {
          type: 'module',
        });
        this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (data.id !== job || job !== this.job) return;
          if (data.type === 'progress')
            this.status.set(
              `Compiler assets: ${(data.loaded / 1048576).toFixed(1)} / ${(data.total / 1048576).toFixed(1)} MiB`,
            );
          if (data.type === 'log') {
            this.buildLog.update((s) => (s + data.message + '\n').slice(-24000));
            this.status.set('Compiling in browser…');
          }
          if (data.type === 'done') resolve(data);
          if (data.type === 'error') reject(new Error(data.message));
        };
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage({
          type: 'build',
          id: job,
          platform,
          sourceFiles: this.project()!.files,
          sdkFiles: this.sdk,
        });
      });
      if (job !== this.job) return;
      this.built.set(result.pbw);
      this.status.set(
        `Build complete · ${platform} · ${result.pbw.length} bytes · ${result.metadata.relocations.length} relocations`,
      );
    } catch (e) {
      if (job === this.job) this.status.set(String(e));
    } finally {
      worker?.terminate();
      if (job === this.job) {
        this.worker = undefined;
        this.rejectJob = undefined;
        this.busy.set(false);
      }
    }
  }
  install() {
    const bytes = this.built();
    if (bytes)
      this.packageReady.emit({ bytes, name: this.project()?.repository ?? 'Imported PBW' });
  }
  download() {
    const bytes = this.built();
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pebble-app.pbw';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  cancel() {
    this.linuxPanel?.cancel();
    this.job++;
    this.controller?.abort();
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectJob?.(new Error('Operation canceled.'));
    this.rejectJob = undefined;
    this.busy.set(false);
    this.status.set('Operation canceled.');
  }
  ngOnDestroy() {
    this.cancel();
  }
}
