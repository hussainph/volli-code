/**
 * The verification before the commit, while the project is
 * still hidden and only the import has written there:
 *
 * (a) the backend's accumulators equal the plan's promise, stream by stream;
 * (b) a full read-back through `projectImports.readRows`, by the project,
 *     ticket and Session indexes, recomputing every stream's count and
 *     digest and every ticket's and Session's own, plus the invariants the
 *     board and the Session view rely on (ticket keys unique and below the
 *     counter, each Session's intake at its last sequence and claimed by the
 *     move's runner, events `1..last` with no gap);
 * (c) every uploaded object answers a HEAD with its length and checksum, and
 *     a sample of blobs is fetched whole and hashed again.
 *
 * The read-back runs only here: once the project has been shown, others may
 * write there, and the importer reads it only through the window's reads
 * (the real-path check). The report holds counts, digests and ids, never
 * content.
 */
import { createHash } from "node:crypto";
import {
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  migrationRowDigest,
  type MigrationImportStream,
} from "@volli/shared/cloud";

import { MoveBackendError, type ImportCalls } from "./backend";
import { sessionKeyOf, ticketKeyOf, type MovePlan, type Tally } from "./plan";
import type { MoveObjectStore } from "./ports";

type Row = Record<string, unknown>;
type Level = "project" | "ticket" | "session";

/** Where `projectImports.readRows` reads each stream from (its `LEVEL`). */
const LEVEL: Readonly<Record<MigrationImportStream, Level>> = {
  projects: "project",
  projectCounters: "project",
  projectRepos: "project",
  projectEnvironment: "project",
  configEntries: "project",
  memberProjectPrefs: "project",
  projectCheckouts: "project",
  labels: "project",
  tickets: "project",
  ticketBodies: "ticket",
  boardEvents: "project",
  ticketComments: "ticket",
  ticketSignals: "ticket",
  blobs: "project",
  blobLinks: "project",
  automations: "project",
  automationRuns: "project",
  automationArmings: "project",
  automationColumnOrder: "project",
  runnerJobs: "project",
  sessions: "project",
  sessionEvents: "session",
  eventArchives: "session",
  sessionIntake: "session",
  delegations: "session",
  sessionGrants: "session",
  delegationExtensions: "session",
  workingCopies: "project",
  readMarkers: "session",
  auditLog: "project",
};

const PAGE_ROWS = 256;
const PAGE_BYTES = 4 * 1024 * 1024;
const READ_CONCURRENCY = 8;
/** One blob in this many is fetched whole and hashed again (at least one). */
const BLOB_SAMPLE_EVERY = 100;
/** Ids a report names per mismatch, at most. */
const NAMED = 20;

export interface VerifyReport {
  ok: boolean;
  failures: string[];
  streams: Record<string, { expected: number; accumulated: number; read: number; match: boolean }>;
  mismatchedTickets: string[];
  mismatchedSessions: string[];
  /** Streams whose rows hang off a parent outside the move: counted by the backend only. */
  notReadBack: Record<string, number>;
  invariants: Record<string, number>;
  objects: { checked: number; missing: number; damaged: number; sampled: number };
}

/** Runs `work` over `items`, `limit` at a time. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

function tallyInto(
  bucket: Map<string, Map<MigrationImportStream, MigrationDigest>>,
  id: unknown,
  stream: MigrationImportStream,
  digest: string,
) {
  if (typeof id !== "string") return;
  let byStream = bucket.get(id);
  if (byStream === undefined) bucket.set(id, (byStream = new Map()));
  let tally = byStream.get(stream);
  if (tally === undefined) byStream.set(stream, (tally = new MigrationDigest()));
  tally.add(digest);
}

/** The sum of tallies: a {@link MigrationDigest} is a count and a sum mod 2^128, so they add. */
function sumOf(tallies: readonly Tally[]): Tally {
  let sum = 0n;
  let count = 0;
  for (const tally of tallies) {
    sum = (sum + BigInt(`0x${tally.digest}`)) % (1n << 128n);
    count += tally.count;
  }
  return { count, digest: sum.toString(16).padStart(32, "0") };
}

/** A session-level stream's planned tallies under the moved Sessions (the ones read back). */
function movedSessionTallies(
  plan: MovePlan,
  stream: MigrationImportStream,
  moved: ReadonlySet<string>,
): Tally[] {
  return Object.entries(plan.sessions)
    .filter(([id, streams]) => streams[stream] !== undefined && moved.has(id))
    .map(([, streams]) => streams[stream]!);
}

export async function verifyHiddenImport(input: {
  calls: ImportCalls;
  objects: MoveObjectStore;
  moveId: string;
  runnerId: string;
  plan: MovePlan;
  signal: AbortSignal;
}): Promise<VerifyReport> {
  const { calls, plan, moveId, signal } = input;
  const failures: string[] = [];
  const invariants: Record<string, number> = {};
  const bump = (name: string) => (invariants[name] = (invariants[name] ?? 0) + 1);
  const report: VerifyReport = {
    ok: false,
    failures,
    streams: {},
    mismatchedTickets: [],
    mismatchedSessions: [],
    notReadBack: {},
    invariants,
    objects: { checked: 0, missing: 0, damaged: 0, sampled: 0 },
  };

  // ---- (a) the accumulators -------------------------------------------------
  const status = await calls.status(signal, moveId);
  const accumulated = new Map(status.streams.map((stream) => [stream.stream, stream]));
  for (const promise of plan.expected) {
    const stored = accumulated.get(promise.stream);
    const match =
      stored !== undefined && stored.count === promise.count && stored.digest === promise.digest;
    report.streams[promise.stream] = {
      expected: promise.count,
      accumulated: stored?.count ?? 0,
      read: 0,
      match,
    };
    if (!match) failures.push(`${promise.stream}: the backend's accumulator is not the plan's`);
  }

  // ---- (b) the read-back ----------------------------------------------------
  const streamDigests = new Map<MigrationImportStream, MigrationDigest>(
    MIGRATION_IMPORT_STREAMS.map((stream) => [stream, new MigrationDigest()]),
  );
  const readTickets = new Map<string, Map<MigrationImportStream, MigrationDigest>>();
  const readSessions = new Map<string, Map<MigrationImportStream, MigrationDigest>>();
  const numbers = new Set<number>();
  let nextTicketNumber: number | null = null;
  const lastOf = new Map(
    plan.sessionList.map((session) => [session.sessionId, session.lastSequence]),
  );

  const onRow = (stream: MigrationImportStream, row: Row) => {
    const digest = migrationRowDigest(stream, row);
    streamDigests.get(stream)!.add(digest);
    const ticketKey = ticketKeyOf(stream);
    if (ticketKey !== undefined) tallyInto(readTickets, row[ticketKey], stream, digest);
    const sessionKey = sessionKeyOf(stream);
    if (sessionKey !== undefined) tallyInto(readSessions, row[sessionKey], stream, digest);
    switch (stream) {
      case "tickets":
        if (numbers.has(row.number as number)) bump("duplicateTicketKeys");
        numbers.add(row.number as number);
        break;
      case "projectCounters":
        nextTicketNumber = row.nextTicketNumber as number;
        break;
      case "sessionIntake": {
        const last = lastOf.get(row.sessionId as string);
        if (row.acceptedThrough !== last) bump("intakeNotAtLastSequence");
        const claim = row.claim as { runnerId?: unknown; generation?: unknown } | null;
        if (claim?.runnerId !== input.runnerId || claim.generation !== 1) bump("intakeWrongClaim");
        break;
      }
      default:
        break;
    }
  };

  /** Every page of one stream under one parent (`null` for the project). */
  const readAll = async (stream: MigrationImportStream, parentId: string | null) => {
    let cursor: string | null = null;
    let numItems = PAGE_ROWS;
    let expectSequence = 1;
    for (;;) {
      signal.throwIfAborted();
      let page;
      try {
        page = await calls.readRows(signal, {
          moveId,
          stream,
          parentId,
          cursor,
          numItems,
          maximumBytesRead: PAGE_BYTES,
        });
      } catch (error) {
        // A page of large rows can pass a query's read limit: read fewer.
        if (error instanceof MoveBackendError && error.code === "backend_error" && numItems > 1) {
          numItems = Math.max(1, Math.floor(numItems / 2));
          continue;
        }
        throw error;
      }
      for (const row of page.rows) {
        if (stream === "sessionEvents") {
          if (row.sequence !== expectSequence) bump("sessionEventGaps");
          expectSequence = (row.sequence as number) + 1;
        }
        onRow(stream, row);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (
      stream === "sessionEvents" &&
      parentId !== null &&
      expectSequence - 1 !== lastOf.get(parentId)
    ) {
      bump("sessionEventsIncomplete");
    }
  };

  const movedSessions = new Set(plan.sessionList.map((session) => session.sessionId));
  const reads: Array<[MigrationImportStream, string | null]> = [];
  for (const stream of MIGRATION_IMPORT_STREAMS) {
    const level = LEVEL[stream];
    if (level === "project") {
      reads.push([stream, null]);
      continue;
    }
    const parents = level === "ticket" ? plan.tickets : plan.sessions;
    for (const [id, streams] of Object.entries(parents)) {
      if (streams[stream] === undefined) continue;
      if (level === "session" && !movedSessions.has(id)) {
        report.notReadBack[stream] = (report.notReadBack[stream] ?? 0) + streams[stream]!.count;
        continue;
      }
      reads.push([stream, id]);
    }
    // Every Session's history and intake is read, whatever the plan expects.
    if (stream === "sessionEvents" || stream === "sessionIntake") {
      for (const session of plan.sessionList) {
        if (plan.sessions[session.sessionId]?.[stream] === undefined)
          reads.push([stream, session.sessionId]);
      }
    }
  }
  await pool(reads, READ_CONCURRENCY, ([stream, parentId]) => readAll(stream, parentId));

  for (const promise of plan.expected) {
    const read = streamDigests.get(promise.stream)!;
    const entry = report.streams[promise.stream]!;
    entry.read = read.count;
    const readBackOf = report.notReadBack[promise.stream] ?? 0;
    // Rows hanging off a parent outside the move are the backend's to count;
    // the rest must equal, row for row, what the plan holds for the parents read.
    const expected =
      readBackOf === 0 ? promise : sumOf(movedSessionTallies(plan, promise.stream, movedSessions));
    const match =
      read.count + readBackOf === promise.count &&
      read.count === expected.count &&
      read.value === expected.digest;
    if (!match) {
      entry.match = false;
      failures.push(`${promise.stream}: the read-back is not the plan's`);
    }
  }
  const compareEntities = (
    planned: MovePlan["tickets"],
    read: Map<string, Map<MigrationImportStream, MigrationDigest>>,
    named: string[],
    kind: string,
  ) => {
    let mismatched = 0;
    const ids = new Set([...Object.keys(planned), ...read.keys()]);
    for (const id of ids) {
      const want = planned[id] ?? {};
      const got = read.get(id) ?? new Map<MigrationImportStream, MigrationDigest>();
      const streams = new Set<MigrationImportStream>([
        ...(Object.keys(want) as MigrationImportStream[]),
        ...got.keys(),
      ]);
      const same = [...streams].every((stream) => {
        const expected: Tally | undefined = want[stream];
        const actual = got.get(stream);
        if (kind === "Session" && !movedSessions.has(id)) return true;
        return (
          expected !== undefined &&
          actual !== undefined &&
          expected.count === actual.count &&
          expected.digest === actual.value
        );
      });
      if (!same) {
        mismatched += 1;
        if (named.length < NAMED) named.push(id);
      }
    }
    if (mismatched > 0) failures.push(`${mismatched} ${kind}s read back differently`);
  };
  compareEntities(plan.tickets, readTickets, report.mismatchedTickets, "ticket");
  compareEntities(plan.sessions, readSessions, report.mismatchedSessions, "Session");
  if (numbers.size !== plan.ticketNumbers) bump("ticketKeysMissing");
  const counter = nextTicketNumber as number | null;
  if (counter === null || [...numbers].some((number) => number >= counter)) {
    if (numbers.size > 0) bump("ticketNumbersAtOrPastCounter");
  }

  // ---- (c) the objects ------------------------------------------------------
  const blobs = plan.objects.filter((object) => object.source === "blob");
  const sampled = new Set(
    blobs.filter((_, index) => index % BLOB_SAMPLE_EVERY === 0).map((object) => object.key),
  );
  await pool(plan.objects, READ_CONCURRENCY, async (object) => {
    signal.throwIfAborted();
    const stored = await input.objects.head(moveId, object.key);
    report.objects.checked += 1;
    if (stored === null) {
      report.objects.missing += 1;
      return;
    }
    if (
      stored.bytes !== object.bytes ||
      (stored.sha256 !== null && stored.sha256 !== object.sha256)
    ) {
      report.objects.damaged += 1;
      return;
    }
    // Fetched whole: the sample, and any object whose checksum the store did
    // not report and whose key does not name its content.
    if (
      !sampled.has(object.key) &&
      (stored.sha256 !== null || object.key.includes(object.sha256))
    ) {
      return;
    }
    const bytes = await input.objects.get(moveId, object.key);
    report.objects.sampled += 1;
    if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== object.sha256) {
      report.objects.damaged += 1;
    }
  });
  if (report.objects.missing > 0) failures.push(`${report.objects.missing} objects are missing`);
  if (report.objects.damaged > 0) failures.push(`${report.objects.damaged} objects are damaged`);

  for (const [name, count] of Object.entries(invariants)) {
    if (count > 0) failures.push(`invariant ${name}: ${count}`);
  }
  report.ok = failures.length === 0;
  return report;
}
