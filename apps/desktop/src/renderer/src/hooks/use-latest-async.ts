import * as React from "react";

/**
 * A monotonic request-token guard for async reads whose results must be applied
 * in call order — the shared replacement for the ad-hoc `cancelled`-flag and
 * `requestIdRef` idioms the per-ticket readers each hand-rolled (the Activity
 * feed, retention, Active Sessions).
 *
 * `claim()` takes the newest token at the START of a fetch; check
 * `isCurrent(token)` before applying its result and drop it if false — a later
 * `claim()` (a superseding fetch) or an `invalidate()` (effect cleanup on
 * unmount / dependency change) has since moved on.
 */
export interface LatestAsyncGuard {
  /** Take the newest token; any earlier token is now stale. Call at fetch start. */
  claim: () => number;
  /** True only while `token` is still the newest — false once superseded or invalidated. */
  isCurrent: (token: number) => boolean;
  /** Retire the current token without claiming a new one — for effect cleanup. */
  invalidate: () => void;
}

/**
 * The pure token logic behind {@link useLatestAsync}, over a private counter —
 * split out so it's unit-testable without a React renderer.
 */
export function createLatestAsyncGuard(): LatestAsyncGuard {
  let counter = 0;
  return {
    claim: () => (counter += 1),
    isCurrent: (token: number) => token === counter,
    invalidate: () => {
      counter += 1;
    },
  };
}

/**
 * A per-component {@link LatestAsyncGuard}, stable for the component's lifetime.
 * A ref (not `useMemo`, which React may discard) holds the guard so its counter
 * persists across renders, so the object is safe in effect/callback deps.
 */
export function useLatestAsync(): LatestAsyncGuard {
  const ref = React.useRef<LatestAsyncGuard | null>(null);
  return (ref.current ??= createLatestAsyncGuard());
}
