/**
 * What a terminal tab knows about its own PTY tree, and the one way either strip
 * acts on it.
 *
 * Both Session strips draw the same terminal facts — the ticket's
 * (`ticket/ticket-tabs.tsx`) and the project's (`sessions/session-tabs.tsx`) —
 * and this used to live inline in one of the two `.tsx` files, which is how a
 * ticket's terminal tab ended up saying nothing at all about being parked or
 * dead while the project's said both. A `.tsx` is also the wrong shelf for it:
 * the app's coverage gate reaches extracted `.ts` modules and deliberately
 * leaves view glue outside, so logic parked in a component file is logic nobody
 * is holding to 100%.
 */
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { toastError } from "@renderer/lib/toast";
import { sessionPanes, type SessionTab } from "@renderer/stores/sessions";
import { errorMessage, type TerminalIoResult } from "@volli/shared";

/** The only vocabulary either strip needs to draw a terminal tab. */
export interface TerminalTabState {
  /** Every pane's PTY has ended. */
  exited: boolean;
  /** The first exit code found, for the hover line. */
  exitCode: number | null;
  /** Every LIVE pane is parked (issue #51 warm-park tier). */
  parked: boolean;
  /** At least one live pane is pinned out of the auto-park sweep. */
  keptAwake: boolean;
  /** The panes a park/wake/pin action runs over. Empty ⇒ no park controls. */
  livePaneIds: readonly string[];
}

/**
 * Read a tab's park/exit facts off the store's own two maps.
 *
 * `parked` is vacuously true with no live panes, which is why every reader gates
 * on `!exited` as well: an exited tab must never wear the moon badge or offer
 * "Park Now".
 */
export function terminalTabState(
  tab: SessionTab,
  parkState: Record<string, { parked: boolean; keepAwake: boolean }>,
): TerminalTabState {
  const panes = sessionPanes(tab.layout);
  const livePanes = panes.filter((pane) => pane.exitCode === null);
  return {
    exited: panes.every((pane) => pane.exitCode !== null),
    exitCode: panes.find((pane) => pane.exitCode !== null)?.exitCode ?? null,
    parked: livePanes.every((pane) => parkState[pane.sessionId]?.parked ?? false),
    keptAwake: livePanes.some((pane) => parkState[pane.sessionId]?.keepAwake ?? false),
    livePaneIds: livePanes.map((pane) => pane.sessionId),
  };
}

/**
 * The status dot a terminal tab wears, or `null` while the moon badge is
 * speaking for it instead.
 *
 * The fourth ad-hoc status map lived here, written out twice: both strips
 * painted an exited PTY at `bg-muted-foreground/30`, a running one at full
 * `bg-muted-foreground`, and the ACTIVE tab's dot in the accent — which put a
 * status dot in the same colour as the selected-tab indicator two pixels away,
 * the exact collision `ui/status-dot.tsx` exists to have ended. Liveness is a
 * fact about the Session, not about which tab is in front, so it says the same
 * thing whether or not you are looking at it.
 *
 * `parked` returns null rather than the `"parked"` tone because a parked tab
 * already draws a moon: two marks for one state, and the moon is the one that
 * explains itself.
 */
export function terminalTabDot(state: TerminalTabState): StatusDotState | null {
  if (state.exited) return "exited";
  return state.parked ? null : "idle";
}

/**
 * Runs a park/wake/pin mutation against every live pane of a tab (issue #51
 * warm-park tier) and surfaces any failure — CLAUDE.md's "never silently swallow
 * errors" applies to these fire-and-forget context-menu actions the same as any
 * other mutation. Shared by both strips, for the same reason the derivation
 * above is.
 */
export function runOnLivePanes(
  paneIds: readonly string[],
  action: (paneId: string) => Promise<TerminalIoResult>,
  failureLabel: string,
): void {
  for (const paneId of paneIds) {
    action(paneId)
      .then((result) => {
        if (!result.ok) toastError(`${failureLabel} failed: ${result.error}`);
      })
      .catch((error: unknown) => {
        toastError(`${failureLabel} failed: ${errorMessage(error)}`);
      });
  }
}
