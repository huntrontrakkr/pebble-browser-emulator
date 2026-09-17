/** Only the matching phone phase may release a coupled watch quantum. */
export class ClockBarrier {
  private sequence = 0;
  private pending = new Map<number, () => void>();
  begin(): { sequence: number; done: Promise<void> } {
    const sequence = ++this.sequence;
    const done = new Promise<void>((resolve) => this.pending.set(sequence, resolve));
    return { sequence, done };
  }
  acknowledge(sequence: number): boolean {
    const resolve = this.pending.get(sequence);
    if (!resolve) return false;
    this.pending.delete(sequence);
    resolve();
    return true;
  }
  clear(): void {
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
  }
}
