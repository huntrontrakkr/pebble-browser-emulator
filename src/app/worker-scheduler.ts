/** Yield to the worker's event loop without nested timers' 4 ms minimum delay. */
const queue: (() => void)[] = [];
let channel: MessageChannel | undefined;
export function yieldWorker(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => queue.shift()?.();
  }
  return new Promise((resolve) => {
    queue.push(resolve);
    channel!.port2.postMessage(null);
  });
}

/** Presentation rate is independent of guest CPU execution and virtual time. */
export class PresentationBudget {
  private last = -Infinity;
  due(now: number, changed: boolean, force = false): boolean {
    if (!force && now - this.last < (changed ? 1000 / 30 : 250)) return false;
    this.last = now;
    return true;
  }
}
