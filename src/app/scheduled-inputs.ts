import type { DeviceSignal } from './signals.ts';

type ScheduledSignal = { atUs: number; signal: DeviceSignal };

/** Stable ordering at both sides of a CPU quantum. At equal timestamps,
 * defaults precede explicit scenarios, then wrist gestures. Within a source,
 * retain insertion order. Host batch boundaries never choose precedence.
 */
export function mergeDueSignals(
  demo: readonly ScheduledSignal[],
  scenario: readonly ScheduledSignal[],
  gesture: readonly ScheduledSignal[],
  gestureActive: boolean,
): ScheduledSignal[] {
  return [
    ...demo.filter((event) => !gestureActive || event.signal.kind !== 'acceleration'),
    ...scenario,
    ...gesture,
  ].sort((a, b) => a.atUs - b.atUs);
}
