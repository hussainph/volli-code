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
export type HomeRailMode = "now" | "sessions" | "files" | "search";

/** The pill's words. */
export const HOME_RAIL_MODE_LABELS: Record<HomeRailMode, string> = {
  now: "Now",
  sessions: "Sessions",
  files: "Files",
  search: "Search",
};

/** Page order in the pill, resting page first; new pages append to preserve keyboard order. */
export const HOME_RAIL_MODES: readonly HomeRailMode[] = ["now", "sessions", "files", "search"];

/** The resting page: where the Session runs, what it is, and what it has named. */
export const DEFAULT_HOME_RAIL_MODE: HomeRailMode = "now";

/**
 * Validate a rehydrated page. Persisted JSON a past build wrote can hold
 * anything, including a page this build no longer offers.
 */
export function sanitizeHomeRailMode(raw: unknown): HomeRailMode {
  // Membership in the page list rather than a hand-written disjunction: a page
  // added to the pill must not need a second edit here to survive a relaunch.
  return typeof raw === "string" && (HOME_RAIL_MODES as readonly string[]).includes(raw)
    ? (raw as HomeRailMode)
    : DEFAULT_HOME_RAIL_MODE;
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
  /**
   * Whether this row is a door back to the Session, or only a record that it
   * happened.
   *
   * A chat always is: its transcript is durable, so a closed one is re-adopted
   * and given a tab. A TERMINAL only is while a tab still holds it — a PTY dies
   * with the app and with its own close, so a closed terminal row has nothing
   * behind it to bring forward. That has to reach the DOM rather than being
   * absorbed by a handler that quietly does nothing: `ui/list-row.tsx` draws an
   * inert row for `onActivate: null`, and a row that hovers and depresses and
   * then goes nowhere is, in that file's own words, a lie the pointer tells.
   */
  reopenable: boolean;
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
      // Durable history, so a closed one is a door like any other.
      reopenable: true,
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
        reopenable: open,
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

/**
 * How many trailing segments of a venue path the rail's card shows.
 *
 * Two, because that is what tells the two venues apart: a main checkout ends
 * `…/code/volli-code` and a worktree ends `…/volli-code-f3732f45/VC-81-auto-title`,
 * and the segment above the last is what says which kind of place this is.
 */
const VENUE_PATH_SEGMENTS = 2;

/**
 * A venue path shortened from the FRONT.
 *
 * `truncate` cuts the end, which on a path is precisely the part worth reading:
 * `/Users/phalasiya/Desktop/cod…` names the person and hides the project. Every
 * path this card shows starts with the same home prefix and differs at its
 * tail, so the tail is what it shows — with the whole path one hover away.
 */
export function venuePathTail(path: string, segments: number = VENUE_PATH_SEGMENTS): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}
