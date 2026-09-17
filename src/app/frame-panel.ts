import { Component, Input, ViewChild, ElementRef, ChangeDetectorRef, inject } from '@angular/core';
import {
  compareFrames,
  decodeFrame,
  encodeFrame,
  type FrameComparison,
} from './frame-comparison.ts';
@Component({
  selector: 'frame-panel',
  template: ` <details class="frame-comparison">
    <summary>Frame comparison</summary>
    <p class="help">
      Compare a captured guest frame with a reference. Use matching firmware, app, time and inputs.
      Pixels are compared before optical effects.
    </p>
    <div class="actions">
      <button [disabled]="!frame?.length" (click)="save()">Save current frame</button
      ><label class="file-button"
        >Load reference<input
          type="file"
          accept=".pbf,.bin"
          [disabled]="!frame?.length"
          (change)="load($event)"
      /></label>
    </div>
    @if (error) {
      <p class="error" role="alert">{{ error }}</p>
    }
    @if (result) {
      <p role="status">
        <strong>{{
          result.differentPixels === 0
            ? 'Exact match'
            : result.differentPixels + ' differing pixels'
        }}</strong>
        / {{ result.pixels }} · {{ referenceName }}
      </p>
    }
    <canvas
      #difference
      [hidden]="!result"
      class="frame-difference"
      aria-label="Difference map, red pixels differ"
    ></canvas>
    @if (result) {
      <dl class="properties">
        <div>
          <dt>Expected SHA-256</dt>
          <dd class="hash">{{ result.expectedHash }}</dd>
        </div>
        <div>
          <dt>Actual SHA-256</dt>
          <dd class="hash">{{ result.actualHash }}</dd>
        </div>
      </dl>
      @if (result.firstDifference) {
        <p>
          First difference: ({{ result.firstDifference.x }}, {{ result.firstDifference.y }}),
          expected {{ result.firstDifference.expected }}, actual
          {{ result.firstDifference.actual }}.
        </p>
      }
      <button (click)="report()">Export comparison</button>
    }
  </details>`,
})
export class FramePanel {
  @Input() frame: Uint8Array | undefined;
  @Input() width = 200;
  @Input() height = 228;
  @ViewChild('difference') difference!: ElementRef<HTMLCanvasElement>;
  result: FrameComparison | null = null;
  referenceName = '';
  error = '';
  private revision = 0;
  private readonly changeDetector = inject(ChangeDetectorRef);
  private download(bytes: BlobPart, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([bytes], { type })),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  save() {
    if (this.frame)
      this.download(
        encodeFrame(this.frame, this.width, this.height) as Uint8Array<ArrayBuffer>,
        'watch-frame.pbf',
        'application/octet-stream',
      );
  }
  async load(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file || !this.frame) return;
    const revision = ++this.revision,
      actual = this.frame.slice(),
      width = this.width,
      height = this.height;
    try {
      this.error = '';
      if (file.size > 1048588) throw new Error('Reference exceeds the framebuffer limit.');
      const data = new Uint8Array(await file.arrayBuffer()),
        reference = file.name.toLowerCase().endsWith('.pbf')
          ? decodeFrame(data)
          : { bytes: data, width, height };
      if (reference.width !== width || reference.height !== height)
        throw new Error('Reference dimensions do not match the captured watch.');
      const result = await compareFrames(reference.bytes, actual, width, height);
      if (revision !== this.revision) return;
      this.result = result;
      this.referenceName = file.name;
      const canvas = this.difference.nativeElement;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(width, height);
      for (let i = 0; i < result.pixels; i++) {
        pixels.data[4 * i] = result.differences[i] ? 220 : 30;
        pixels.data[4 * i + 1] = 30;
        pixels.data[4 * i + 2] = 30;
        pixels.data[4 * i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
    } catch (e) {
      if (revision === this.revision) this.error = String(e);
    } finally {
      input.value = '';
      this.changeDetector.markForCheck();
    }
  }
  report() {
    if (this.result) {
      const { differences, ...result } = this.result;
      this.download(
        JSON.stringify({ version: 1, reference: this.referenceName, ...result }, null, 2),
        'frame-comparison.json',
        'application/json',
      );
    }
  }
}
