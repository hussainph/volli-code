/**
 * `registered_harnesses` table repo (migration 015): what Volli decided about a
 * bring-your-own harness manifest, and what that harness has actually been seen
 * to deliver.
 *
 * The manifest on disk is the declaration; this table holds only Volli's own
 * domain data about it — the verdict, the bytes that verdict was made about, and
 * the event ledger. Nothing here mirrors the manifest's contents, so an author
 * editing their file never fights a stale copy (see migration 015's note).
 */
import type Database from "better-sqlite3";
import { isHarnessEvent, parseHarnessId } from "@volli/shared";
import type { HarnessEvent, HarnessId, HarnessTrustVerdict } from "@volli/shared";
import { prepared } from "./prepared";

export interface RegisteredHarness {
  slug: HarnessId;
  /** Where the manifest was read from — shown in the trust confirmation, re-read at every boot. */
  manifestPath: string;
  /** SHA-256 of the manifest bytes the verdict was made about. */
  manifestSha256: string;
  decision: HarnessTrustVerdict;
  /** What the manifest claimed. Gates nothing — see {@link verifiedEvents}. */
  declaredEvents: HarnessEvent[];
  /** What has actually arrived at least once. Only these drive board moves and notifications. */
  verifiedEvents: HarnessEvent[];
  decidedAt: number;
  createdAt: number;
  updatedAt: number;
}

interface RegisteredHarnessRow {
  slug: string;
  manifest_path: string;
  manifest_sha256: string;
  decision: string;
  declared_events: string;
  verified_events: string;
  decided_at: number;
  created_at: number;
  updated_at: number;
}

/**
 * A stored event list, narrowed back to the canonical union. A row is only ever
 * written from parsed values, so anything else means the file was hand-edited —
 * in which case an unreadable list reads as empty rather than throwing at boot.
 */
function parseEventList(json: string): HarnessEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((value) => isHarnessEvent(value)) : [];
}

/** `null` for a row whose slug could no longer name a harness — a hand-edited db, not a state we write. */
function mapRegisteredHarness(row: RegisteredHarnessRow): RegisteredHarness | null {
  const slug = parseHarnessId(row.slug);
  if (slug === null) return null;
  return {
    slug,
    manifestPath: row.manifest_path,
    manifestSha256: row.manifest_sha256,
    // Migration 015's CHECK closes the vocabulary; the cast reads the column, it doesn't widen it.
    decision: row.decision as HarnessTrustVerdict,
    declaredEvents: parseEventList(row.declared_events),
    verifiedEvents: parseEventList(row.verified_events),
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getRegisteredHarness(
  db: Database.Database,
  slug: string,
): RegisteredHarness | undefined {
  const row = prepared<[string], RegisteredHarnessRow>(
    db,
    "SELECT * FROM registered_harnesses WHERE slug = ?",
  ).get(slug);
  return row ? (mapRegisteredHarness(row) ?? undefined) : undefined;
}

/** Every registered harness, whatever its verdict — the blocked ones are exactly what a settings surface must show. */
export function listRegisteredHarnesses(db: Database.Database): RegisteredHarness[] {
  const rows = prepared<[], RegisteredHarnessRow>(
    db,
    "SELECT * FROM registered_harnesses ORDER BY slug ASC",
  ).all();
  return rows
    .map((row) => mapRegisteredHarness(row))
    .filter((record) => record !== null)
    .map((record) => record);
}

export interface RecordHarnessTrustInput {
  slug: string;
  manifestPath: string;
  manifestSha256: string;
  decision: HarnessTrustVerdict;
  declaredEvents: readonly HarnessEvent[];
}

/**
 * Upserts the verdict a human just gave about a specific version of a manifest.
 *
 * A verdict recorded against DIFFERENT bytes clears the verified ledger: the
 * evidence was about a command line that no longer exists, and carrying it
 * forward would let an edited manifest inherit capabilities it has never
 * demonstrated. Re-deciding about the same bytes keeps it.
 */
export function recordHarnessTrust(
  db: Database.Database,
  input: RecordHarnessTrustInput,
  now: number,
): void {
  prepared<[string, string, string, string, string, number, number, number], unknown>(
    db,
    `INSERT INTO registered_harnesses
       (slug, manifest_path, manifest_sha256, decision, declared_events, verified_events,
        decided_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       manifest_path   = excluded.manifest_path,
       manifest_sha256 = excluded.manifest_sha256,
       decision        = excluded.decision,
       declared_events = excluded.declared_events,
       verified_events = CASE
         WHEN registered_harnesses.manifest_sha256 = excluded.manifest_sha256
         THEN registered_harnesses.verified_events
         ELSE '[]'
       END,
       decided_at      = excluded.decided_at,
       updated_at      = excluded.updated_at`,
  ).run(
    input.slug,
    input.manifestPath,
    input.manifestSha256,
    input.decision,
    JSON.stringify([...input.declaredEvents]),
    now,
    now,
    now,
  );
}

/**
 * Records that `event` has actually been delivered by `slug`. Returns whether
 * this was the first delivery — the caller uses that to announce a capability
 * exactly once, rather than on every hook fire.
 *
 * An event the manifest never declared is verified all the same: it arrived, so
 * the harness can plainly deliver it, and the ledger records what is true rather
 * than what was promised.
 */
export function markHarnessEventVerified(
  db: Database.Database,
  slug: string,
  event: HarnessEvent,
  now: number,
): boolean {
  const record = getRegisteredHarness(db, slug);
  if (record === undefined || record.verifiedEvents.includes(event)) return false;
  prepared<[string, number, string], unknown>(
    db,
    "UPDATE registered_harnesses SET verified_events = ?, updated_at = ? WHERE slug = ?",
  ).run(JSON.stringify([...record.verifiedEvents, event]), now, slug);
  return true;
}
