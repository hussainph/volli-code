/**
 * Which machine a Session's attachments ran on: this data directory's stable
 * host id (`host_identity`, minted on first use, a UUID v4), never the
 * runner's backend id, a hostname or a path. Boot recovery closes only the
 * attachments its own venue owns, so the id must survive a relink (a new
 * runner id over the same ledger) as well as a restart. `remote`, like every
 * host that is not the desktop's own `local`.
 */
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { RunnerIdentity } from "@volli/shared";

import { prepared } from "../db/prepared";
import { withTransaction } from "../db/transaction-gate";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** This data directory's venue, minting its host id when absent. A stored id that is not a UUID v4 fails closed. */
export function headlessRunnerVenue(
  db: Database.Database,
  mint: { newId?: () => string; now?: () => number } = {},
): RunnerIdentity {
  const id = withTransaction(db, () => {
    const row = prepared<[], { host_id: string }>(
      db,
      "SELECT host_id FROM host_identity WHERE id = 1",
    ).get();
    if (row !== undefined) {
      if (!UUID_V4.test(row.host_id))
        throw new Error("The stored host id is not a UUID v4; refusing to serve under it.");
      return row.host_id;
    }
    const minted = (mint.newId ?? randomUUID)();
    if (!UUID_V4.test(minted)) throw new Error("A minted host id must be a UUID v4.");
    prepared<[string, number]>(
      db,
      "INSERT INTO host_identity (id, host_id, created_at) VALUES (1, ?, ?)",
    ).run(minted, (mint.now ?? Date.now)());
    return minted;
  });
  return { id, kind: "remote" };
}
