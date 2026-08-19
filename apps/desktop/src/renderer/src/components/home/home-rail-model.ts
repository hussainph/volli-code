/**
 * Home's rail pages (VC-55).
 *
 * The ticket workspace's rail one scope up, and deliberately its own enum
 * rather than a widening of `TicketRailMode`: the two rails answer about
 * different things (a ticket's changes and files against a project's venue and
 * its own Sessions), and `ticket-rail-model.ts` owns a persisted vocabulary
 * with its own retired pages to keep readable. One store key each, so neither
 * can rehydrate the other's page.
 *
 * The Sessions page's row shape lives here too, for the reason every pure
 * module in this renderer does: which Sessions a project's own listing holds,
 * what each one's liveness is and how they order are decisions, and a decision
 * inside a `.tsx` is a decision no test can reach.
 */
import type { ChatSessionRecord, SessionRecord } from "@volli/shared";

import type { StatusDotState } from "@renderer/components/ui/status-dot";

/** Home's rail pages. */
export type HomeRailMode = "now" | "sessions";

/** The pill's words. */
export const HOME_RAIL_MODE_LABELS: Record<HomeRailMode, string> = {
  now: "Now",
  sessions: "Sessions",
};

/** Page order in the pill, resting page first. */
export const HOME_RAIL_MODES: readonly HomeRailMode[] = ["now", "sessions"];

/** The resting page: where the Session runs, what it is, and what it has named. */
export const DEFAULT_HOME_RAIL_MODE: HomeRailMode = "now";

/**
 * Validate a rehydrated page. Persisted JSON a past build wrote can hold
 * anything, including a page this build no longer offers.
 */
export function sanitizeHomeRailMode(raw: unknown): HomeRailMode {
  return raw === "now" || raw === "sessions" ? raw : DEFAULT_HOME_RAIL_MODE;
}

/** One row of the Sessions page. */
export interface HomeSessionRow {
  id: string;
  kind: "chat" | "terminal";
  title: string;
  /** Liveness, in the app's one dot vocabulary. */
  state: StatusDotState;
  /** Newest fact about the Session — what its age is measured from. */
  at: number;
  /** Whether a tab is holding it right now. */
  open: boolean;
}

/**
 * The project's Sessions, newest first, whatever kind they are.
 *
 * One list rather than two: they are the same thing at this scope — work the
 * user started on the project itself — and splitting by execution surface would
 * ask the reader to know which kind a Session was before they could find it.
 * The leading dot and the title carry the difference.
 */
export function homeSessionRows(
  chats: readonly ChatSessionRecord[],
  terminals: readonly SessionRecord[],
  openChatIds: readonly string[],
  openTerminalIds: readonly string[],
): readonly HomeSessionRow[] {
  const rows: HomeSessionRow[] = [
    ...chats.map((row) => ({
      id: row.sessionId,
      kind: "chat" as const,
      title: row.title,
      state: chatState(row),
      at: row.lastActivityAt,
      open: openChatIds.includes(row.sessionId),
    })),
    ...terminals.map((row) => {
      // A PTY dies with the app, so a durable terminal row is live exactly
      // while a tab is holding it AND it has not ended. This listing carries a
      // terminal's durable identity, never its pulse — `stores/sessions.ts`
      // owns that and must never be read past for it.
      const open = openTerminalIds.includes(row.id);
      return {
        id: row.id,
        kind: "terminal" as const,
        title: row.title,
        state: (open && row.endedAt === null ? "ready" : "exited") as StatusDotState,
        at: row.lastActivityAt,
        open,
      };
    }),
  ];
  return rows.toSorted((left, right) => right.at - left.at);
}

/** A chat row's dot: waiting outranks working, exactly as it does on a tab. */
function chatState(row: ChatSessionRecord): StatusDotState {
  if (row.activity === "waiting") return "waiting";
  if (row.activity === "working") return "working";
  return row.live ? "ready" : "idle";
}
