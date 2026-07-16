/**
 * "Confirm before a destructive close" guard, renderer side. A one-click close
 * of a terminal session kills its PTY — and with it any foreground process
 * (coding agent, build, REPL) still running. This module probes those sessions
 * via the main-process `terminal.busy` probe and lets a UI surface interpose a
 * confirmation before it runs the actual close.
 *
 * The teardown itself still lives in session-lifecycle.ts; nothing here changes
 * what a close does — it only decides whether to run it now or after a confirm.
 */
import * as React from "react";

/** A session whose PTY is running a foreground process beyond its shell. */
export interface BusySession {
  sessionId: string;
  /** The foreground process's name (e.g. "claude", "node") — for confirm copy. */
  process: string;
}

/**
 * Probe every id in parallel and return only the ones with a live foreground
 * process. Fail-open by design: a rejected probe or an `ok: false` result
 * counts as NOT busy — a broken probe must never make a session unclosable.
 * Safe for any id (an unknown/exited session reports `busy: false`).
 */
export async function busySessionInfo(sessionIds: string[]): Promise<BusySession[]> {
  const probed = await Promise.all(
    sessionIds.map(async (sessionId): Promise<BusySession | null> => {
      try {
        const result = await window.api.terminal.busy(sessionId);
        if (result.ok && result.busy && result.process !== null) {
          return { sessionId, process: result.process };
        }
      } catch {
        // Fail-open: a thrown/rejected probe leaves the session closable.
      }
      return null;
    }),
  );
  return probed.filter((entry): entry is BusySession => entry !== null);
}

/**
 * Human-readable confirm body for a set of busy processes. `tail` is the clause
 * appended after "still running", MINUS its trailing object — the object
 * ("it"/"them") is chosen here from the count. So a `tail` of ". Closing will
 * end" yields "… still running. Closing will end it." Process names are deduped
 * for the multi-session list; the count stays the number of busy sessions.
 */
export function describeBusy(processes: string[], tail: string): string {
  if (processes.length === 1) {
    return `“${processes[0]}” is still running${tail} it.`;
  }
  const unique = [...new Set(processes)];
  return `${processes.length} terminals are still running (${unique.join(", ")})${tail} them.`;
}

/** A stashed confirm: the busy process names to name, and the close to run on confirm. */
export interface PendingClose {
  processes: string[];
  run: () => void;
}

export interface CloseGuard {
  /** Non-null while a confirm is awaiting the user; drives the dialog's open state. */
  pending: PendingClose | null;
  /** Probe `sessionIds`; run `run` immediately if idle, else stash a pending confirm. */
  guard: (sessionIds: string[], run: () => void) => void;
  /** Run the pending close and clear it. */
  confirm: () => void;
  /** Dismiss the pending close without running it. */
  cancel: () => void;
}

/**
 * Owns the local pending-confirm state for one close surface. Per the app's
 * convention (dialog open-state lives in its single opener), each opener
 * instantiates its own hook rather than sharing a global flag. A second close
 * request while a confirm is pending simply replaces the pending state.
 */
export function useCloseGuard(): CloseGuard {
  const [pending, setPending] = React.useState<PendingClose | null>(null);

  const guard = React.useCallback((sessionIds: string[], run: () => void) => {
    void busySessionInfo(sessionIds).then((busy) => {
      if (busy.length === 0) {
        run();
        return;
      }
      setPending({ processes: busy.map((entry) => entry.process), run });
    });
  }, []);

  const confirm = React.useCallback(() => {
    // Snapshot then clear: run outside the state updater so React's
    // double-invoked updaters (StrictMode) can't fire the close twice.
    pending?.run();
    setPending(null);
  }, [pending]);

  const cancel = React.useCallback(() => setPending(null), []);

  return { pending, guard, confirm, cancel };
}
