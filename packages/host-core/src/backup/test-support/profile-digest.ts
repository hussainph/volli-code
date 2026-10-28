/**
 * Count-and-digest fingerprints of a profile, for proving a backup round trip
 * (VC-988) without holding the profile in memory.
 *
 * A table's digest is over the rows a backup CARRIES — `planBackupTables` and
 * `iterateBackupRows`, the production encoder with its redactions — so a
 * source profile and the profile restored from its bundle fingerprint
 * identically when, and only when, every carried row came back. Redacted
 * values (a project's saved directory, a ticket's worktree path) are
 * redacted on both sides; the restore's own mapping is checked separately.
 *
 * Test support for the round-trip tests and the opt-in large-profile
 * rehearsal script; no production code imports it.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

import {
  createFileTranscriptArtifactStore,
  transcriptReferenceForId,
} from "../../session-runtime/transcript-artifacts";
import { iterateBackupRows, planBackupTables } from "../data-document";

export interface TableDigest {
  rows: number;
  sha256: string;
}

export interface ProfileDigest {
  /** Every carried table, by name: rows a backup carries and their digest. */
  tables: Record<string, TableDigest>;
  /** The rebuilt usage projection, every column, in key order. */
  usage: TableDigest;
  /** `blobs/<shard>/<hash>` → SHA-256 of the bytes, which must equal the name. */
  blobs: TableDigest;
  /** Transcript ids → SHA-256 of their canonical bytes. */
  transcripts: TableDigest;
}

/** Fingerprints one profile's database and artifact stores. */
export async function digestProfile(
  db: Database.Database,
  roots: { blobsRoot: string; transcriptsRoot: string },
): Promise<ProfileDigest> {
  const tables: Record<string, TableDigest> = {};
  for (const plan of planBackupTables(db)) {
    const hash = createHash("sha256");
    let rows = 0;
    for (const row of iterateBackupRows(db, plan)) {
      hash.update(JSON.stringify(row));
      hash.update("\n");
      rows += 1;
    }
    tables[plan.table] = { rows, sha256: hash.digest("hex") };
  }
  return {
    tables,
    usage: digestUsage(db),
    blobs: await digestBlobs(roots.blobsRoot),
    transcripts: await digestTranscripts(roots.transcriptsRoot),
  };
}

function digestUsage(db: Database.Database): TableDigest {
  const columns = (db.pragma("table_info(session_usage)") as { name: string }[]).map(
    (column) => `"${column.name}"`,
  );
  const hash = createHash("sha256");
  let rows = 0;
  if (columns.length > 0) {
    const cursor = db
      .prepare(`SELECT ${columns.join(", ")} FROM session_usage ORDER BY ${columns.join(", ")}`)
      .raw()
      .iterate() as IterableIterator<unknown[]>;
    for (const row of cursor) {
      hash.update(
        JSON.stringify(row, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
      hash.update("\n");
      rows += 1;
    }
  }
  return { rows, sha256: hash.digest("hex") };
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function digestBlobs(root: string): Promise<TableDigest> {
  const hash = createHash("sha256");
  let rows = 0;
  if (existsSync(root)) {
    for (const shard of readdirSync(root).toSorted()) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue;
      for (const name of readdirSync(join(root, shard)).toSorted()) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        hash.update(`${shard}/${name} ${await sha256OfFile(join(root, shard, name))}\n`);
        rows += 1;
      }
    }
  }
  return { rows, sha256: hash.digest("hex") };
}

async function digestTranscripts(root: string): Promise<TableDigest> {
  const hash = createHash("sha256");
  let rows = 0;
  if (existsSync(root)) {
    const store = createFileTranscriptArtifactStore(root);
    const ids = new Set<string>();
    for (const name of readdirSync(root)) {
      const match = /^([a-f0-9]{64})\.json(?:\.gz)?$/.exec(name);
      if (match?.[1] !== undefined) ids.add(match[1]);
    }
    for (const hex of [...ids].toSorted()) {
      const canonical = createHash("sha256");
      for await (const chunk of store.readCanonicalChunks(
        transcriptReferenceForId(`sha256:${hex}`),
      )) {
        canonical.update(chunk);
      }
      hash.update(`${hex} ${canonical.digest("hex")}\n`);
      rows += 1;
    }
  }
  return { rows, sha256: hash.digest("hex") };
}
