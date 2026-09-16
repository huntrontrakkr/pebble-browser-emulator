/** Correlates one-byte wire ACKs with the phone instance that sent the message.
 * An old phone's in-flight IDs stay reserved until ACK/NACK or a watch reset.
 * There is deliberately no timer-based reuse: a late ACK has no UUID/session.
 */
export class AppMessageRouter<Owner> {
  private generation: number | undefined;
  private next = 1;
  private pending = new Map<number, { owner: Owner; transactionId: number }>();

  resetWorker(): void {
    this.generation = undefined;
    this.pending.clear();
    this.next = 1;
  }

  beginSession(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error('Invalid watch session.');
    if (generation === this.generation) return;
    this.generation = generation;
    this.pending.clear();
    this.next = 1;
  }

  allocate(generation: number, transactionId: number, owner: Owner): number | undefined {
    if (
      generation !== this.generation ||
      !Number.isInteger(transactionId) ||
      transactionId < 0 ||
      transactionId > 255 ||
      this.pending.size === 255
    )
      return;
    while (this.pending.has(this.next)) this.next = (this.next % 255) + 1;
    const wireId = this.next;
    this.next = (this.next % 255) + 1;
    this.pending.set(wireId, { owner, transactionId });
    return wireId;
  }

  settle(generation: number, wireId: number): { owner: Owner; transactionId: number } | undefined {
    if (generation !== this.generation) return;
    const pending = this.pending.get(wireId);
    if (pending) this.pending.delete(wireId);
    return pending;
  }
}
