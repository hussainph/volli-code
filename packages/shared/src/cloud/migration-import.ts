/**
 * The importer half of the SQLite → Volli Cloud migration: how one record of
 * a migration export (`@volli/host-core`'s exporter, `volli.migration-export/1`)
 * becomes one backend document, and the digests the verifier compares.
 *
 * Pure and Convex-independent, so the backend's `migration` mutations and the
 * dry-run harness that verifies them apply the SAME mapping: the harness
 * computes the documents it expects, the backend stores the documents it
 * computed, and the two sides are reconciled by count and by an
 * order-independent digest per table.
 *
 * Rules:
 *
 * - **Ids are carried verbatim** and must be our canonical UUIDs. A row whose
 *   id is not is refused, never re-minted.
 * - **Placeholders become the target's ids.** The exporter cannot know which
 *   person, Workspace and runner the import lands under, so it writes
 *   {@link MIGRATION_PLACEHOLDERS}; {@link resolvePlaceholders} replaces every
 *   whole string value equal to one of them.
 * - **Every field the backend needs and the local database does not decide
 *   gets an explicit default here** (a project's ship behaviour, a Session's
 *   open status, a Working copy's clean diff). Field TYPES are checked by the
 *   backend's schema validator on insert; this module checks ids and the
 *   value-level rules a validator cannot express.
 * - **Server-stamped fields** ({@link MIGRATION_STAMPED_FIELDS}) are set from
 *   `importedAt` and excluded from digests, because each side stamps its own.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { isUuid } from "./ids";
import { jobRank, type JobPriority } from "./jobs";

/** Stand-ins the exporter writes for identities only the import knows. Durable: exports carry them. */
export const MIGRATION_PLACEHOLDERS = Object.freeze({
  /** The migrating person's cloud user id. */
  userId: "$local-user",
  /** The runner id this Mac is registered as. */
  runnerId: "$local-runner",
  /** The Workspace the projects are imported into. */
  workspaceId: "$target-workspace",
} as const);

/** Who and where an import lands. */
export interface MigrationTarget {
  userId: string;
  workspaceId: string;
  runnerId: string;
}

/** The format marker of a Session event archive object (`ev/…ndjson.zst`). */
export const SESSION_EVENT_ARCHIVE_FORMAT = "volli.session-events/1";

/** An event payload larger than this is spilled to `…/e/{sequence}.json.zst`; the stored payload names it. */
export const SESSION_EVENT_INLINE_MAX_BYTES = 256 * 1024;

/** The largest document the importer writes; the backend's hard limit is 1 MiB. */
export const MIGRATION_DOCUMENT_MAX_BYTES = 1024 * 1024 - 4 * 1024;

/**
 * The streams the importer writes, in the order it writes them:
 * projects and their side tables, the board, Automations, Sessions with their
 * history, then Working copies and personal markers. `eventArchives` and
 * `sessionIntake` are not export streams: the importer builds them while it
 * reads `sessionEvents`.
 */
export const MIGRATION_IMPORT_STREAMS = [
  "projects",
  "projectCounters",
  "projectRepos",
  "projectEnvironment",
  "configEntries",
  "memberProjectPrefs",
  "projectCheckouts",
  "labels",
  "tickets",
  "ticketBodies",
  "boardEvents",
  "ticketComments",
  "ticketSignals",
  "blobs",
  "blobLinks",
  "automations",
  "automationRuns",
  "automationArmings",
  "automationColumnOrder",
  "runnerJobs",
  "sessions",
  "sessionEvents",
  "eventArchives",
  "sessionIntake",
  "delegations",
  "sessionGrants",
  "delegationExtensions",
  "workingCopies",
  "readMarkers",
  "auditLog",
] as const;
export type MigrationImportStream = (typeof MIGRATION_IMPORT_STREAMS)[number];

/** Export streams the importer does not write yet, with the reason the report shows. */
export const MIGRATION_DEFERRED_STREAMS: Readonly<Record<string, string>> = Object.freeze({
  automationScheduleCursors:
    "a schedule's next fire time needs the Automations port's scheduler; carried in the export",
});

/**
 * Fields each side stamps for itself, never digested: the import times (set
 * from `importedAt`) and a project's `moveState`, which only the backend's
 * person-authorized import writes (`importing` until its commit).
 */
export const MIGRATION_STAMPED_FIELDS: Readonly<
  Partial<Record<MigrationImportStream, readonly string[]>>
> = Object.freeze({
  projects: ["moveState"],
  sessionEvents: ["acceptedAt"],
  sessionIntake: ["lastAcceptedAt"],
});

/** Why a record could not become a document. */
export type MigrationRowErrorCode = "invalid_id" | "invalid_field" | "unstorable";

/** A record the mapping refuses. The message names the field, never its value. */
export class MigrationRowError extends Error {
  readonly code: MigrationRowErrorCode;
  readonly field: string;

  // Assigned in the body: this package runs under Node's type stripping in
  // repo scripts, which cannot erase parameter properties.
  constructor(code: MigrationRowErrorCode, field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = "MigrationRowError";
    this.code = code;
    this.field = field;
  }
}

type Doc = Record<string, unknown>;

// ---- placeholders -----------------------------------------------------------

/** `value` with every string equal to a placeholder replaced by the target's id. */
export function resolvePlaceholders<T>(value: T, target: MigrationTarget): T {
  if (typeof value === "string") {
    if (value === MIGRATION_PLACEHOLDERS.userId) return target.userId as T;
    if (value === MIGRATION_PLACEHOLDERS.runnerId) return target.runnerId as T;
    if (value === MIGRATION_PLACEHOLDERS.workspaceId) return target.workspaceId as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, target)) as T;
  if (value !== null && typeof value === "object") {
    const out: Doc = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolvePlaceholders(item, target);
    return out as T;
  }
  return value;
}

// ---- storability ------------------------------------------------------------

/** The backend's value limits: nesting depth, array length, object size, field names. */
const MAX_DEPTH = 16;
const MAX_ARRAY = 8192;
const MAX_FIELDS = 1024;
const MAX_FIELD_NAME = 1024;
// Non-control ASCII, not starting with `$`.
const FIELD_NAME = /^[\x20-\x23\x25-\x7e][\x20-\x7e]*$/;

/**
 * Why the backend could not store `value` as a document field, or null. A
 * reason names the rule and the path to the first offending place, never a
 * value, so it is safe in a report.
 */
export function storageProblem(value: unknown): string | null {
  const walk = (node: unknown, path: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) return `nested deeper than ${MAX_DEPTH} at ${path}`;
    if (Array.isArray(node)) {
      if (node.length > MAX_ARRAY) return `array longer than ${MAX_ARRAY} at ${path}`;
      for (const [index, item] of node.entries()) {
        const problem = walk(item, `${path}[${index}]`, depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node);
      if (entries.length > MAX_FIELDS)
        return `object with more than ${MAX_FIELDS} fields at ${path}`;
      for (const [key, item] of entries) {
        if (key.length > MAX_FIELD_NAME || !FIELD_NAME.test(key)) {
          return `field name the backend refuses at ${path}`;
        }
        const problem = walk(item, `${path}.${key}`, depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    if (typeof node === "number" && !Number.isFinite(node)) return `non-finite number at ${path}`;
    return null;
  };
  return walk(value, "$", 0);
}

/**
 * A {@link storageProblem} reason cut to the rule and the top-level field. The
 * path below it is built from the value's own keys, which may be content (a
 * map keyed by file path), so a report never carries it.
 */
export function reportableProblem(problem: string): string {
  const match = / at \$(?:\.([^.[]+))?/.exec(problem);
  if (match === null) return problem;
  const rule = problem.slice(0, match.index);
  return match[1] === undefined ? rule : `${rule} in ${match[1]}`;
}

/** The UTF-8 length of `value` as JSON. */
export function jsonBytes(value: unknown): number {
  return utf8ToBytes(JSON.stringify(value) ?? "null").length;
}

// ---- digests ----------------------------------------------------------------

/** JSON with object keys in code-point order and `undefined` fields omitted. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Doc;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .toSorted();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 hex of the canonical JSON of `doc`, without the stream's stamped fields. */
export function migrationRowDigest(stream: MigrationImportStream, doc: Doc): string {
  const stamped = MIGRATION_STAMPED_FIELDS[stream] ?? [];
  const kept: Doc = {};
  for (const [key, value] of Object.entries(doc)) if (!stamped.includes(key)) kept[key] = value;
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(kept))));
}

const DIGEST_MODULUS = 1n << 128n;

/** What a {@link MigrationDigest}'s `value` looks like: 128 bits as 32 lowercase hex digits. */
export const MIGRATION_DIGEST_VALUE = /^[0-9a-f]{32}$/;

/**
 * An order-independent digest of a multiset of rows: the count, and the sum
 * modulo 2^128 of each row digest's first 128 bits. Unlike XOR, a row present
 * twice does not cancel out.
 */
export class MigrationDigest {
  count = 0;
  private sum = 0n;

  /**
   * A digest that continues from a stored `count` and `value`, so a table's
   * digest can be accumulated batch by batch (the backend's per-stream
   * accumulators). Refuses a value that is not 32 lowercase hex digits.
   */
  static resume(count: number, value: string): MigrationDigest {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("a digest count is a non-negative integer");
    }
    if (!MIGRATION_DIGEST_VALUE.test(value)) {
      throw new RangeError("a digest value is 32 lowercase hex digits");
    }
    const digest = new MigrationDigest();
    digest.count = count;
    digest.sum = BigInt(`0x${value}`);
    return digest;
  }

  add(rowDigest: string): void {
    this.count += 1;
    this.sum = (this.sum + BigInt(`0x${rowDigest.slice(0, 32)}`)) % DIGEST_MODULUS;
  }

  get value(): string {
    return this.sum.toString(16).padStart(32, "0");
  }
}

// ---- record → document ------------------------------------------------------

function fail(code: MigrationRowErrorCode, field: string, detail: string): never {
  throw new MigrationRowError(code, field, detail);
}

function asRecord(value: unknown): Doc {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_field", "record", "is not an object");
  }
  return value as Doc;
}

function requireId(record: Doc, field: string): string {
  if (!isUuid(record[field])) fail("invalid_id", field, "is not a canonical UUID");
  return record[field] as string;
}

function nullableId(record: Doc, field: string): string | null {
  const value = record[field] ?? null;
  if (value !== null && !isUuid(value)) fail("invalid_id", field, "is not a canonical UUID");
  return value as string | null;
}

/** `fields` copied from `record`, an absent one as null. */
function pick(record: Doc, fields: readonly string[]): Doc {
  const out: Doc = {};
  for (const field of fields) out[field] = record[field] ?? null;
  return out;
}

const DELETION = { deletedAt: null, purgeAfter: null } as const;

type Mapper = (record: Doc, target: MigrationTarget, importedAt: number) => Doc;

const MAPPERS: Readonly<Record<MigrationImportStream, Mapper>> = {
  projects(record) {
    for (const field of ["id", "workspaceId", "createdByUserId"]) requireId(record, field);
    // `removedAt` is export-only: the importer decides whether a removed project comes along.
    return {
      ...pick(record, [
        "id",
        "workspaceId",
        "name",
        "colorIndex",
        "ticketPrefix",
        "origin",
        "countsTowardCap",
        "createdByUserId",
        "createdAt",
        "updatedAt",
        "archivedAt",
      ]),
      description: "",
      iconKey: null,
      // A migrated project has no GitHub repo until the App connects one: commit only (P2 Q12).
      shipBehaviour: "commit",
      customShipPrompt: null,
      coAuthorDefault: true,
      ...DELETION,
    };
  },
  projectCounters(record) {
    requireId(record, "projectId");
    return pick(record, ["projectId", "nextTicketNumber", "boardSeq"]);
  },
  projectRepos(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    return pick(record, [
      "id",
      "projectId",
      "role",
      "position",
      "provider",
      "githubRepoId",
      "installationId",
      "owner",
      "name",
      "baseBranch",
      "defaultBranchCache",
      "dirName",
    ]);
  },
  projectEnvironment(record) {
    requireId(record, "projectId");
    // A legacy setup command was written for, and has only ever run on, this Mac.
    const legacy = record.storedSetup !== null && record.storedSetup !== undefined;
    return {
      ...pick(record, ["projectId", "storedSetup", "storedResume", "storedSetupMode", "revision"]),
      setupTimeoutSec: 1200,
      resumeWaitSec: 10,
      runsOn: legacy ? ["mac"] : ["mac", "linux", "cloud"],
      requiresOs: legacy ? "macos" : "any",
    };
  },
  configEntries(record) {
    requireId(record, "id");
    const userId = nullableId(record, "userId");
    const projectId = nullableId(record, "projectId");
    nullableId(record, "workspaceId");
    let scopeKey: string;
    if (record.level === "personal" && userId !== null) scopeKey = `u:${userId}`;
    else if (record.level === "project" && projectId !== null) scopeKey = `p:${projectId}`;
    else fail("invalid_field", "level", "does not match the ids beside it");
    return {
      ...pick(record, [
        "id",
        "level",
        "userId",
        "workspaceId",
        "projectId",
        "kind",
        "name",
        "state",
        "definition",
        "revision",
        "updatedBy",
        "updatedAt",
      ]),
      scopeKey,
      bundleKey: null,
      digest: null,
      required: null,
    };
  },
  memberProjectPrefs(record) {
    requireId(record, "userId");
    requireId(record, "projectId");
    return pick(record, [
      "userId",
      "projectId",
      "commitEmail",
      "coAuthor",
      "railPosition",
      "themeCanvas",
      "themeAppearance",
    ]);
  },
  projectCheckouts(record) {
    for (const field of ["runnerId", "projectId", "projectRepoId"]) requireId(record, field);
    return pick(record, [
      "runnerId",
      "projectId",
      "projectRepoId",
      "kind",
      "headBranch",
      "reportedAt",
    ]);
  },
  labels(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    nullableId(record, "mergedIntoId");
    return pick(record, [
      "id",
      "projectId",
      "name",
      "nameKey",
      "color",
      "mergedIntoId",
      "mergedAt",
      "mergedBy",
      "createdAt",
      "updatedAt",
    ]);
  },
  tickets(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    nullableId(record, "assigneeUserId");
    nullableId(record, "placeRunnerId");
    const labelIds = record.labelIds;
    if (!Array.isArray(labelIds) || !labelIds.every(isUuid)) {
      fail("invalid_id", "labelIds", "holds a value that is not a canonical UUID");
    }
    return {
      ...pick(record, [
        "id",
        "projectId",
        "number",
        "title",
        "status",
        "priority",
        "position",
        "labelIds",
        "assigneeUserId",
        "checkoutMode",
        "preferredHarnessId",
        "branch",
        "baseBranch",
        "pullRequests",
        "retentionKeep",
        "placeRunnerId",
        "createdBy",
        "createdAt",
        "updatedAt",
        "archivedAt",
      ]),
      ...DELETION,
    };
  },
  ticketBodies(record) {
    requireId(record, "ticketId");
    return pick(record, ["ticketId", "body", "revision", "updatedBy", "updatedAt"]);
  },
  boardEvents(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    nullableId(record, "ticketId");
    return pick(record, [
      "id",
      "projectId",
      "ticketId",
      "seq",
      "kind",
      "actor",
      "occurredAt",
      "payload",
    ]);
  },
  ticketComments(record) {
    for (const field of ["id", "ticketId", "projectId"]) requireId(record, field);
    nullableId(record, "sessionId");
    return pick(record, [
      "id",
      "ticketId",
      "projectId",
      "sessionId",
      "author",
      "body",
      "createdAt",
      "editedAt",
      "deletedAt",
    ]);
  },
  ticketSignals(record) {
    for (const field of ["id", "ticketId", "projectId"]) requireId(record, field);
    nullableId(record, "sessionId");
    return pick(record, [
      "id",
      "ticketId",
      "projectId",
      "sessionId",
      "actor",
      "kind",
      "verdict",
      "detail",
      "createdAt",
    ]);
  },
  blobs(record) {
    requireId(record, "projectId");
    return pick(record, [
      "projectId",
      "sha256",
      "mime",
      "sizeBytes",
      "originalName",
      "width",
      "height",
      "key",
      "uploadedBy",
      "createdAt",
    ]);
  },
  blobLinks(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    requireId(asRecord(record.owner), "id");
    return pick(record, ["id", "projectId", "sha256", "owner", "label", "createdAt"]);
  },
  automations(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    return pick(record, [
      "id",
      "projectId",
      "name",
      "instructions",
      "runtime",
      "triggerSpec",
      "createdBy",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
  },
  automationRuns(record) {
    requireId(record, "id");
    requireId(record, "projectId");
    for (const field of ["automationId", "ticketId", "sessionId", "armedByUserId", "runnerId"]) {
      nullableId(record, field);
    }
    return {
      ...pick(record, [
        "id",
        "automationId",
        "automationName",
        "projectId",
        "ticketId",
        "sessionId",
        "trigger",
        "status",
        "skipReason",
        "missedCount",
        "dueAt",
        "model",
        "attendance",
        "armedByUserId",
        "runnerId",
        "createdAt",
      ]),
      // A failed arrival keeps its error and the key a Retry replays under.
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(typeof record.retryCommandId === "string"
        ? { retryCommandId: record.retryCommandId }
        : {}),
    };
  },
  automationArmings(record) {
    for (const field of ["projectId", "automationId", "armedByUserId", "runnerId"]) {
      requireId(record, field);
    }
    return pick(record, [
      "projectId",
      "status",
      "automationId",
      "armedByUserId",
      "runnerId",
      "armedAt",
    ]);
  },
  automationColumnOrder(record) {
    requireId(record, "projectId");
    return pick(record, ["projectId", "status", "rankedIds", "orderedAt"]);
  },
  runnerJobs(record) {
    for (const field of ["id", "runnerId", "projectId"]) requireId(record, field);
    for (const field of ["sessionId", "ticketId", "workingCopyId"]) nullableId(record, field);
    return {
      ...pick(record, [
        "id",
        "runnerId",
        "kind",
        "projectId",
        "sessionId",
        "ticketId",
        "workingCopyId",
        "payload",
        "priority",
        "createdBy",
        "createdAt",
        "availableAt",
      ]),
      commandId: null,
      rank: jobRank(record.priority as JobPriority),
      status: "queued",
      lease: null,
      receipt: null,
      result: null,
      completedAt: null,
      expiresAt: null,
    };
  },
  sessions(record) {
    for (const field of ["id", "projectId", "ownerUserId", "placeRunnerId"])
      requireId(record, field);
    nullableId(record, "ticketId");
    const parentSessionId = nullableId(record, "parentSessionId");
    // `lastSequence` and `eventCount` are export-only: the importer's checks.
    return {
      ...pick(record, [
        "id",
        "projectId",
        "ticketId",
        "role",
        "parentSessionId",
        "ownerUserId",
        "title",
        "visibility",
        "visibilityReason",
        "placeRunnerId",
        "createdAt",
        "lastActivityAt",
      ]),
      // The listing row's origin is not recorded locally beyond the parent link.
      origin:
        parentSessionId === null
          ? { kind: "user" }
          : { kind: "session", sessionId: parentSessionId },
      sharedAt: null,
      status: "open",
      turnActive: false,
      lastTurnOutcome: null,
      signal: null,
      stopped: null,
      needsUser: false,
      attentionCount: 0,
      model: null,
      // Not folded yet: the accept fold rebuilds totals from `usage.recorded`.
      usageTotals: null,
      ...DELETION,
    };
  },
  sessionEvents(record, _target, importedAt) {
    requireId(record, "sessionId");
    if (typeof record.id !== "string" || record.id === "") {
      fail("invalid_field", "id", "is not an event id");
    }
    const payload = asRecord(record.payload);
    if (typeof payload.kind !== "string") fail("invalid_field", "payload.kind", "is not a string");
    if (typeof record.kindKnown !== "boolean")
      fail("invalid_field", "kindKnown", "is not a boolean");
    return {
      ...pick(record, [
        "sessionId",
        "sequence",
        "occurredAt",
        "recordedAt",
        "attachmentId",
        "commandId",
        "provenance",
        "payload",
        "kindKnown",
        "quarantine",
        "bytes",
      ]),
      eventId: record.id,
      kind: payload.kind,
      acceptedAt: importedAt,
    };
  },
  eventArchives(record) {
    requireId(record, "id");
    requireId(record, "sessionId");
    return pick(record, [
      "id",
      "sessionId",
      "firstSequence",
      "lastSequence",
      "key",
      "bytes",
      "sha256",
      "eventCount",
      "format",
      "source",
      "createdAt",
    ]);
  },
  sessionIntake(record, target, importedAt) {
    requireId(record, "sessionId");
    return {
      ...pick(record, ["sessionId", "acceptedThrough", "lastEventId"]),
      // Claimed by the migrating Mac, first generation.
      claim: { runnerId: target.runnerId, generation: 1 },
      lastAcceptedAt: record.acceptedThrough === 0 ? null : importedAt,
      state: "active",
    };
  },
  delegations(record) {
    const childSessionId = requireId(record, "childSessionId");
    requireId(record, "parentSessionId");
    nullableId(record, "ticketId");
    // A delegation older than fan-out claims has no tool call or command:
    // name them from the child, which is unique per delegation.
    const legacy = `legacy:${childSessionId}`;
    return {
      ...pick(record, ["childSessionId", "parentSessionId", "ticketId", "depth"]),
      toolCallId: record.toolCallId ?? legacy,
      createCommandId: record.createCommandId ?? legacy,
      // Preflight settles every turn before cutover: no migrated delegation is live.
      status: "stopped",
      answerRef: null,
      createdAt: record.createdAt ?? 0,
      settledAt: null,
    };
  },
  sessionGrants(record) {
    requireId(record, "sessionId");
    return pick(record, ["sessionId", "verb", "scope", "maxDepth", "maxChildren"]);
  },
  delegationExtensions(record) {
    requireId(record, "parentSessionId");
    requireId(record, "approvedByUserId");
    return pick(record, ["parentSessionId", "toolCallId", "approvedByUserId", "createdAt"]);
  },
  workingCopies(record) {
    for (const field of ["id", "ticketId", "projectId", "runnerId", "projectRepoId"]) {
      requireId(record, field);
    }
    return {
      ...pick(record, [
        "id",
        "ticketId",
        "projectId",
        "runnerId",
        "projectRepoId",
        "kind",
        "state",
        "branch",
        "baseBranch",
        "reportedAt",
        "createdAt",
      ]),
      failure: null,
      headSha: null,
      upstreamSha: null,
      ahead: 0,
      behind: 0,
      // The runner's first report fills these in.
      dirty: { files: 0, insertions: 0, deletions: 0, untracked: 0, truncated: false },
      changeSetRevision: null,
      firstRun: { copy: "done", setup: "skipped" },
      setupRecipeSha: null,
      setupOutcome: null,
      lastResumeAt: null,
      lastResumeBootId: null,
    };
  },
  readMarkers(record) {
    requireId(record, "userId");
    requireId(record, "sessionId");
    return pick(record, ["userId", "sessionId", "unreadSince", "readThroughSequence"]);
  },
  auditLog(record) {
    requireId(record, "id");
    nullableId(record, "workspaceId");
    return pick(record, [
      "id",
      "workspaceId",
      "actor",
      "kind",
      "targetKind",
      "targetId",
      "at",
      "detail",
    ]);
  },
};

/**
 * The backend document for one export record of `stream`, placeholders
 * resolved. Throws {@link MigrationRowError} for a record the backend must
 * not take: an id that is not ours, a value it cannot store, a document over
 * the size contract.
 */
export function migrationDocument(
  stream: MigrationImportStream,
  record: unknown,
  target: MigrationTarget,
  importedAt: number,
): Doc {
  const resolved = resolvePlaceholders(asRecord(record), target);
  const doc = MAPPERS[stream](resolved, target, importedAt);
  const problem = storageProblem(doc);
  if (problem !== null) fail("unstorable", stream, reportableProblem(problem));
  if (jsonBytes(doc) > MIGRATION_DOCUMENT_MAX_BYTES) {
    fail("unstorable", stream, `document larger than ${MIGRATION_DOCUMENT_MAX_BYTES} bytes`);
  }
  return doc;
}
