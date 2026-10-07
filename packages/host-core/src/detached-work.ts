/**
 * Work a command starts and deliberately does not wait for — the Done move's
 * worktree trim is the first — still writes to the database when it finishes.
 * The reply must not wait for it, but the host's shutdown must: closing the
 * database under a pending trim loses its `worktree_trimmed` event, or throws
 * inside the detached chain after the handle is gone (VC-627).
 *
 * So the operation is handed a {@link DetachedWorkPort} and enrolls the promise
 * it started; the host owns the {@link DetachedWorkTracker} and drains it
 * before the database closes. The port is the only half an operation sees:
 * nothing that starts detached work can drain or inspect anyone else's.
 *
 * Enrolled work owns its own failure reporting — the trim keeps logging its
 * own `could not trim` line, unchanged. The tracker only observes settlement.
 * A promise that rejects anyway is reported through `reportFailure` rather
 * than swallowed, and never fails the drain.
 *
 * No deadline lives here. The host's shutdown bounds the drain with the same
 * deadline as every other shutdown task (`settleShutdownBeforeDeadline`).
 */
import { hostLogger } from "./log/root";

const log = hostLogger("detached-work");

/** What a detached operation is handed: enrol, nothing more. */
export interface DetachedWorkPort {
  /**
   * Enrols work that has already started. Returns nothing: the caller already
   * holds the promise, and the tracker's settlement handling is not a value
   * anyone should chain on.
   */
  track(work: Promise<unknown>): void;
}

/** The host's half: enrol, count and drain. */
export interface DetachedWorkTracker extends DetachedWorkPort {
  /** How many enrolled promises have not settled yet. */
  readonly pending: number;
  /**
   * Resolves once nothing enrolled is pending — including work enrolled while
   * the drain was waiting, which a single `Promise.allSettled` over a snapshot
   * would miss. Never rejects. The tracker stays usable afterwards.
   */
  drain(): Promise<void>;
}

export interface DetachedWorkTrackerOptions {
  /** Where a rejection the enrolled work did not handle itself goes. */
  reportFailure?: (error: unknown) => void;
}

function reportUnhandledDetachedFailure(error: unknown): void {
  log.error("detached work failed", { error });
}

export function createDetachedWorkTracker(
  options: DetachedWorkTrackerOptions = {},
): DetachedWorkTracker {
  const reportFailure = options.reportFailure ?? reportUnhandledDetachedFailure;
  // The observed (never-rejecting) handle, not the caller's promise, so a
  // drain awaits settlement without re-raising anything.
  const inFlight = new Set<Promise<void>>();

  return {
    track(work) {
      const observed: Promise<void> = work.then(
        () => {
          inFlight.delete(observed);
        },
        (error: unknown) => {
          inFlight.delete(observed);
          try {
            reportFailure(error);
          } catch (reportError) {
            // The observed promise must not reject before a later drain has
            // attached its handler (or leak an unhandled rejection at all).
            log.error("detached work failure reporter failed", { error: reportError });
          }
        },
      );
      inFlight.add(observed);
    },
    get pending() {
      return inFlight.size;
    },
    async drain() {
      // Re-read the set after every round: work that settles may enrol more
      // (or another caller may), and the drain is over only when it is empty.
      while (inFlight.size > 0) {
        // Every enrolled handle is observed and never rejects.
        await Promise.allSettled(inFlight);
      }
    },
  };
}
