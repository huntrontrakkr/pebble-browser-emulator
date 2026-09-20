// The turn budget is wall clock, and it is armed while the constructor installs
// the trusted bootstrap as well as while guest code runs. The shipped 100 ms is
// sized for a guest turn on an idle machine; on a loaded CI runner the bootstrap
// alone can exceed it and the phone fails to construct with "interrupted".
//
// Tests therefore construct with a budget large enough that scheduler jitter
// cannot trip it, so a run measures what the test is about rather than how busy
// the runner was. A test that is about the interrupt sets its own smaller
// turnMilliseconds and still wins, because per-test limits are merged last.
// Nothing here changes the 100 ms the application itself uses.
export const TEST_LIMITS = { turnMilliseconds: 2000 };

/** Merge a test's own limits over the relaxed test budget. */
export const withTestLimits = (options = {}) => ({
  ...options,
  limits: { ...TEST_LIMITS, ...options.limits },
});
