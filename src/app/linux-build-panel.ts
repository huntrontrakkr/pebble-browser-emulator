import {
  Component,
  EventEmitter,
  Input,
  Output,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { parseBuildRecipe } from './build-recipe.ts';
import { safePath, type SourceSnapshot } from './projects.ts';
import { readLocal, writeLocal } from './local-store.ts';
@Component({
  selector: 'linux-build-panel',
  imports: [FormsModule],
  template: `
    <details class="linux-build">
      <summary>Linux compatibility build</summary>
      <p class="help">
        Runs custom shell, Python, Waf and native build tools inside a local Linux/Wasm image. The
        imported image must contain the tools your project needs. Network access is disabled inside
        the VM; import dependencies as files.
      </p>
      <label class="file-button"
        >Open container2wasm WASI image<input
          type="file"
          accept=".wasm"
          [disabled]="busy() || disabled"
          (change)="openImage($event)"
      /></label>
      <p class="help">
        {{ imageName() || 'No Linux build image loaded' }} · 1.5 GiB VM memory ceiling, 256 MiB
        shared files.
      </p>
      <label class="file-button"
        >Add SDK / dependency files<input
          type="file"
          multiple
          [disabled]="busy() || disabled"
          (change)="openInputs($event)"
      /></label>
      @for (name of inputNames(); track name) {
        <div class="asset-row">
          <code>/inputs/{{ name }}</code
          ><button [disabled]="busy() || disabled" (click)="removeInput(name)">Remove</button>
        </div>
      }
      <label
        >.pebble-browser.yml<textarea
          [(ngModel)]="recipe"
          rows="10"
          spellcheck="false"
          [disabled]="busy() || disabled"
        ></textarea>
      </label>
      <div class="actions">
        <button [disabled]="!project || busy() || disabled" (click)="loadRecipe()">
          Read project recipe</button
        ><button
          class="primary"
          [disabled]="!project || !image || busy() || disabled"
          (click)="build()"
        >
          Build in Linux
        </button>
        @if (busy()) {
          <button (click)="cancel()">Cancel Linux build</button>
        }
      </div>
      @if (status()) {
        <p class="status-message" role="status">{{ status() }}</p>
      }
      @if (log()) {
        <pre class="build-log" tabindex="0">{{ log() }}</pre>
      }
      @for (name of artifactNames(); track name) {
        <div class="asset-row">
          <code>{{ name }}</code
          ><button (click)="save(name)">Save artifact</button>
        </div>
      }
      @if (record) {
        <button (click)="saveRecord()">Save build record</button>
      }
    </details>
  `,
})
export class LinuxBuildPanel implements OnDestroy, OnChanges {
  @Input() project: SourceSnapshot | null = null;
  @Input() platform = 'emery';
  @Input() disabled = false;
  @Output() packageBuilt = new EventEmitter<Uint8Array>();
  @Output() busyChange = new EventEmitter<boolean>();
  image?: Uint8Array;
  imageName = signal('');
  busy = signal(false);
  status = signal('');
  log = signal('');
  inputs: Record<string, Uint8Array> = Object.create(null);
  artifacts: Record<string, Uint8Array> = Object.create(null);
  record: unknown;
  recipe =
    'version: 1\nbackend: linux-wasi\nworkdir: .\ncommands:\n  - pebble build\noutputs:\n  - build/app.pbw\ntimeoutSeconds: 600\n';
  private worker?: Worker;
  private timeout?: ReturnType<typeof setTimeout>;
  private revision = 0;
  constructor() {
    const revision = this.revision;
    void readLocal<{ name: string; bytes?: Uint8Array; blob?: Blob }>('linux-build-image')
      .then(async (saved) => {
        if (!saved) return;
        const size = saved.blob?.size ?? saved.bytes?.length ?? 0;
        if (size > 512 * 1048576) return;
        const bytes = saved.blob ? new Uint8Array(await saved.blob.arrayBuffer()) : saved.bytes;
        if (bytes && this.revision === revision) {
          this.image = bytes;
          this.imageName.set(saved.name);
        }
      })
      .catch(() => {});
  }
  ngOnChanges(changes: SimpleChanges) {
    if (!changes['project']) return;
    this.cancel();
    this.artifacts = Object.create(null);
    this.record = undefined;
    this.log.set('');
    this.status.set('');
    const bytes = this.project?.files['.pebble-browser.yml'];
    this.recipe = bytes
      ? new TextDecoder().decode(bytes)
      : 'version: 1\nbackend: linux-wasi\nworkdir: .\ncommands:\n  - pebble build\noutputs:\n  - build/app.pbw\ntimeoutSeconds: 600\n';
    if (bytes) {
      try {
        parseBuildRecipe(this.recipe);
        this.status.set('Project build recipe loaded.');
      } catch (e) {
        this.status.set(String(e));
      }
    }
  }
  inputNames() {
    return Object.keys(this.inputs);
  }
  artifactNames() {
    return Object.keys(this.artifacts);
  }
  removeInput(name: string) {
    delete this.inputs[name];
  }
  async openImage(event: Event) {
    const control = event.target as HTMLInputElement,
      file = control.files?.[0];
    if (!file) return;
    const revision = ++this.revision;
    try {
      if (file.size > 512 * 1048576) throw new Error('Build image exceeds 512 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (revision !== this.revision) return;
      this.image = bytes;
      this.imageName.set(file.name);
      this.status.set('Saving Linux image on this device…');
      try {
        // Blob storage avoids Chromium's ~127 MiB serialized IndexedDB record limit.
        await writeLocal('linux-build-image', { name: file.name, blob: new Blob([bytes]) });
        if (revision === this.revision) this.status.set('Linux image loaded.');
      } catch {
        if (revision === this.revision)
          this.status.set('Linux image loaded; this device could not save it for next time.');
      }
    } catch (e) {
      if (revision === this.revision) this.status.set(String(e));
    } finally {
      control.value = '';
    }
  }
  async openInputs(event: Event) {
    const control = event.target as HTMLInputElement,
      files = Array.from(control.files ?? []);
    const revision = ++this.revision;
    try {
      const next = { ...this.inputs };
      for (const file of files) {
        if (!safePath(file.name) || file.name === 'build.sh')
          throw new Error('Reserved or invalid input filename: ' + file.name);
        if (file.size > 256 * 1048576) throw new Error('Input file exceeds 256 MiB.');
        next[file.name] = new Uint8Array(await file.arrayBuffer());
        if (revision !== this.revision) return;
      }
      if (Object.values(next).reduce((n, b) => n + b.length, 0) > 256 * 1048576)
        throw new Error('Inputs exceed 256 MiB.');
      this.inputs = next;
    } catch (e) {
      if (revision === this.revision) this.status.set(String(e));
    } finally {
      control.value = '';
    }
  }
  loadRecipe() {
    const bytes = this.project?.files['.pebble-browser.yml'];
    if (!bytes) {
      this.status.set('No .pebble-browser.yml in this project.');
      return;
    }
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      parseBuildRecipe(source);
      this.recipe = source;
      this.status.set('Project build recipe loaded.');
    } catch (e) {
      this.status.set(String(e));
    }
  }
  build() {
    if (!this.project || !this.image || this.busy() || this.disabled) return;
    try {
      const recipe = parseBuildRecipe(this.recipe),
        revision = ++this.revision;
      this.artifacts = Object.create(null);
      this.record = undefined;
      this.log.set('');
      this.busy.set(true);
      this.busyChange.emit(true);
      this.status.set('Starting local Linux build…');
      const worker = (this.worker = new Worker(new URL('./linux-build.worker', import.meta.url), {
        type: 'module',
      }));
      this.timeout = setTimeout(() => {
        if (revision === this.revision)
          this.finish('Build exceeded ' + recipe.timeoutSeconds + ' seconds.');
      }, recipe.timeoutSeconds * 1000);
      worker.onerror = (e) => {
        if (revision === this.revision) this.finish(e.message);
      };
      worker.onmessage = ({ data }) => {
        if (revision !== this.revision || data.id !== revision) return;
        if (data.type === 'log') this.log.update((s) => (s + data.message).slice(-64000));
        if (data.type === 'error') this.finish(data.message);
        if (data.type === 'done') {
          this.artifacts = data.artifacts;
          this.record = data.record;
          const pbws = Object.entries(this.artifacts).filter(([name]) => name.endsWith('.pbw'));
          if (pbws.length === 1) this.packageBuilt.emit(pbws[0]![1]);
          this.finish('Linux build complete · ' + this.artifactNames().length + ' artifacts');
        }
      };
      worker.postMessage({
        type: 'build',
        id: revision,
        image: this.image,
        recipe: this.recipe,
        platform: this.platform,
        sourceFiles: this.project.files,
        inputs: this.inputs,
      });
    } catch (e) {
      this.finish(String(e));
    }
  }
  private finish(message: string) {
    this.revision++;
    this.worker?.terminate();
    this.worker = undefined;
    clearTimeout(this.timeout);
    this.busy.set(false);
    this.busyChange.emit(false);
    this.status.set(message);
  }
  cancel() {
    if (this.busy()) this.finish('Linux build canceled.');
  }
  private download(name: string, data: Uint8Array) {
    const url = URL.createObjectURL(new Blob([data.slice().buffer])),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  save(name: string) {
    this.download(name.split('/').at(-1)!, this.artifacts[name]!);
  }
  saveRecord() {
    this.download(
      'linux-build-record.json',
      new TextEncoder().encode(JSON.stringify(this.record, null, 2)),
    );
  }
  ngOnDestroy() {
    this.revision++;
    this.worker?.terminate();
    clearTimeout(this.timeout);
  }
}
