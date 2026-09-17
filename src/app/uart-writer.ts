/** One FIFO writer for protocol transfers and scheduled hardware controls.
 * Control envelopes may only interleave between complete envelopes. */
export class UartWriter {
  private queue: { bytes: Uint8Array; offset: number; done: () => void }[] = [];
  private queuedBytes = 0;
  enqueue(bytes: Uint8Array, done: () => void = () => {}): void {
    if (this.queuedBytes + bytes.length > 1048576)
      throw new Error('Watch input queue exceeds 1 MiB.');
    this.queue.push({ bytes: bytes.slice(), offset: 0, done });
    this.queuedBytes += bytes.length;
  }
  flush(write: (bytes: Uint8Array) => number): void {
    while (this.queue.length) {
      const item = this.queue[0]!;
      const remaining = item.bytes.subarray(item.offset);
      if (remaining.length) {
        const accepted = write(remaining);
        if (!Number.isInteger(accepted) || accepted < 0 || accepted > remaining.length)
          throw new Error('Invalid UART FIFO acceptance.');
        item.offset += accepted;
        this.queuedBytes -= accepted;
        if (item.offset < item.bytes.length) return;
      }
      this.queue.shift();
      item.done();
    }
  }
  clear(): void {
    this.queue = [];
    this.queuedBytes = 0;
  }
  get pending(): boolean {
    return this.queue.length > 0;
  }
}
