/**
 * VC-30 — what a row peeks: a Session, a ticket folder, or nothing.
 *
 * Ported from the lab's `session-peek/sidebar-model.ts`, keeping the decisions
 * and dropping the comparisons: the lab could still switch a folder's peek
 * between its ticket, its newest Session and nothing at all, and production
 * cannot. A folder peeks its TICKET (D2), read-only, and pressing a Session in
 * that card DRILLS into that Session's own peek with the way back at the top.
 *
 * Read-only is by construction, not by omission. Nothing behind a folder can be
 * waiting on anyone (a Session asking for a person is pinned to Active —
 * VC-69), so there is no question to answer there, and a reply typed into a card
 * that lists four Sessions would have no single recipient. The same rule
 * refuses a terminal companion: it has no turns and no interactions, so there
 * is nobody to receive an answer (plan §3.5).
 */

const FOLDER_PREFIX = "folder:";

/**
 * The prefixes the shipped listing puts on a Session row's id
 * (`active-session-listing.ts`): a chat Session, or a terminal one.
 *
 * A row id with NO prefix is a Chat Draft — renderer-owned, not yet durable,
 * and standing for no Session at all — which is why {@link canPeekRow} refuses
 * it rather than opening a card about a thing that does not exist yet.
 */
const SESSION_PREFIX = /^(?:chat|session):/;

/** A folder's row id. Cannot collide with the listing's `chat:` / `session:` ids. */
export function folderRowId(ticketId: string): string {
  return `${FOLDER_PREFIX}${ticketId}`;
}

/** The ticket a folder row stands for, or `null` for anything else. */
export function folderTicketId(rowId: string): string | null {
  return rowId.startsWith(FOLDER_PREFIX) ? rowId.slice(FOLDER_PREFIX.length) : null;
}

/** The bare Session id a row stands for, or `null` when it stands for none. */
export function peekSessionId(rowId: string): string | null {
  if (!SESSION_PREFIX.test(rowId)) return null;
  return rowId.replace(SESSION_PREFIX, "");
}

/** A folder's view state: which of its Sessions it has been drilled into. */
export interface FolderPeekView {
  readonly drill: string | null;
}

export const FOLDER_PEEK_START: FolderPeekView = { drill: null };

/** How a Session card was reached, so it can offer the way back. */
export type PeekVia =
  | { readonly kind: "row" }
  | { readonly kind: "drill"; readonly ticketId: string };

/** What the card on screen is about. */
export type PeekSubject =
  | {
      readonly kind: "ticket";
      readonly ticketId: string;
      readonly sessionRowIds: readonly string[];
    }
  | { readonly kind: "session"; readonly rowId: string; readonly via: PeekVia };

/**
 * The subject of `rowId`'s peek, given each folder's Session row ids and the
 * folder view.
 *
 * `null` is "this row has no card": a Chat Draft, or a folder whose Sessions
 * the listing has not given us (an empty folder is a folder nothing is in).
 */
export function peekSubjectOf(
  rowId: string,
  folders: ReadonlyMap<string, readonly string[]>,
  view: FolderPeekView,
): PeekSubject | null {
  const ticketId = folderTicketId(rowId);
  if (ticketId === null) {
    return peekSessionId(rowId) === null ? null : { kind: "session", rowId, via: { kind: "row" } };
  }
  const sessionRowIds = folders.get(ticketId) ?? [];
  if (sessionRowIds.length === 0) return null;
  if (view.drill !== null && sessionRowIds.includes(view.drill)) {
    return { kind: "session", rowId: view.drill, via: { kind: "drill", ticketId } };
  }
  return { kind: "ticket", ticketId, sessionRowIds };
}

/** Whether a row has a peek at all: every Session and every folder, no Draft. */
export function canPeekRow(rowId: string): boolean {
  return folderTicketId(rowId) !== null || peekSessionId(rowId) !== null;
}

/**
 * Whether a row's peek can be pinned for answering or sending.
 *
 * Never a folder: whatever it shows is read-only, and a pin must name ONE
 * recipient. Never a terminal companion, and never a row whose kind we do not
 * know — a pin that cannot say who receives the words must not be offered.
 */
export function canPinRow(
  rowId: string,
  kindOf: (rowId: string) => "chat" | "terminal" | undefined,
): boolean {
  if (folderTicketId(rowId) !== null) return false;
  if (peekSessionId(rowId) === null) return false;
  return kindOf(rowId) === "chat";
}
