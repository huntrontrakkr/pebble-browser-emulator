/**
 * Minimum virtual time a button press is held before its release is passed on.
 *
 * The buttons are the watch's own and the firmware debounces them. A press and
 * release delivered inside one emulation batch advance virtual time by almost
 * nothing between them, so the firmware never observes a stable press and the
 * input is dropped. Measured against unchanged 4.37.0 on the generic Emery
 * profile: a release 10 ms after its press opens the launcher, one in the same
 * instant is lost entirely. Extending each press to a floor means no press is
 * silently lost, however briefly it was clicked.
 *
 * Time is virtual microseconds, not wall clock: the firmware only observes the
 * emulated clock, which stops while the watch is paused.
 */
export const MIN_PRESS_US = 30_000;

export class PressFloor {
  /** The mask the viewer is holding, before any extension. */
  private requested = 0;
  /** Virtual microsecond each held bit may be released at, keyed by bit. */
  private floors = new Map<number, number>();

  /** Record a new held mask. Bits newly pressed start their floor at `nowUs`. */
  request(mask: number, nowUs: number): void {
    let pressed = mask & ~this.requested;
    while (pressed) {
      const bit = pressed & -pressed;
      this.floors.set(bit, nowUs + MIN_PRESS_US);
      pressed &= pressed - 1;
    }
    this.requested = mask;
  }

  /**
   * The mask to hand the firmware: what is held, plus anything released before
   * its floor. Bits whose floor has passed are dropped as they expire.
   */
  effective(nowUs: number): number {
    let mask = this.requested;
    for (const [bit, floor] of this.floors) {
      if (floor > nowUs) mask |= bit;
      else this.floors.delete(bit);
    }
    return mask;
  }

  /** Forget everything, for a reset or a newly loaded program. */
  reset(): void {
    this.requested = 0;
    this.floors.clear();
  }
}
