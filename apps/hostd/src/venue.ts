/**
 * hostd's execution venue: WHICH HOST a Session's attachments ran on, named
 * by this install's stable host id (VC-627, `docs/plans/host-identity.md`).
 *
 * Boot recovery closes only the attachments its own venue owns
 * (`closeStaleAttachments` in host-core). hostd used to name its venue after
 * the agent socket path, so an operator who moved `--socket` turned the host
 * into a stranger to its own ledger: the earlier attachments stopped
 * matching and stayed open forever. An address locates a host; it does not
 * identify one. The venue id is now `host_identity.host_id`, the VC-550
 * singleton, read once the database is open and minted on first use.
 *
 * The id is a UUID v4 from `randomUUID()`, never derived from a hostname,
 * PID, address or path. It survives restarts and socket moves; it is
 * excluded from backups, so a restored profile is a new host (and recovers
 * nothing a previous host left open, by design). A stored value that is not
 * a UUID v4 fails closed rather than being reused or replaced.
 *
 * Desktop keeps `{ id: "local", kind: "local" }`; nothing here runs there.
 * The kind stays `remote`, as before: only the id changes.
 */
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { SessionExecutionVenue } from "@volli/shared";
import { prepared } from "@volli/host-core/db/prepared";
import { withTransaction } from "@volli/host-core/db/transaction-gate";

/** hostd's venue kind, unchanged by VC-627. */
export const HOSTD_VENUE_KIND = "remote" satisfies SessionExecutionVenue["kind"];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** How a first boot allocates the host id; tests pin both. */
export interface HostIdMint {
  newId?: () => string;
  now?: () => number;
}

/** This install's host id, or null before any host use has minted one. */
export function readHostId(db: Database.Database): string | null {
  const row = prepared<[], { host_id: string }>(
    db,
    "SELECT host_id FROM host_identity WHERE id = 1",
  ).get();
  if (row === undefined) return null;
  if (!UUID_V4.test(row.host_id)) {
    throw new Error("The stored host id is not a UUID v4; refusing to serve under it.");
  }
  return row.host_id;
}

/**
 * The host id, minted into the singleton when absent. Idempotent: a stored
 * id is never overwritten, and the read and the mint are one transaction.
 */
export function ensureHostId(db: Database.Database, mint: HostIdMint = {}): string {
  return withTransaction(db, () => {
    const stored = readHostId(db);
    if (stored !== null) return stored;
    const hostId = (mint.newId ?? randomUUID)();
    if (!UUID_V4.test(hostId)) throw new Error("A minted host id must be a UUID v4.");
    prepared<[string, number]>(
      db,
      "INSERT INTO host_identity (id, host_id, created_at) VALUES (1, ?, ?)",
    ).run(hostId, (mint.now ?? Date.now)());
    return hostId;
  });
}

/** The venue every hostd Session fact and boot recovery names. */
export function hostdVenue(db: Database.Database, mint: HostIdMint = {}): SessionExecutionVenue {
  return { id: ensureHostId(db, mint), kind: HOSTD_VENUE_KIND };
}
