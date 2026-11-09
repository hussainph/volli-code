/** Shared per-roster indexes for tab strips that have ids, not listing rows.
 * Store selectors may run for every update: build once per array identity,
 * then each tab/provider lookup is constant-time, including unrelated writes. */
import type { ChatSessionRecord, SessionListingRow } from "@volli/shared";

const EMPTY: ReadonlyMap<string, string | null> = new Map();
const projects = new WeakMap<readonly ChatSessionRecord[], ReadonlyMap<string, string | null>>();
const tickets = new WeakMap<readonly SessionListingRow[], ReadonlyMap<string, string | null>>();

export function projectChatProviders(
  rows: readonly ChatSessionRecord[] | undefined,
): ReadonlyMap<string, string | null> {
  if (rows === undefined) return EMPTY;
  let index = projects.get(rows);
  if (index === undefined) {
    index = new Map(rows.map((row) => [row.sessionId, row.model?.providerId ?? null]));
    projects.set(rows, index);
  }
  return index;
}

export function ticketChatProviders(
  rows: readonly SessionListingRow[] | undefined,
): ReadonlyMap<string, string | null> {
  if (rows === undefined) return EMPTY;
  let index = tickets.get(rows);
  if (index === undefined) {
    index = new Map(
      rows.flatMap((row) =>
        row.kind === "chat"
          ? [[row.record.sessionId, row.record.model?.providerId ?? null] as const]
          : [],
      ),
    );
    tickets.set(rows, index);
  }
  return index;
}
