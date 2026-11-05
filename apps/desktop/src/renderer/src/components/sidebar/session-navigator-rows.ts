import { folderRowId } from "@renderer/components/session-peek/peek-subject";
/** Flat presentation model for the navigator's eventual viewport. Durable
 * ordering and grouping still come from active-session-listing. Every visible
 * item, including bands and disclosures, has one stable key and fixed extent;
 * a viewport can slice this list without walking a nested React tree.
 */
import type {
  ActiveSessionRow,
  PreviousListingEntry,
  PreviousSessionRow,
} from "./active-session-listing";

type Row =
  | { kind: "band"; band: "active" | "previous"; key: string; height: 32 }
  | { kind: "active"; band: "active"; key: string; height: 46; row: ActiveSessionRow }
  | {
      kind: "ticket";
      band: "previous";
      key: string;
      height: 32;
      entry: Extract<PreviousListingEntry, { kind: "ticket" }>;
      open: boolean;
    }
  | {
      kind: "previous";
      band: "previous";
      key: string;
      height: 32;
      row: PreviousSessionRow;
      folderId?: string;
      lastInFolder?: boolean;
    }
  | { kind: "reach"; band: "previous"; key: string; height: 28 };
export interface SessionNavigatorSelection {
  focusedId: string | null;
  selectedIds: ReadonlySet<string>;
}
export type SessionNavigatorRow = Row & { offset: number; selected: boolean; focused: boolean };
export function navigatorRowDomId(rowId: string): string {
  return `session-nav-${encodeURIComponent(rowId)}`;
}

export function sessionNavigatorRows(input: {
  active: readonly ActiveSessionRow[];
  previous: readonly PreviousListingEntry[];
  expanded: readonly string[];
  activeHeader: boolean;
  reach: boolean;
  selection?: SessionNavigatorSelection;
}): SessionNavigatorRow[] {
  const rows: SessionNavigatorRow[] = [];
  let offset = 0;
  function append(row: Row) {
    const id =
      row.kind === "active" || row.kind === "previous"
        ? row.row.id
        : row.kind === "ticket"
          ? folderRowId(row.entry.id)
          : row.key;
    rows.push({
      ...row,
      offset,
      selected: input.selection?.selectedIds.has(id) ?? false,
      focused: input.selection?.focusedId === id,
    });
    offset += row.height + 2;
  }
  if (input.activeHeader) append({ kind: "band", band: "active", key: "band:active", height: 32 });
  for (const row of input.active)
    append({ kind: "active", band: "active", key: `active:${row.id}`, height: 46, row });
  offset += 16; // the Previous band's source-list separation, not a sticky header
  append({ kind: "band", band: "previous", key: "band:previous", height: 32 });
  const open = new Set(input.expanded);
  for (const entry of input.previous) {
    if (entry.kind === "session") {
      append({
        kind: "previous",
        band: "previous",
        key: `previous:${entry.row.id}`,
        height: 32,
        row: entry.row,
      });
    } else {
      append({
        kind: "ticket",
        band: "previous",
        key: `ticket:${entry.id}`,
        height: 32,
        entry,
        open: open.has(entry.id),
      });
      if (open.has(entry.id))
        entry.rows.forEach((row, i) =>
          append({
            kind: "previous",
            band: "previous",
            key: `previous:${row.id}`,
            height: 32,
            row,
            folderId: entry.id,
            lastInFolder: i === entry.rows.length - 1,
          }),
        );
    }
  }
  if (input.reach) append({ kind: "reach", band: "previous", key: "reach:previous", height: 28 });
  return rows;
}
