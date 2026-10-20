/**
 * VC-30 (D8) — which row the left band's keyboard is on, and what each key
 * does to it.
 *
 * The band is not a flat list: Active is a run of Session rows, Previous is a
 * run of ticket FOLDERS whose Sessions appear only while the folder is open,
 * and the two are drawn by one component into one focus order. Stepping over
 * that with a DOM query would work until the day a row is drawn that the
 * keyboard must skip — a Chat Draft, which stands for no Session and has no
 * peek — so the order is a rule here instead, built from what the band is
 * about to draw.
 *
 * WHAT IS IN THE ORDER. Every row that has a peek ({@link canPeekRow}): the
 * Active band's Sessions, then, in the Previous band's own order, each
 * ungrouped Session, each folder, and — only while it is disclosed — that
 * folder's own Sessions immediately under it. One order, so ↑/↓ and J/K walk
 * the folders and their open Sessions without the reader having to know which
 * of the two they are standing in.
 *
 * WHAT IS NOT. A Chat Draft (a renderer-owned row whose Session does not exist
 * yet) and the collapsed children of a closed folder — the first has nothing to
 * peek and nothing to read, the second is not on screen. A folder's children
 * are still reported by {@link SessionBandModel.folders} whatever its
 * disclosure, because a folder's CARD lists them while the folder is shut.
 *
 * WHY THE BAND ANSWERS ITS OWN ARROW KEYS. `use-session-peek.tsx` has a
 * fallback for `→`/`←` on a folder that toggles it blindly, for a surface that
 * registered no handler of its own. This band knows whether the folder is open,
 * so `→` on an open folder and `←` on a closed one must be CONSUMED rather than
 * passed down — otherwise the fallback closes the folder the reader has just
 * asked to keep open. That is what {@link SESSION_BAND_KEY_HANDLED} is for.
 */
import { canPeekRow, folderRowId } from "@renderer/components/session-peek/peek-subject";

/** One entry of the Previous band, as the band is about to draw it. */
export type SessionBandEntry =
  /** A Session with no ticket to sit under. */
  | { readonly kind: "session"; readonly rowId: string }
  /** A ticket folder and the Sessions filed under it, newest first. */
  | {
      readonly kind: "folder";
      /** The bare ticket id — the folder's expansion key. */
      readonly ticketId: string;
      readonly rowIds: readonly string[];
    };

export interface SessionBandModel {
  /** Every row the keyboard stops on, in the order the band draws them. */
  readonly rowIds: readonly string[];
  /** Bare ticket id → that folder's Session row ids. What a folder's peek lists. */
  readonly folders: ReadonlyMap<string, readonly string[]>;
  /** Session row id → the folder it sits inside, for `←` and for revealing it. */
  readonly folderOf: ReadonlyMap<string, string>;
  /** The folders that are disclosed right now. */
  readonly open: ReadonlySet<string>;
}

export function sessionBandModel(input: {
  /** The Active band's row ids, in draw order. Drafts may be among them. */
  readonly active: readonly string[];
  readonly previous: readonly SessionBandEntry[];
  /** The ticket ids whose folders are expanded. */
  readonly expanded: readonly string[];
}): SessionBandModel {
  const open = new Set(input.expanded);
  const folders = new Map<string, readonly string[]>();
  const folderOf = new Map<string, string>();
  const rowIds: string[] = input.active.filter((rowId) => canPeekRow(rowId));
  for (const entry of input.previous) {
    if (entry.kind === "session") {
      if (canPeekRow(entry.rowId)) rowIds.push(entry.rowId);
      continue;
    }
    folders.set(entry.ticketId, entry.rowIds);
    for (const rowId of entry.rowIds) folderOf.set(rowId, entry.ticketId);
    rowIds.push(folderRowId(entry.ticketId));
    if (!open.has(entry.ticketId)) continue;
    for (const rowId of entry.rowIds) {
      if (canPeekRow(rowId)) rowIds.push(rowId);
    }
  }
  return { rowIds, folders, folderOf, open };
}

/**
 * The row one step from `rowId`, clamped at both ends.
 *
 * Clamped rather than wrapped: this list has two named bands and a reader
 * holding ↓ at the bottom of Previous is not asking to be returned to the top
 * of Active. `null` only when the band has no rows to move to at all.
 */
export function sessionBandStep(
  rowIds: readonly string[],
  rowId: string,
  delta: number,
): string | null {
  if (rowIds.length === 0) return null;
  const index = rowIds.indexOf(rowId);
  // A key pressed on a row this model does not know (a Draft) starts the walk
  // at the band's own edge rather than refusing to move.
  const from = index === -1 ? (delta > 0 ? -1 : rowIds.length) : index;
  // Clamped into a non-empty list, so the index always names a row.
  const next = Math.min(Math.max(from + delta, 0), rowIds.length - 1);
  return rowIds[next]!;
}

/** Consumed, with nothing for the band to do — see the module comment. */
export const SESSION_BAND_KEY_HANDLED = { kind: "handled" } as const;

export type SessionBandKeyAction =
  | { readonly kind: "focus-row"; readonly rowId: string }
  | { readonly kind: "toggle-folder"; readonly ticketId: string }
  | { readonly kind: "focus-folder"; readonly ticketId: string }
  | typeof SESSION_BAND_KEY_HANDLED;

/** The bare ticket id of a folder row, or `null` for a Session row. */
function folderIdOf(rowId: string, folders: ReadonlyMap<string, readonly string[]>): string | null {
  for (const ticketId of folders.keys()) {
    if (folderRowId(ticketId) === rowId) return ticketId;
  }
  return null;
}

/**
 * What one keypress on `rowId` asks the band for, or `null` when the band has
 * nothing to say about it and the peek's own keys should have it (`Space`, `U`).
 */
export function sessionBandKeyAction(
  key: string,
  rowId: string,
  band: SessionBandModel,
): SessionBandKeyAction | null {
  if (key === "ArrowDown" || key === "j" || key === "J") {
    const next = sessionBandStep(band.rowIds, rowId, 1);
    return next === null ? null : { kind: "focus-row", rowId: next };
  }
  if (key === "ArrowUp" || key === "k" || key === "K") {
    const next = sessionBandStep(band.rowIds, rowId, -1);
    return next === null ? null : { kind: "focus-row", rowId: next };
  }
  if (key !== "ArrowRight" && key !== "ArrowLeft") return null;
  const ticketId = folderIdOf(rowId, band.folders);
  if (ticketId !== null) {
    const open = band.open.has(ticketId);
    // Consumed either way: the peek's blind fallback must not toggle a folder
    // the reader asked to keep as it is.
    if (key === "ArrowRight")
      return open ? SESSION_BAND_KEY_HANDLED : { kind: "toggle-folder", ticketId };
    return open ? { kind: "toggle-folder", ticketId } : SESSION_BAND_KEY_HANDLED;
  }
  // `←` on a Session inside a folder goes back out to the folder that holds it.
  const parent = band.folderOf.get(rowId);
  if (key === "ArrowLeft" && parent !== undefined)
    return { kind: "focus-folder", ticketId: parent };
  return null;
}
