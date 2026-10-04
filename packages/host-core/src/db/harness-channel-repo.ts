/**
 * `harness_channel` table repo (migration 017): the two timestamps behind
 * {@link harnessChannelState} — when a harness last launched through Volli's
 * wrapper, and when one of its hooks last arrived.
 *
 * Separate from `harness-registry-repo.ts` on purpose. That table is about a
 * bring-your-own manifest — a verdict, the bytes it was made about, and a ledger
 * of claims it has honoured — and it can only ever hold rows for harnesses
 * somebody registered. This one is keyed by any harness id at all, built-in
 * included, because "is the channel working" is a question Volli's own four
 * adapters were being exempted from and should not have been.
 *
 * Nothing here reads a state. The comparison is `@volli/shared`'s and is made at
 * read time against a clock the caller supplies; storing it would make it
 * monotonic again.
 */
import type Database from "better-sqlite3";
import { parseHarnessId } from "@volli/shared";
import type { HarnessChannel, HarnessId } from "@volli/shared";
import { prepared } from "./prepared";

interface HarnessChannelRow {
  harness_id: string;
  last_launch_at: number | null;
  last_event_at: number | null;
}

/** `null` for a row whose id could no longer name a harness — a hand-edited db, not a state we write. */
function mapHarnessChannel(row: HarnessChannelRow): HarnessChannel | null {
  const harnessId = parseHarnessId(row.harness_id);
  if (harnessId === null) return null;
  return {
    harnessId,
    lastLaunchAt: row.last_launch_at,
    lastEventAt: row.last_event_at,
  };
}

/**
 * Stamps a launch this wrapper proved.
 *
 * The other column is deliberately untouched on conflict: a new launch does not
 * erase what the last one delivered, it merely moves the line the delivery is
 * compared against — which is how a channel that breaks between two launches
 * becomes visible at all.
 */
export function recordHarnessLaunch(
  db: Database.Database,
  harnessId: HarnessId,
  now: number,
): void {
  prepared<[string, number, number], unknown>(
    db,
    `INSERT INTO harness_channel (harness_id, last_launch_at, last_event_at)
     VALUES (?, ?, NULL)
     ON CONFLICT(harness_id) DO UPDATE SET last_launch_at = ?`,
  ).run(harnessId, now, now);
}

/**
 * Stamps an event that really arrived.
 *
 * Written even for a harness with no launch stamp — an event whose launch
 * predates this table, or one from a harness started outside the wrapper. It
 * cannot make that harness `reporting` on its own (a null `last_launch_at` is
 * `unproven` whatever else is true), and it is the truth about what happened.
 */
export function recordHarnessChannelEvent(
  db: Database.Database,
  harnessId: HarnessId,
  now: number,
): void {
  prepared<[string, number, number], unknown>(
    db,
    `INSERT INTO harness_channel (harness_id, last_launch_at, last_event_at)
     VALUES (?, NULL, ?)
     ON CONFLICT(harness_id) DO UPDATE SET last_event_at = ?`,
  ).run(harnessId, now, now);
}

/** Every harness the app has observed. A harness with no row has said nothing and is not listed. */
export function listHarnessChannels(db: Database.Database): HarnessChannel[] {
  return prepared<[], HarnessChannelRow>(
    db,
    "SELECT * FROM harness_channel ORDER BY harness_id ASC",
  )
    .all()
    .map((row) => mapHarnessChannel(row))
    .filter((channel) => channel !== null);
}
