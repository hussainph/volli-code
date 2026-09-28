/**
 * How long this machine slept, for the session watchdog (VC-86).
 *
 * A laptop closed mid-turn wakes with hours on the wall clock and no runtime
 * progress in them, and the watchdog measures silence on the wall clock. So it
 * asks this how much of a silence window the machine spent asleep and
 * subtracts it. The OS's own announcements are the source — Electron's
 * `powerMonitor` `suspend`/`resume` — because the monotonic clocks Node offers
 * were measured to keep counting across macOS sleep and cannot tell the two
 * apart (see `SuspendLedger` in `@volli/shared`, where the bookkeeping lives).
 *
 * The emitter is a port, not an import: `powerMonitor` may only be touched
 * after `app` is ready, and a port keeps this testable without Electron.
 */

import {
  EMPTY_SUSPEND_LEDGER,
  suspendLedgerResumed,
  suspendLedgerSuspended,
  suspendedMsWithin,
} from "@volli/shared";

/** The two announcements this reads; Electron's `powerMonitor` satisfies it. */
export interface PowerEvents {
  on(event: "suspend" | "resume", listener: () => void): unknown;
}

export interface SuspendClock {
  /** Milliseconds the machine was suspended inside `[from, to]`. */
  suspendedMsWithin(from: number, to: number): number;
}

export function createSuspendClock(
  power: PowerEvents,
  now: () => number = () => Date.now(),
): SuspendClock {
  let ledger = EMPTY_SUSPEND_LEDGER;
  power.on("suspend", () => {
    ledger = suspendLedgerSuspended(ledger, now());
  });
  power.on("resume", () => {
    ledger = suspendLedgerResumed(ledger, now());
  });
  return {
    suspendedMsWithin: (from, to) => suspendedMsWithin(ledger, from, to),
  };
}
