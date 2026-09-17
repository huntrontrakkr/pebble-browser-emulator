/** Batch observer refreshes; retain the same last N records in their original order. */
export class BufferedHistory<T> {
  private pending: T[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly limit: number;
  private readonly publish: (items: T[]) => void;
  constructor(limit: number, publish: (items: T[]) => void) {
    this.limit = limit;
    this.publish = publish;
  }
  append(item: T): void {
    this.pending.push(item);
    if (this.pending.length > this.limit) this.pending.shift();
    this.timer ??= setTimeout(() => this.flush(), 50);
  }
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const items = this.pending;
    this.pending = [];
    if (items.length) this.publish(items);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }
}
