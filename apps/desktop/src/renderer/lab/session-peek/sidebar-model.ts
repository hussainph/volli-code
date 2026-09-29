/**
 * VC-30 — the pure half of the sidebar-integration scratch: which peek a row
 * has, what a folder's peek shows, who may be answered, and what state a
 * row's mark carries.
 *
 * Kept apart from the view for the same reason the reducer is: these are the
 * decisions the scratch exists to make visible, and each is a rule a test can
 * pin down where a pointer could only demonstrate it once.
 */
import { displayTicketId, TICKET_STATUS_LABELS, type Ticket } from "@volli/shared";

import type {
  ActiveSessionListing,
  ActiveSessionRow,
  PreviousListingEntry,
  PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { sessionActivityDotState } from "@renderer/components/ui/session-activity-status";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { relativeTime } from "@renderer/lib/relative-time";

import type { FixtureState, SessionFixture } from "./card";
import type { CorpusSession } from "./sidebar-corpus";
import { VENDOR_LABEL } from "./sidebar-corpus";

/**
 * What hovering a ticket FOLDER shows — the question this scratch adds.
 *
 *   • `ticket` — the folder is a ticket, so it peeks the ticket: its status
 *     and title, then its Sessions with a line each on what they did. The
 *     same card a board ticket would show (the brief's "other surfaces").
 *   • `newest` — the folder stands in for its newest Session, with a pager
 *     through the rest. One card shape everywhere.
 *   • `off` — a folder is a disclosure and nothing more; expand it and peek
 *     the Sessions inside.
 */
export type FolderPeek = "ticket" | "newest" | "off";

/**
 * Where the folder row spends its trailing space: the shipped count, or the
 * marks of the vendors that worked on the ticket beside it.
 */
export type FolderFace = "count" | "marks";

const FOLDER_PREFIX = "folder:";

/** A folder's row id. Cannot collide with the listing's `chat:` / `session:` ids. */
export function folderRowId(ticketId: string): string {
  return `${FOLDER_PREFIX}${ticketId}`;
}

/** The ticket a folder row stands for, or `null` for a Session row. */
export function folderTicketId(rowId: string): string | null {
  return rowId.startsWith(FOLDER_PREFIX) ? rowId.slice(FOLDER_PREFIX.length) : null;
}

/** The listing prefixes its row ids by kind; the corpus is keyed by the bare Session id. */
export function corpusIdOf(rowId: string): string {
  return rowId.replace(/^(chat|session):/, "");
}

/** Each folder's Session row ids, newest first — the listing's own order. */
export function folderSessions(
  entries: readonly PreviousListingEntry[],
): ReadonlyMap<string, readonly string[]> {
  const folders = new Map<string, readonly string[]>();
  for (const entry of entries) {
    if (entry.kind === "ticket")
      folders.set(
        entry.id,
        entry.rows.map((row) => row.id),
      );
  }
  return folders;
}

/** Whether a row has a peek at all. Every Session does; a folder, unless folder peeks are off. */
export function canPeekRow(rowId: string, folderPeek: FolderPeek): boolean {
  return folderTicketId(rowId) === null || folderPeek !== "off";
}

/**
 * Whether a row's peek can be pinned for answering or sending.
 *
 * Never a folder: whatever it shows is read-only, and a pin must name ONE
 * recipient — an answer typed into a folder's card would have to be routed to
 * a Session the reader never pointed at. Never a Session with no one to
 * receive it (a closed terminal).
 */
export function canPinRow(rowId: string, corpus: ReadonlyMap<string, CorpusSession>): boolean {
  if (folderTicketId(rowId) !== null) return false;
  return corpus.get(corpusIdOf(rowId))?.kind === "chat";
}

/** A folder's view state: which Session it has been drilled into, and the pager's page. */
export interface FolderView {
  readonly drill: string | null;
  readonly page: number;
}

export const FOLDER_VIEW_START: FolderView = { drill: null, page: 0 };

/** How a Session card was reached from a folder, so it can offer the way back or onward. */
export type SessionVia =
  | { readonly kind: "row" }
  | { readonly kind: "drill"; readonly ticketId: string }
  | {
      readonly kind: "pager";
      readonly ticketId: string;
      readonly index: number;
      readonly count: number;
    };

/** What the card on screen is about. */
export type PeekSubject =
  | {
      readonly kind: "ticket";
      readonly ticketId: string;
      readonly sessionIds: readonly string[];
    }
  | { readonly kind: "session"; readonly rowId: string; readonly via: SessionVia };

export function peekSubject(
  rowId: string,
  folderPeek: FolderPeek,
  folders: ReadonlyMap<string, readonly string[]>,
  view: FolderView,
): PeekSubject | null {
  const ticketId = folderTicketId(rowId);
  if (ticketId === null) return { kind: "session", rowId, via: { kind: "row" } };
  const sessionIds = folders.get(ticketId) ?? [];
  if (folderPeek === "off" || sessionIds.length === 0) return null;
  if (folderPeek === "newest") {
    const index = Math.min(Math.max(view.page, 0), sessionIds.length - 1);
    return {
      kind: "session",
      rowId: sessionIds[index]!,
      via: { kind: "pager", ticketId, index, count: sessionIds.length },
    };
  }
  if (view.drill !== null && sessionIds.includes(view.drill)) {
    return { kind: "session", rowId: view.drill, via: { kind: "drill", ticketId } };
  }
  return { kind: "ticket", ticketId, sessionIds };
}

/**
 * The status a row's mark carries.
 *
 * Active rows carry the band's full vocabulary through the shipped
 * `sessionActivityDotState` — attention outranks, `interrupted` survives, the
 * rest rest. Previous rows carry nothing but a dead turn: the band is muted and
 * still, and an interrupted Session is the one fact there worth colour
 * (VC-324). A delivered answer flips a waiting row to working, which is the
 * only thing a send changes out here.
 */
export function activeMarkState(row: ActiveSessionRow, delivered: boolean): StatusDotState {
  const state = sessionActivityDotState(row.activity, { attention: row.attention !== null });
  return delivered && state === "waiting" ? "working" : state;
}

export function previousMarkState(row: PreviousSessionRow): StatusDotState | null {
  return row.activity === "interrupted" ? "interrupted" : null;
}

const FIXTURE_STATE: Partial<Record<StatusDotState, FixtureState>> = {
  working: "active",
  waiting: "waiting",
  interrupted: "failed",
};

export function fixtureStateOf(state: StatusDotState | null): FixtureState {
  return (state === null ? undefined : FIXTURE_STATE[state]) ?? "idle";
}

/** One row of the listing, in either band, with what its mark says. */
export interface ListedSession {
  readonly rowId: string;
  readonly title: string;
  readonly ticket: Ticket | null;
  readonly at: number;
  readonly state: StatusDotState | null;
}

export function listedActive(row: ActiveSessionRow, delivered: boolean): ListedSession {
  return {
    rowId: row.id,
    title: row.title,
    ticket: row.ticket,
    at: row.lastActivityAt ?? 0,
    state: activeMarkState(row, delivered),
  };
}

export function listedPrevious(row: PreviousSessionRow): ListedSession {
  return {
    rowId: row.id,
    title: row.title,
    ticket: row.ticket,
    at: row.endedOrQuietAt,
    state: previousMarkState(row),
  };
}

/** The peek card's fixture for a listed Session, built from the listing and the corpus. */
export function sessionFixture(
  listed: ListedSession,
  session: CorpusSession,
  ticketPrefix: string,
  now: number,
): SessionFixture {
  return {
    rowId: listed.rowId,
    sessionId: session.id,
    sessionTitle: listed.title,
    ticketId:
      listed.ticket === null ? null : displayTicketId(ticketPrefix, listed.ticket.ticketNumber),
    ticketTitle: listed.ticket?.title ?? null,
    ticketStage: listed.ticket === null ? null : TICKET_STATUS_LABELS[listed.ticket.status],
    recency: listed.at > 0 ? relativeTime(listed.at, now) : "",
    state: fixtureStateOf(listed.state),
    failure: session.failure,
    model: {
      providerId: session.vendor,
      providerLabel: VENDOR_LABEL[session.vendor],
      modelId: session.runs.modelId,
      label: session.runs.label,
    },
    messages: session.messages,
    lastActivity: session.summary,
    question: session.question,
  };
}

/** The Sessions the right rail lists for one ticket: its live rows, then its record. */
export function railRoster(
  listing: Pick<ActiveSessionListing, "active" | "previous">,
  ticketId: string,
): { current: readonly ActiveSessionRow[]; record: readonly PreviousSessionRow[] } {
  return {
    current: listing.active.filter((row) => row.ticket?.id === ticketId),
    record: listing.previous.filter((row) => row.ticket?.id === ticketId),
  };
}

/** Up to `limit` distinct vendors that worked on a folder, newest first — the `marks` face. */
export function folderVendors<T>(
  sessionIds: readonly string[],
  vendorOf: (rowId: string) => T | undefined,
  limit = 3,
): readonly T[] {
  const vendors: T[] = [];
  for (const id of sessionIds) {
    const vendor = vendorOf(id);
    if (vendor !== undefined && !vendors.includes(vendor)) vendors.push(vendor);
    if (vendors.length === limit) break;
  }
  return vendors;
}
