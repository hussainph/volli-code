/**
 * One project's export as the move sends it: the import records of every
 * importer stream (`MIGRATION_IMPORT_STREAMS`), and the plan computed from
 * them once, before anything is reserved.
 *
 * - **Records.** Each export stream's records pass as they are, except:
 *   Session events go through the backend's event encoding
 *   (`MoveSessionHistory.eventRecord`); `eventArchives` is empty (every moved
 *   event goes hot); `sessionIntake` is one row per Session at its last
 *   sequence, claimed by the move's runner. Reading them is deterministic, so
 *   a resumed step reads the same records in the same order and skips the
 *   ones the journal says landed.
 * - **Plan.** The promise `projectImports.begin` takes (per stream, the
 *   count and `MigrationDigest` of the documents the shared mapping makes),
 *   the same digests per ticket and per Session for the read-back, the
 *   objects to upload (blob bytes, legacy archives) and the Sessions whose
 *   history follows their rows.
 *
 * A record the mapping refuses, one Convex cannot store, an event out of
 * sequence or an object outside the project's keys is a {@link MovePlanError}:
 * a refused row is a lost row, so the move stops before the freeze holds
 * anything in the cloud.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import {
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  MigrationRowError,
  canonicalJson,
  legacyArchiveKey,
  migrationDocument,
  migrationRowDigest,
  projectBlobKey,
  reportableProblem,
  storageProblem,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";

import type { MigrationExportManifest } from "../migration-export/exporter";
import { legacyArchiveName } from "../migration-export/legacy-archives";
import type { StreamName } from "../migration-export/sources";
import type { StreamPromise } from "./backend";
import type { MoveObject, MovedSession } from "./ports";

type Row = Record<string, unknown>;

export const MOVE_MANIFEST_FORMAT = "volli.move-manifest/1";
const ZSTD_LEVEL = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } };

/** Why a project cannot move as it is. Codes and counts; ids of rows, never content. */
export class MovePlanError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "MovePlanError";
    this.code = code;
    this.detail = detail;
  }
}

/** An object the move uploads, and where its bytes come from. */
export type PlannedObject = MoveObject & ({ source: "blob" } | { source: "file"; file: string });

/** The count and digest of a set of documents. */
export interface Tally {
  count: number;
  digest: string;
}

export interface MovePlan {
  projectId: string;
  /** The export it was computed from. */
  exportManifestSha256: string;
  expected: StreamPromise[];
  /** Per ticket and per Session, per stream: what the read-back must find. */
  tickets: Record<string, Partial<Record<MigrationImportStream, Tally>>>;
  sessions: Record<string, Partial<Record<MigrationImportStream, Tally>>>;
  /** Moved Sessions, in export order, with their last sequence. */
  sessionList: MovedSession[];
  lastEventIds: Record<string, string | null>;
  /** Ticket numbers, for the uniqueness check. */
  ticketNumbers: number;
  objects: PlannedObject[];
  /** Records the plan saw per export stream (`sessionEvents` before encoding). */
  exported: Record<string, number>;
}

/** Which ticket or Session a document belongs to, for the per-entity digests. */
const TICKET_KEY: Partial<Record<MigrationImportStream, string>> = {
  tickets: "id",
  ticketBodies: "ticketId",
  ticketComments: "ticketId",
  ticketSignals: "ticketId",
};
const SESSION_KEY: Partial<Record<MigrationImportStream, string>> = {
  sessions: "id",
  sessionEvents: "sessionId",
  sessionIntake: "sessionId",
  eventArchives: "sessionId",
  delegations: "childSessionId",
  sessionGrants: "sessionId",
  delegationExtensions: "parentSessionId",
  readMarkers: "sessionId",
};

export function ticketKeyOf(stream: MigrationImportStream): string | undefined {
  return TICKET_KEY[stream];
}
export function sessionKeyOf(stream: MigrationImportStream): string | undefined {
  return SESSION_KEY[stream];
}

/** Every record of one export stream, chunk by chunk, line by line. */
export async function* exportRecords(
  exportDir: string,
  manifest: MigrationExportManifest,
  name: StreamName,
): AsyncGenerator<Row> {
  const stream = manifest.streams.find((entry) => entry.name === name);
  if (stream === undefined) return;
  for (const chunk of stream.chunks) {
    const lines = createInterface({
      input: createReadStream(join(exportDir, chunk.file), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) if (line !== "") yield JSON.parse(line) as Row;
  }
}

/** The context the import records need beyond the export itself. */
export interface RecordContext {
  exportDir: string;
  manifest: MigrationExportManifest;
  eventRecord: (record: Row) => Row;
  /** From the plan: the intake rows are built from it. */
  sessions: readonly MovedSession[];
  lastEventIds: Readonly<Record<string, string | null>>;
}

/** The import records of one importer stream, in the order they are sent. */
export async function* importRecords(
  context: RecordContext,
  stream: MigrationImportStream,
): AsyncGenerator<Row> {
  switch (stream) {
    case "eventArchives":
      return;
    case "sessionIntake":
      for (const session of context.sessions) {
        yield {
          sessionId: session.sessionId,
          acceptedThrough: session.lastSequence,
          lastEventId: context.lastEventIds[session.sessionId] ?? null,
        };
      }
      return;
    case "sessionEvents":
      for await (const record of exportRecords(context.exportDir, context.manifest, stream)) {
        yield context.eventRecord(record);
      }
      return;
    default:
      yield* exportRecords(context.exportDir, context.manifest, stream);
  }
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The document's digest, or a named refusal. */
function documentDigest(
  stream: MigrationImportStream,
  record: Row,
  target: MigrationTarget,
): string {
  let doc: Row;
  try {
    doc = migrationDocument(stream, record, target, 0);
  } catch (error) {
    if (!(error instanceof MigrationRowError)) throw error;
    throw new MovePlanError("row_refused", `A ${stream} row cannot move: ${error.code}.`, {
      stream,
      code: error.code,
      field: error.field,
    });
  }
  const problem = storageProblem(record);
  if (problem !== null) {
    throw new MovePlanError("row_unstorable", `A ${stream} row cannot be stored.`, {
      stream,
      problem: reportableProblem(problem),
    });
  }
  return migrationRowDigest(stream, doc);
}

const PLAN_FILE = "plan.json";

/**
 * Computes the plan from a published, verified export, or reads the one an
 * earlier run wrote (the export never changes once published). Legacy
 * archives are written beside it, compressed, to upload as they are.
 */
export async function movePlan(input: {
  workDir: string;
  exportDir: string;
  manifest: MigrationExportManifest;
  /** The sha256 of the export's `manifest.json`: a plan of another export is computed again. */
  exportManifestSha256: string;
  target: MigrationTarget;
  eventRecord: (record: Row) => Row;
  signal: AbortSignal;
}): Promise<MovePlan> {
  const planPath = join(input.workDir, PLAN_FILE);
  try {
    const saved = JSON.parse(await readFile(planPath, "utf8")) as MovePlan;
    if (saved.exportManifestSha256 === input.exportManifestSha256) return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { manifest, target } = input;
  if (manifest.projectIds.length !== 1 || manifest.profileStep) {
    throw new MovePlanError("not_one_project", "A move carries exactly one project.");
  }
  const projectId = manifest.projectIds[0]!;
  if (manifest.pendingRunnerWork !== false) {
    throw new MovePlanError("pending_runner_work", "Pending runner work does not move.");
  }

  const tickets: MovePlan["tickets"] = {};
  const sessions: MovePlan["sessions"] = {};
  const sessionList: MovedSession[] = [];
  const lastEventIds: Record<string, string | null> = {};
  const lastSequence = new Map<string, number>();
  const exported: Record<string, number> = {};
  const objects: PlannedObject[] = [];
  const entity = new Map<string, MigrationDigest>();
  let ticketNumbers = 0;
  const numbers = new Set<number>();

  const addEntity = (
    bucket: MovePlan["tickets"],
    kind: string,
    id: unknown,
    stream: MigrationImportStream,
    digest: string,
  ) => {
    if (typeof id !== "string") return;
    const key = `${kind}:${id}:${stream}`;
    let tally = entity.get(key);
    if (tally === undefined) entity.set(key, (tally = new MigrationDigest()));
    tally.add(digest);
    (bucket[id] ??= {})[stream] = { count: tally.count, digest: tally.value };
  };

  const context: RecordContext = {
    exportDir: input.exportDir,
    manifest,
    eventRecord: input.eventRecord,
    sessions: sessionList,
    lastEventIds,
  };

  const expected: StreamPromise[] = [];
  for (const stream of MIGRATION_IMPORT_STREAMS) {
    const tally = new MigrationDigest();
    for await (const record of importRecords(context, stream)) {
      input.signal.throwIfAborted();
      exported[stream] = (exported[stream] ?? 0) + 1;
      const digest = documentDigest(stream, record, target);
      tally.add(digest);
      const ticketKey = TICKET_KEY[stream];
      if (ticketKey !== undefined) addEntity(tickets, "t", record[ticketKey], stream, digest);
      const sessionKey = SESSION_KEY[stream];
      if (sessionKey !== undefined) addEntity(sessions, "s", record[sessionKey], stream, digest);
      planRecord(stream, record);
    }
    expected.push({ stream, count: tally.count, digest: tally.value });
  }
  if (expected.find((entry) => entry.stream === "projects")!.count !== 1) {
    throw new MovePlanError("not_one_project", "The export holds no project row.");
  }
  if (expected.find((entry) => entry.stream === "runnerJobs")!.count !== 0) {
    throw new MovePlanError("pending_runner_work", "Pending runner work does not move.");
  }
  for (const session of sessionList) {
    if ((lastSequence.get(session.sessionId) ?? 0) !== session.lastSequence) {
      throw new MovePlanError(
        "history_incomplete",
        "A Session's events end before its last sequence.",
        {
          sessionId: session.sessionId,
        },
      );
    }
  }

  objects.push(...(await legacyArchives(input.workDir, input.exportDir, manifest, projectId)));

  function planRecord(stream: MigrationImportStream, record: Row): void {
    switch (stream) {
      case "tickets": {
        ticketNumbers += 1;
        const number = record.number as number;
        if (numbers.has(number)) {
          throw new MovePlanError("duplicate_ticket_key", "Two tickets share a number.", {
            ticketId: record.id,
          });
        }
        numbers.add(number);
        break;
      }
      case "sessions":
        sessionList.push({
          sessionId: record.id as string,
          projectId,
          lastSequence: record.lastSequence as number,
        });
        lastEventIds[record.id as string] = null;
        break;
      case "sessionEvents": {
        const sessionId = record.sessionId as string;
        const sequence = record.sequence as number;
        if (!(sessionId in lastEventIds)) {
          throw new MovePlanError("orphan_event", "An event names no moved Session.", {
            sessionId,
          });
        }
        if (sequence !== (lastSequence.get(sessionId) ?? 0) + 1) {
          throw new MovePlanError("sequence_gap", "A Session's events are not contiguous.", {
            sessionId,
            sequence,
          });
        }
        lastSequence.set(sessionId, sequence);
        lastEventIds[sessionId] = record.id as string;
        break;
      }
      case "blobs": {
        const sha256 = record.sha256 as string;
        let key: string | null = null;
        try {
          key = projectBlobKey(projectId, sha256);
        } catch {
          // An unkeyable hash is refused below.
        }
        if (key === null || record.key !== key || record.projectId !== projectId) {
          throw new MovePlanError("object_key", "A blob is not under the moved project's keys.", {
            sha256,
          });
        }
        objects.push({ key, bytes: record.sizeBytes as number, sha256, source: "blob" });
        break;
      }
      default:
        break;
    }
  }

  const plan: MovePlan = {
    projectId,
    exportManifestSha256: input.exportManifestSha256,
    expected,
    tickets,
    sessions,
    sessionList,
    lastEventIds,
    ticketNumbers,
    objects,
    exported,
  };
  await mkdir(input.workDir, { recursive: true });
  await writeFile(`${planPath}.partial`, JSON.stringify(plan));
  await rename(`${planPath}.partial`, planPath);
  return plan;
}

/**
 * The project's legacy rows, one archive per table group, compressed into the
 * work directory: the bytes and hash the upload sends as they are. A
 * host-wide row in a project's export is refused (it belongs to the profile
 * step).
 */
async function legacyArchives(
  workDir: string,
  exportDir: string,
  manifest: MigrationExportManifest,
  projectId: string,
): Promise<PlannedObject[]> {
  const groups = new Map<string, string[]>();
  for await (const record of exportRecords(exportDir, manifest, "legacyRows")) {
    if (record.projectId !== projectId) {
      throw new MovePlanError(
        "legacy_outside_project",
        "A legacy row is not the moved project's.",
        {
          table: record.table,
        },
      );
    }
    const name = legacyArchiveName(String(record.table));
    const lines = groups.get(name) ?? [];
    lines.push(JSON.stringify(record));
    groups.set(name, lines);
  }
  const dir = join(workDir, "legacy");
  await mkdir(dir, { recursive: true });
  const objects: PlannedObject[] = [];
  for (const [name, lines] of [...groups].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`), ZSTD_LEVEL);
    const file = join(dir, `${name}.ndjson.zst`);
    await writeFile(file, bytes);
    objects.push({
      key: legacyArchiveKey(projectId, name),
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      source: "file",
      file,
    });
  }
  return objects;
}

/** The move's own manifest: what is staged at `v1/m/<moveId>/manifest.json`, and what `begin` pins. */
export function moveManifest(input: {
  moveId: string;
  target: MigrationTarget;
  exportManifestSha256: string;
  appVersion: string;
  mapperVersion: number;
  plan: MovePlan;
  staged: readonly MoveObject[];
}): { bytes: Buffer; sha256: string } {
  const text = canonicalJson({
    format: MOVE_MANIFEST_FORMAT,
    moveId: input.moveId,
    projectId: input.plan.projectId,
    target: input.target,
    exportManifestSha256: input.exportManifestSha256,
    appVersion: input.appVersion,
    mapperVersion: input.mapperVersion,
    streams: input.plan.expected,
    objects: input.plan.objects.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 })),
    staged: input.staged.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 })),
    sessions: input.plan.sessionList.length,
  });
  const bytes = Buffer.from(text);
  return { bytes, sha256: sha256Hex(bytes) };
}

/** The sha256 of a file, read as a stream. */
export async function fileSha256(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sha256: hash.digest("hex"), bytes: (await stat(path)).size };
}
