import * as React from "react";

import { createDebouncer, type Debouncer } from "@renderer/lib/debounce";

/**
 * The three-step debouncer idiom — latest-callback ref, create-once
 * {@link createDebouncer} instance, flush-on-unmount — packaged as one hook so
 * the autosave editors don't each hand-roll it (that copy-paste produced the
 * cross-ticket autosave-bleed bug fixed in c6fd4bf).
 *
 * The returned {@link Debouncer} always calls the LATEST `fn` (which may close
 * over changing state like the current ticket/artifact) via an internal ref, so
 * a `schedule()` issued under an old render still runs the current callback.
 * The debouncer instance itself is created ONCE (its `delayMs` is captured at
 * that first creation — callers pass a constant), and its pending run is flushed
 * when the host component unmounts so the last edits are never lost.
 *
 * This is view glue (a hook wiring `createDebouncer`, whose timing logic is
 * unit-tested in debounce.test.ts) and so is deliberately outside the coverage
 * gate — see the "View glue (.tsx, hooks, …)" note in vite.config.ts.
 */
export function useDebouncedCallback(fn: () => void, delayMs: number): Debouncer {
  const fnRef = React.useRef(fn);
  React.useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const debouncerRef = React.useRef<Debouncer | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer(() => fnRef.current(), delayMs);
  }
  const debouncer = debouncerRef.current;

  React.useEffect(() => () => debouncer.flush(), [debouncer]);

  return debouncer;
}
