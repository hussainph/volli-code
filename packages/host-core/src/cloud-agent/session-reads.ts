/**
 * The Session reads in a cloud launch, for a target Session this runner does
 * not hold: `session list`, `show`, `peek` and `answer` answered from Volli
 * Cloud's Session functions under the calling Session's Agent token (VC-894).
 *
 * The four are `session-target` keys of {@link CLOUD_AGENT_ROUTES}: the
 * composition answers a target claimed on this runner from its own ledger and
 * reaches these for anything else, so what a caller reads here is another
 * runner's Session as the backend last accepted it. Each verb takes the local
 * verb's request and answers in the local verb's wire shape
 * (`agent-dispatch/session-verbs.ts`), so the CLI renders both alike: short
 * handles in, short handles out, ages against this runner's clock.
 *
 * What the backend reads are:
 * - `sessions:list`: a project's (or ticket's) listing rows the caller may
 *   see, newest activity first, paged; `resolveTarget` finds a short handle
 *   in a bounded number of those pages and names an ambiguity;
 * - `sessions:snapshot`: the bounded cloud fold (`CloudSessionView`), the
 *   same reducer the local projection runs;
 * - `sessions:history`: accepted facts by sequence, read newest first;
 * - `sessionTranscript:artifacts|segments|presignGet`: the message bodies
 *   history names: staged inline, spilled to an object, or packed into a
 *   committed `volli.transcript-pack/1` segment, read from the object store
 *   through one signed GET and checked against the recorded SHA-256.
 *
 * Where a cloud answer differs from a local one, it says so rather than
 * fabricating the local fact:
 * - every cloud Session is a structured one (`kind: "chat"`); there is no
 *   terminal to report as `running` or `exited`;
 * - liveness is the backend's listing word (`status`, `waitingOn`) and its
 *   `live` flag, as the claimed runner last reported them: a runner that went
 *   to sleep mid-turn still reads `working` until it reports again;
 * - cells the backend does not keep are absent, never `null`-as-a-fact: a
 *   list row's interruption reason, `latestTurn`, `latestAttachment` and model
 *   tier (only the fold has them; `show` and `peek` read the fold), a
 *   Session's `resumptions` (the cloud fold trims them), the runner-local
 *   follow-up queue (`pendingMessages`), and a model `tier` on list rows;
 * - `startedBy` is the Session's recorded birth origin; one the backend did
 *   not record (or a Volli notice) is `null`, which reads as unknown;
 * - history is read a bounded number of pages back from the newest fact.
 *   When that window does not reach the Session's first fact, life-long counts
 *   (`turns`, `messages`) are `null` rather than the window's, and
 *   `historyComplete` is `false`; an answer older than the window is reported
 *   unreadable with its reason, never as "said nothing";
 * - a body that cannot be read (no object storage on the deployment, a
 *   checksum mismatch, an object gone) is counted `unreadable`, with the
 *   reason in `unreadableReason`.
 *
 * Every read is bounded by {@link CLOUD_VERB_BUDGET_MS}. Nothing here writes,
 * so a read that got no answer is `OFFLINE`: the same command is safe again.
 * A caller with no Session evidence is `SIGN_IN_REQUIRED`.
 */
import { createHash } from "node:crypto";
import { zstdDecompress } from "node:zlib";

import {
  CHAT_SESSION_ACTIVITIES,
  displayTicketId,
  EMPTY_SESSION_USAGE_SUMMARY,
  isSessionListState,
  parseRendererSessionEvent,
  pendingSubagentIds,
  readSessionOrigin,
  redactPayloadSecrets,
  SESSION_LIST_STATES,
  sessionInterruptionDetail,
  sessionInterruptionReason,
  sessionUsageWindowSince,
  shortSessionId,
  type AgentErrorCode,
  type AgentRequest,
  type AgentResponse,
  type ChatSessionActivity,
  type SessionEvent,
  type SessionOrigin,
  type SessionProjection,
  type SessionUsageSummary,
  type TranscriptReference,
} from "@volli/shared";
import {
  isArtifactDigest,
  isUuid,
  SESSION_OBJECT_MAX_BYTES,
  STAGE_ARTIFACTS_MAX_BATCH,
  TRANSCRIPT_PACK_FORMAT,
  type CloudSessionView,
} from "@volli/shared/cloud";
import {
  foldSessionAnswerState,
  readSessionAnswer,
  readSessionTranscriptTail,
  transcriptReferenceFor,
  type SessionAnswerState,
  type SessionTranscriptArtifact,
} from "@volli/session-engine";

import { failure } from "../agent-dispatch/context";
import { readSessionUsageWindow } from "../agent-dispatch/cost-verb";
import { pendingSessionQuestions } from "../agent-dispatch/pending-session-questions";
import { positiveIntOr } from "../agent-dispatch/resolution";
import { CHAT_PEEK_ENTRIES, sessionPeekAttention } from "../agent-dispatch/session-verbs";
import { publicSessionOrigin } from "../agent-dispatch/wire";
import { NotYetSyncedError, type AgentBackend, type AgentCallOptions } from "./agent-backend";
import { CLOUD_VERB_BUDGET_MS, type CloudVerb } from "./board-verbs";
import { CloudFunctionError, CloudOfflineError } from "./functions-client";

// ── bounds ───────────────────────────────────────────────────────────────────

/** Listing rows asked for per `sessions:list` page. */
const SESSION_LIST_PAGE = 100;
/** Pages one project's listing is read to at most: its newest 1,000 Sessions. */
const SESSION_LIST_MAX_PAGES = 10;
/** Pages `resolveTarget` reads across every project it searches, at most. */
const SESSION_RESOLVE_MAX_PAGES = 20;
/** Facts per `sessions:history` page (the backend's own cap). */
const HISTORY_PAGE = 200;
/** History pages a peek or an answer reads back from the newest fact, at most. */
const SESSION_HISTORY_MAX_PAGES = 10;
/** Segment reads one body lookup may make before the body counts as unreadable. */
const SEGMENT_READS_MAX = 8;
const SEGMENT_PAGE = 16;

/** A `beforeSequence` past every accepted fact: the newest window. */
const NEWEST = Number.MAX_SAFE_INTEGER;

// ── the module's surface ─────────────────────────────────────────────────────

/** The four Session reads this module answers. */
export type CloudSessionReadKey =
  | "session.list"
  | "session.show"
  | "session.peek"
  | "session.answer";

/**
 * A Session the backend lists, as this runner reads it: the listing row of
 * `sessions:list` / `sessions:snapshot`. Internal ids (`ownerUserId`,
 * `placeRunnerId`) are here for routing and supervision and never cross the
 * socket; the wire carries {@link shortSessionId} handles only.
 */
export interface CloudSessionTarget {
  id: string;
  projectId: string;
  ticketId: string | null;
  role: "project" | "ticket" | "subagent";
  parentSessionId: string | null;
  ownerUserId: string | null;
  /** The runner the Session's claim names: where it runs. */
  placeRunnerId: string | null;
  title: string | null;
  /** The listing's `open` / `archived`. */
  status: "open" | "archived";
  turnActive: boolean;
  lastTurnOutcome: string | null;
  signal: { signal: "done" | "blocked"; reason: string | null; at: number } | null;
  stopped: { at: number; reason: string | null } | null;
  needsUser: boolean;
  /** The Session's birth origin, or `null` when none was recorded. */
  origin: SessionOrigin | null;
  model: { providerId: string; modelId: string; reasoningLevel: string } | null;
  /** The listing rule's answer over the fold (`sessionListingActivity`). */
  activity: ChatSessionActivity;
  waitingOn: string | null;
  /** An attachment was open when the claimed runner last reported. */
  live: boolean;
  /** What it spent; `costBasis` is `null` for a row written before the summary was kept. */
  usage: {
    costUsd: number | null;
    costBasis: SessionUsageSummary["costBasis"] | null;
    costCoverage: string | null;
    tokens: number;
  };
  createdAt: number;
  lastActivityAt: number;
}

export type CloudSessionResolution =
  | { ok: true; target: CloudSessionTarget }
  | { ok: false; response: AgentResponse };

export type CloudSessionReads = { readonly [Key in CloudSessionReadKey]: CloudVerb } & {
  /**
   * The visible cloud Session behind `handle`, read under `callerSessionId`'s
   * Agent token: a short handle (what `session list` prints) searched in the
   * newest {@link SESSION_LIST_MAX_PAGES} pages of `projectId`'s listing (or,
   * without one, of every project the caller sees, its own first, within
   * {@link SESSION_RESOLVE_MAX_PAGES} pages), or a full Session id read
   * directly. Refusals are already socket-shaped: `INVALID_REQUEST`,
   * `SESSION_NOT_FOUND` (saying when the search was bounded),
   * `AMBIGUOUS_CONTEXT` (naming the candidates), `OFFLINE`, `NOT_YET_SYNCED`,
   * `FORBIDDEN_ACTOR`.
   */
  resolveTarget(
    callerSessionId: string,
    handle: unknown,
    projectId?: string,
    options?: AgentCallOptions,
  ): Promise<CloudSessionResolution>;
};

export interface CloudSessionReadsOptions {
  backend: AgentBackend;
  /** This runner's name, for the offline sentence. */
  runnerName?: string;
  now?(): number;
  /** Downloads one signed GET (default: `fetch`). */
  fetch?(url: string, init: RequestInit): Promise<Response>;
}

// ── failures ─────────────────────────────────────────────────────────────────

/** A refusal already shaped for the socket, carried out of a verb's body. */
class ReadRefusal extends Error {
  constructor(readonly response: AgentResponse) {
    super("refused");
  }
}

function refuse(code: AgentErrorCode, reason: string, next?: string | null): never {
  throw new ReadRefusal(failure(code, reason, next));
}

/** The backend answered a shape this build cannot read: corruption, said loudly. */
class CloudReadMalformed extends Error {
  constructor(what: string) {
    super(`Volli Cloud's ${what} is malformed.`);
    this.name = "CloudReadMalformed";
  }
}

const AUTH_CODES: ReadonlySet<string> = new Set([
  "not_a_member",
  "not_a_person",
  "forbidden",
  "fenced",
  "revoked",
  "not_claimed",
  "unauthenticated",
]);

export function cloudSessionRefusal(error: CloudFunctionError): AgentResponse {
  if (error.code === "not_found") return failure("SESSION_NOT_FOUND", error.message);
  if (["invalid_request", "invalid_argument", "id_taken"].includes(error.code)) {
    return failure("INVALID_REQUEST", error.message);
  }
  if (AUTH_CODES.has(error.code)) {
    return failure(
      "FORBIDDEN_ACTOR",
      error.message,
      "This Session can no longer act for its owner in Volli Cloud from this runner.",
    );
  }
  return failure("MUTATION_FAILED", error.message);
}

// ── reading what the backend answers ─────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stringOr = (value: unknown, fallback: string | null) =>
  typeof value === "string" ? value : fallback;
const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const ROLES: ReadonlySet<string> = new Set(["project", "ticket", "subagent"]);

function readUsage(value: unknown): CloudSessionTarget["usage"] {
  const totals = isRecord(value) ? value : {};
  const summary = isRecord(totals["summary"]) ? totals["summary"] : null;
  if (summary !== null) {
    return {
      costUsd: typeof summary["knownCostUsd"] === "number" ? summary["knownCostUsd"] : null,
      costBasis: stringOr(summary["costBasis"], null) as SessionUsageSummary["costBasis"] | null,
      costCoverage: stringOr(summary["costCoverage"], null),
      tokens:
        numberOr(summary["inputTokens"], 0) +
        numberOr(summary["outputTokens"], 0) +
        numberOr(summary["cacheReadTokens"], 0) +
        numberOr(summary["cacheWriteTokens"], 0),
    };
  }
  // A row written before the summary was kept: the coarse totals, no basis.
  return {
    costUsd: typeof totals["costUsd"] === "number" ? totals["costUsd"] : null,
    costBasis: null,
    costCoverage: stringOr(totals["coverage"], null),
    tokens:
      numberOr(totals["inputTokens"], 0) +
      numberOr(totals["outputTokens"], 0) +
      numberOr(totals["cacheReadTokens"], 0) +
      numberOr(totals["cacheWriteTokens"], 0),
  };
}

/** One listing row (`sessionSummary` in `convex/functions/sessions.ts`). */
function readCloudSessionTarget(value: unknown): CloudSessionTarget {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["projectId"] !== "string" ||
    typeof value["role"] !== "string" ||
    !ROLES.has(value["role"]) ||
    typeof value["createdAt"] !== "number" ||
    typeof value["lastActivityAt"] !== "number" ||
    !isRecord(value["listing"])
  ) {
    throw new CloudReadMalformed("Session listing row");
  }
  const listing = value["listing"];
  const activity = listing["activity"];
  if (!(CHAT_SESSION_ACTIVITIES as readonly unknown[]).includes(activity)) {
    throw new CloudReadMalformed("Session listing row");
  }
  const signal = isRecord(value["signal"]) ? value["signal"] : null;
  const stopped = isRecord(value["stopped"]) ? value["stopped"] : null;
  const model = isRecord(value["model"]) ? value["model"] : null;
  return {
    id: value["id"],
    projectId: value["projectId"],
    ticketId: stringOr(value["ticketId"], null),
    role: value["role"] as CloudSessionTarget["role"],
    parentSessionId: stringOr(value["parentSessionId"], null),
    ownerUserId: stringOr(value["ownerUserId"], null),
    placeRunnerId: stringOr(value["placeRunnerId"], null),
    title: stringOr(value["title"], null),
    status: value["status"] === "archived" ? "archived" : "open",
    turnActive: value["turnActive"] === true,
    lastTurnOutcome: stringOr(value["lastTurnOutcome"], null),
    signal:
      signal !== null && (signal["signal"] === "done" || signal["signal"] === "blocked")
        ? {
            signal: signal["signal"],
            reason: stringOr(signal["reason"], null),
            at: numberOr(signal["at"], 0),
          }
        : null,
    stopped:
      stopped === null
        ? null
        : { at: numberOr(stopped["at"], 0), reason: stringOr(stopped["reason"], null) },
    needsUser: value["needsUser"] === true,
    origin: readSessionOrigin(value["origin"]),
    model:
      model !== null &&
      typeof model["providerId"] === "string" &&
      typeof model["modelId"] === "string"
        ? {
            providerId: model["providerId"],
            modelId: model["modelId"],
            reasoningLevel: stringOr(model["reasoningLevel"], "") ?? "",
          }
        : null,
    activity: activity as ChatSessionActivity,
    waitingOn: stringOr(listing["waitingOn"], null),
    live: listing["live"] === true,
    usage: readUsage(value["usageTotals"]),
    createdAt: value["createdAt"],
    lastActivityAt: value["lastActivityAt"],
  };
}

interface Snapshot {
  target: CloudSessionTarget;
  /** The bounded fold, or `null` before the backend has folded a fact. */
  view: CloudSessionView | null;
}

/** `sessions:snapshot`'s answer. The fold's nested shapes were built by the shared codec. */
function readSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) throw new CloudReadMalformed("Session snapshot");
  const target = readCloudSessionTarget(value["session"]);
  const state = value["state"];
  if (state === null || state === undefined) return { target, view: null };
  if (typeof state !== "string") throw new CloudReadMalformed("Session snapshot");
  let view: unknown;
  try {
    view = JSON.parse(state);
  } catch {
    throw new CloudReadMalformed("Session state");
  }
  if (
    !isRecord(view) ||
    typeof view["turnActive"] !== "boolean" ||
    !isRecord(view["attention"]) ||
    !Array.isArray(view["attention"]["active"]) ||
    !isRecord(view["interactions"]) ||
    !Array.isArray(view["interactions"]["active"]) ||
    !isRecord(view["usage"]) ||
    typeof view["lastActivityAt"] !== "number"
  ) {
    throw new CloudReadMalformed("Session state");
  }
  return { target, view: view as unknown as CloudSessionView };
}

interface ProjectRow {
  id: string;
  name: string;
  ticketPrefix: string;
}

// ── wire cells ───────────────────────────────────────────────────────────────

/** Who started a Session, from its recorded origin; `null` (unknown) when none was. */
function publicStartedBy(
  origin: SessionOrigin | null,
  parentTitle: string | null | undefined,
): Record<string, unknown> | null {
  switch (origin?.kind) {
    case "user":
      return { kind: "user" };
    case "automation":
      return {
        kind: "automation",
        automationName: origin.automationName,
        automationRunId: origin.automationRunId,
      };
    case "session":
      return {
        kind: "session",
        parentSessionId: shortSessionId(origin.sessionId),
        ...(parentTitle === undefined ? {} : { parentTitle }),
      };
    default:
      return null;
  }
}

function publicSignal(signal: CloudSessionView["signal"] | undefined, observedAt: number) {
  return signal == null
    ? null
    : {
        kind: signal.signal,
        reason: signal.reason,
        at: signal.occurredAt,
        ageMs: Math.max(0, observedAt - signal.occurredAt),
      };
}

/** The same signal from the listing row, for a Session with no fold yet. */
function listingSignal(target: CloudSessionTarget, observedAt: number) {
  return target.signal === null
    ? null
    : publicSignal(
        {
          signal: target.signal.signal,
          reason: target.signal.reason,
          occurredAt: target.signal.at,
        },
        observedAt,
      );
}

function usageCells(usage: SessionUsageSummary): Record<string, unknown> {
  return {
    costUsd: usage.knownCostUsd,
    costBasis: usage.costBasis,
    costCoverage: usage.costCoverage,
    tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
  };
}

function viewModelCells(view: CloudSessionView): Record<string, unknown> {
  const selection = view.modelSelection;
  return {
    model: selection === null ? null : `${selection.providerId}/${selection.modelId}`,
    reasoning: selection === null ? null : selection.reasoningLevel,
    tier: view.modelTier,
  };
}

/** The fold read as the projection the shared rules take: they read only fields it keeps. */
const asProjection = (view: CloudSessionView) => view as unknown as SessionProjection;

function interruptedReasonOf(activity: ChatSessionActivity, view: CloudSessionView) {
  return activity === "interrupted" ? sessionInterruptionReason(asProjection(view)) : null;
}

/** `latestAttachment` / `latestTurn`, from the fold; the attachment only while one is open. */
function viewOrchestrationCells(view: CloudSessionView): Record<string, unknown> {
  const live = view.liveAttachment as unknown;
  return {
    // The cloud fold keeps only the open attachment on its view; a closed
    // one's opener is not answered rather than reported as none.
    ...(isRecord(live) && live["openedAt"] !== null
      ? {
          latestAttachment: {
            origin: publicSessionOrigin(readSessionOrigin(live["origin"])),
            reattached: live["reattached"] === true,
          },
        }
      : {}),
    latestTurn:
      view.latestTurnId === null
        ? null
        : {
            origin: publicSessionOrigin(view.latestTurnOrigin),
            resumedAfterStop: view.resumedAfterStop,
          },
  };
}

// Human copy, the same words `session peek` says locally (session-verbs.ts).
const clip = (text: string | null) =>
  text === null ? null : redactPayloadSecrets(text).slice(0, 400);

// ── transcript bodies ────────────────────────────────────────────────────────

/** Why a body could not be read, kept for the answer's `unreadableReason`. */
class BodyUnreadable extends Error {}

/** One body's digest: the reference's own digest, else its id when that is one. */
function digestOf(reference: TranscriptReference): string | null {
  if (isArtifactDigest(reference.digest)) return reference.digest;
  return isArtifactDigest(reference.id) ? reference.id : null;
}

/** A body's JSON as a transcript artifact: only `message` is read downstream. */
function artifactOf(value: unknown): SessionTranscriptArtifact {
  const message = isRecord(value) && isRecord(value["message"]) ? value["message"] : value;
  if (
    !isRecord(message) ||
    typeof message["id"] !== "string" ||
    (message["role"] !== "user" &&
      message["role"] !== "assistant" &&
      message["role"] !== "system") ||
    !Array.isArray(message["parts"])
  ) {
    throw new BodyUnreadable("A transcript body is not a message.");
  }
  const outer = isRecord(value) ? value : {};
  return {
    version: 1,
    threadId: stringOr(outer["threadId"], "") ?? "",
    branchId: stringOr(outer["branchId"], "") ?? "",
    attemptId: stringOr(outer["attemptId"], "") ?? "",
    turnId: stringOr(outer["turnId"], null),
    message: message as unknown as SessionTranscriptArtifact["message"],
  };
}

interface Segment {
  segmentId: string;
  firstSequence: number;
  lastSequence: number;
  sha256: string | null;
}

/** The bodies one verb reads: staged first, then spilled objects, then packs. */
interface BodyReader {
  /** Reads staging for these digests at once, so the reads after it cost nothing. */
  prefetch(references: readonly TranscriptReference[]): Promise<void>;
  read(reference: TranscriptReference): Promise<SessionTranscriptArtifact>;
  /** The first reason a body could not be read, if one could not. */
  readonly reason: string | null;
}

// ── the reads ────────────────────────────────────────────────────────────────

interface ReadIo {
  readonly sessionId: string;
  readonly deadline: number;
  query<T>(path: string, args: Record<string, unknown>): Promise<T>;
  action<T>(path: string, args: Record<string, unknown>): Promise<T>;
  projects(): Promise<{ projects: ProjectRow[]; current: string | null }>;
}

interface HistoryWindow {
  /** Readable facts, oldest first. */
  events: SessionEvent[];
  /** The window reaches the Session's first fact. */
  complete: boolean;
  /** The sequence each referenced body's fact holds, by digest. */
  sequences: Map<string, number>;
}

const subagentRecords = (rows: readonly CloudSessionTarget[]) =>
  rows.map((row) => ({
    sessionId: row.id,
    role: row.role,
    parentSessionId: row.parentSessionId,
    activity: row.activity,
    createdAt: row.createdAt,
  }));

const sessionRelationSummary = (row: CloudSessionTarget) => ({
  id: shortSessionId(row.id),
  title: row.title,
  role: row.role,
  status: row.activity,
});

export function createCloudSessionReads(options: CloudSessionReadsOptions): CloudSessionReads {
  const { backend } = options;
  const now = options.now ?? Date.now;
  const runner = options.runnerName ?? "This runner";
  const fetchImpl = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  const offline = () =>
    failure(
      "OFFLINE",
      `${runner} can't reach Volli Cloud, and this Session runs on another runner: reading it needs a connection. Nothing was changed.`,
    );

  function ioFor(sessionId: string, deadline = now() + CLOUD_VERB_BUDGET_MS): ReadIo {
    let projects: Promise<{ projects: ProjectRow[]; current: string | null }> | null = null;
    const io: ReadIo = {
      sessionId,
      deadline,
      query: <T>(path: string, args: Record<string, unknown>) =>
        backend.query(sessionId, path, args, { deadline }) as Promise<T>,
      action: <T>(path: string, args: Record<string, unknown>) =>
        backend.action(sessionId, path, args, { deadline }) as Promise<T>,
      projects: () =>
        (projects ??= io.query<unknown>("projects:listForActor", {}).then((value) => {
          if (!isRecord(value) || !Array.isArray(value["projects"])) {
            throw new CloudReadMalformed("project list");
          }
          return {
            projects: value["projects"]
              .filter(isRecord)
              .flatMap((row) =>
                typeof row["id"] === "string" &&
                typeof row["name"] === "string" &&
                typeof row["ticketPrefix"] === "string"
                  ? [{ id: row["id"], name: row["name"], ticketPrefix: row["ticketPrefix"] }]
                  : [],
              ),
            current: stringOr(value["current"], null),
          };
        })),
    };
    return io;
  }

  /** Maps every failure of a read to the socket's words. */
  async function guarded(body: () => Promise<AgentResponse>): Promise<AgentResponse> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof ReadRefusal) return error.response;
      // A read wrote nothing, whether or not it was answered.
      if (error instanceof CloudOfflineError) return offline();
      if (error instanceof NotYetSyncedError) return failure("NOT_YET_SYNCED", error.message);
      if (error instanceof CloudFunctionError) return cloudSessionRefusal(error);
      if (error instanceof CloudReadMalformed) return failure("MUTATION_FAILED", error.message);
      throw error;
    }
  }

  function verb(body: (io: ReadIo, request: AgentRequest) => Promise<AgentResponse>): CloudVerb {
    return async ({ sessionId, request }) => {
      if (sessionId === null) {
        return failure(
          "SIGN_IN_REQUIRED",
          `${request.cmd} reads Volli Cloud Sessions for a Session's owner, and this caller is not a Volli Session.`,
        );
      }
      return guarded(() => body(ioFor(sessionId), request));
    };
  }

  // ── listing ────────────────────────────────────────────────────────────────

  /** One project's (or ticket's) listing, newest first, within `maxPages`. */
  async function listing(
    io: ReadIo,
    projectId: string,
    ticketId: string | null,
    maxPages: number,
  ): Promise<{ rows: CloudSessionTarget[]; complete: boolean; pages: number }> {
    const rows: CloudSessionTarget[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < maxPages;) {
      const page: unknown = await io.query("sessions:list", {
        projectId,
        ...(ticketId === null ? {} : { ticketId }),
        paginationOpts: { numItems: SESSION_LIST_PAGE, cursor },
      });
      pages += 1;
      if (!isRecord(page) || !Array.isArray(page["page"]) || typeof page["isDone"] !== "boolean") {
        throw new CloudReadMalformed("Session listing");
      }
      rows.push(...page["page"].map(readCloudSessionTarget));
      if (page["isDone"]) return { rows, complete: true, pages };
      if (typeof page["continueCursor"] !== "string")
        throw new CloudReadMalformed("Session listing");
      cursor = page["continueCursor"];
    }
    return { rows, complete: false, pages: maxPages };
  }

  async function projectFor(io: ReadIo, selector: unknown): Promise<ProjectRow> {
    const { projects, current } = await io.projects();
    if (typeof selector === "string") {
      const wanted = selector.trim().toLowerCase();
      const matches = projects.filter(
        (project) =>
          project.name.toLowerCase() === wanted || project.ticketPrefix.toLowerCase() === wanted,
      );
      if (matches.length > 1)
        refuse("AMBIGUOUS_PROJECT", `More than one project matches ${selector}.`);
      if (matches.length === 0) refuse("PROJECT_NOT_FOUND", `No project matches ${selector}.`);
      return matches[0]!;
    }
    const project = projects.find(({ id }) => id === current);
    if (project === undefined) {
      return refuse("PROJECT_REQUIRED", "This Session's project is not on the board.");
    }
    return project;
  }

  /** Display keys for the tickets `rows` name, from one roster read (and a read per stray). */
  async function ticketKeys(
    io: ReadIo,
    project: ProjectRow | undefined,
    ticketIds: readonly (string | null)[],
  ): Promise<(ticketId: string | null) => string | null> {
    const wanted = new Set(ticketIds.filter((id): id is string => id !== null));
    const keys = new Map<string, string | null>();
    if (wanted.size > 0 && project !== undefined) {
      const roster: unknown = await io.query("board:roster", { projectId: project.id });
      const tickets = isRecord(roster) && Array.isArray(roster["tickets"]) ? roster["tickets"] : [];
      for (const ticket of tickets) {
        if (
          isRecord(ticket) &&
          typeof ticket["id"] === "string" &&
          typeof ticket["number"] === "number"
        ) {
          keys.set(ticket["id"], displayTicketId(project.ticketPrefix, ticket["number"]));
        }
      }
      // Archived tickets are not on the roster: read each one the rows still name.
      const { projects } = await io.projects();
      await Promise.all(
        [...wanted]
          .filter((id) => !keys.has(id))
          .map(async (ticketId) => {
            try {
              const read: unknown = await io.query("board:getTicket", { ticketId });
              const ticket = isRecord(read) && isRecord(read["ticket"]) ? read["ticket"] : null;
              const owner = projects.find(({ id }) => id === ticket?.["projectId"]);
              keys.set(
                ticketId,
                ticket !== null && owner !== undefined && typeof ticket["number"] === "number"
                  ? displayTicketId(owner.ticketPrefix, ticket["number"])
                  : null,
              );
            } catch (error) {
              if (!(error instanceof CloudFunctionError)) throw error;
              keys.set(ticketId, null);
            }
          }),
      );
    }
    return (ticketId) => (ticketId === null ? null : (keys.get(ticketId) ?? null));
  }

  // ── resolving a handle ─────────────────────────────────────────────────────

  async function resolveIn(
    io: ReadIo,
    handle: unknown,
    projectId: string | undefined,
  ): Promise<{ target: CloudSessionTarget; rows: CloudSessionTarget[] | null }> {
    if (typeof handle !== "string" || handle.trim() === "") {
      return refuse("INVALID_REQUEST", "A session id is required.");
    }
    const selector = handle.trim();
    if (isUuid(selector)) {
      try {
        const snapshot = readSnapshot(await io.query("sessions:snapshot", { sessionId: selector }));
        return { target: snapshot.target, rows: null };
      } catch (error) {
        if (error instanceof CloudFunctionError && error.code === "not_found") {
          return refuse("SESSION_NOT_FOUND", `No session matches ${selector}.`);
        }
        throw error;
      }
    }
    const { projects, current } = await io.projects();
    const order =
      projectId !== undefined
        ? [projectId]
        : [
            ...projects.filter(({ id }) => id === current),
            ...projects.filter(({ id }) => id !== current),
          ].map(({ id }) => id);
    const matches: { target: CloudSessionTarget; rows: CloudSessionTarget[] }[] = [];
    let budget = projectId !== undefined ? SESSION_LIST_MAX_PAGES : SESSION_RESOLVE_MAX_PAGES;
    let bounded = false;
    for (const id of order) {
      if (budget <= 0) {
        bounded = true;
        break;
      }
      const scan = await listing(io, id, null, Math.min(budget, SESSION_LIST_MAX_PAGES));
      budget -= scan.pages;
      if (!scan.complete) bounded = true;
      for (const row of scan.rows) {
        if (shortSessionId(row.id) === selector) matches.push({ target: row, rows: scan.rows });
      }
    }
    if (matches.length > 1) {
      const names = new Map(projects.map((project) => [project.id, project.name]));
      return refuse(
        "AMBIGUOUS_CONTEXT",
        `Session id ${selector} is ambiguous.`,
        `It matches ${matches
          .map(
            ({ target }) =>
              `${JSON.stringify(target.title ?? "untitled")} in ${names.get(target.projectId) ?? "another project"}`,
          )
          .join(", ")}; narrow it with --project.`,
      );
    }
    if (matches.length === 0) {
      return refuse(
        "SESSION_NOT_FOUND",
        bounded
          ? `No session matches ${selector} among the newest Sessions Volli Cloud lists for you (the search reads at most ${(projectId !== undefined ? SESSION_LIST_MAX_PAGES : SESSION_RESOLVE_MAX_PAGES) * SESSION_LIST_PAGE} rows).`
          : `No session matches ${selector}.`,
        bounded ? "Name its project with --project to search further back there." : null,
      );
    }
    return matches[0]!;
  }

  async function snapshotOf(io: ReadIo, sessionId: string): Promise<Snapshot> {
    return readSnapshot(await io.query("sessions:snapshot", { sessionId }));
  }

  /** The fold, or a retryable refusal while the backend has folded nothing yet. */
  async function foldedSnapshot(io: ReadIo, target: CloudSessionTarget) {
    const snapshot = await snapshotOf(io, target.id);
    if (snapshot.view === null) {
      return refuse(
        "NOT_YET_SYNCED",
        `Volli Cloud has not folded Session ${shortSessionId(target.id)}'s history yet.`,
      );
    }
    return { target: snapshot.target, view: snapshot.view };
  }

  // ── history and bodies ─────────────────────────────────────────────────────

  /** Facts read newest first, a page at a time, until `enough` or the bound. */
  async function historyWindow(
    io: ReadIo,
    sessionId: string,
    enough: (events: readonly SessionEvent[]) => boolean,
  ): Promise<HistoryWindow> {
    const pages: SessionEvent[][] = [];
    const sequences = new Map<string, number>();
    let before = NEWEST;
    let complete = false;
    for (let page = 0; page < SESSION_HISTORY_MAX_PAGES; page += 1) {
      const answer: unknown = await io.query("sessions:history", {
        sessionId,
        beforeSequence: before,
        limit: HISTORY_PAGE,
      });
      if (
        !isRecord(answer) ||
        !Array.isArray(answer["events"]) ||
        typeof answer["hasMore"] !== "boolean"
      ) {
        throw new CloudReadMalformed("Session history");
      }
      const events: SessionEvent[] = [];
      let first = before;
      for (const row of answer["events"]) {
        if (!isRecord(row) || typeof row["sequence"] !== "number") {
          throw new CloudReadMalformed("Session history");
        }
        first = Math.min(first, row["sequence"]);
        // A fact this build cannot read is passed over: tolerant on read.
        if (row["status"] !== "ok" || typeof row["event"] !== "string") continue;
        let raw: unknown;
        try {
          raw = JSON.parse(row["event"]);
        } catch {
          throw new CloudReadMalformed(`Session event ${row["sequence"]}`);
        }
        const parsed = parseRendererSessionEvent(raw, "cloud.history.event");
        if (!parsed.ok) {
          if (parsed.reason === "malformed") {
            throw new CloudReadMalformed(`Session event ${row["sequence"]}`);
          }
          continue;
        }
        // The renderer-safe event: the folds below read only kinds, references,
        // command intents and receipts, which the scrub keeps as they are.
        const event = parsed.event as unknown as SessionEvent;
        events.push(event);
        const reference = transcriptReferenceFor(event);
        const digest = reference === null ? null : digestOf(reference);
        if (digest !== null && !sequences.has(digest)) sequences.set(digest, event.sequence);
      }
      pages.unshift(events);
      if (!answer["hasMore"] || answer["events"].length === 0) {
        complete = true;
        break;
      }
      before = first;
      if (enough(pages.flat())) break;
    }
    const events = pages.flat().toSorted((a, b) => a.sequence - b.sequence);
    return { events, complete, sequences };
  }

  async function signedGet(io: ReadIo, sessionId: string, object: Record<string, unknown>) {
    const grant: unknown = await io.action("sessionTranscript:presignGet", { sessionId, object });
    if (isRecord(grant) && grant["status"] === "absent") return null;
    const request = isRecord(grant) ? grant["request"] : null;
    if (
      !isRecord(grant) ||
      grant["status"] !== "sign" ||
      !isRecord(request) ||
      typeof request["url"] !== "string" ||
      !isRecord(request["headers"])
    ) {
      throw new CloudReadMalformed("transcript object grant");
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request["headers"])) {
      if (typeof value === "string") headers[name] = value;
    }
    const left = io.deadline - now();
    if (left <= 0) throw new BodyUnreadable("Out of time before reading a transcript object.");
    let response: Response;
    try {
      response = await fetchImpl(request["url"], {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(left),
      });
    } catch (error) {
      throw new BodyUnreadable(
        `The transcript object store did not answer: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new BodyUnreadable(`The transcript object store answered ${response.status}.`);
    }
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    if (reader !== undefined) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > SESSION_OBJECT_MAX_BYTES) {
            await reader.cancel();
            throw new BodyUnreadable("A transcript object is larger than any a runner uploads.");
          }
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = Buffer.concat(chunks, total);
    return {
      bytes,
      sha256: isRecord(grant) && typeof grant["sha256"] === "string" ? grant["sha256"] : null,
    };
  }

  async function inflate(bytes: Buffer): Promise<string> {
    try {
      const out = await new Promise<Buffer>((resolve, reject) =>
        zstdDecompress(bytes, { maxOutputLength: SESSION_OBJECT_MAX_BYTES }, (error, result) =>
          error === null ? resolve(result) : reject(error),
        ),
      );
      return out.toString("utf8");
    } catch {
      throw new BodyUnreadable("A transcript object is not readable zstd.");
    }
  }

  function bodyReader(io: ReadIo, sessionId: string, window: HistoryWindow): BodyReader {
    /** Staging's answer per digest: inline text, spilled, or absent. */
    const staged = new Map<
      string,
      { status: "inline"; body: string } | { status: "spilled" } | { status: "absent" }
    >();
    const packs = new Map<string, Promise<Map<string, unknown>>>();
    const segments: Segment[] = [];
    let segmentReads = 0;
    let reason: string | null = null;

    async function stage(digests: readonly string[]) {
      const missing = [...new Set(digests)].filter((digest) => !staged.has(digest));
      for (let index = 0; index < missing.length; index += STAGE_ARTIFACTS_MAX_BATCH) {
        const answer: unknown = await io.query("sessionTranscript:artifacts", {
          sessionId,
          digests: missing.slice(index, index + STAGE_ARTIFACTS_MAX_BATCH),
        });
        if (!Array.isArray(answer)) throw new CloudReadMalformed("transcript artifacts");
        for (const entry of answer) {
          if (!isRecord(entry) || typeof entry["digest"] !== "string") continue;
          staged.set(
            entry["digest"],
            entry["status"] === "inline" && typeof entry["body"] === "string"
              ? { status: "inline", body: entry["body"] }
              : entry["status"] === "spilled"
                ? { status: "spilled" }
                : { status: "absent" },
          );
        }
      }
    }

    async function segmentFor(sequence: number): Promise<Segment | null> {
      const held = segments.find((s) => s.firstSequence <= sequence && sequence <= s.lastSequence);
      if (held !== undefined) return held;
      if (segmentReads >= SEGMENT_READS_MAX) return null;
      segmentReads += 1;
      const answer: unknown = await io.query("sessionTranscript:segments", {
        sessionId,
        beforeSequence: sequence + 1,
        limit: SEGMENT_PAGE,
      });
      if (!isRecord(answer) || !Array.isArray(answer["segments"])) {
        throw new CloudReadMalformed("transcript segments");
      }
      for (const row of answer["segments"]) {
        if (
          !isRecord(row) ||
          typeof row["segmentId"] !== "string" ||
          typeof row["firstSequence"] !== "number" ||
          typeof row["lastSequence"] !== "number"
        ) {
          throw new CloudReadMalformed("transcript segments");
        }
        segments.push({
          segmentId: row["segmentId"],
          firstSequence: row["firstSequence"],
          lastSequence: row["lastSequence"],
          sha256: stringOr(row["sha256"], null),
        });
      }
      return (
        segments.find((s) => s.firstSequence <= sequence && sequence <= s.lastSequence) ?? null
      );
    }

    function pack(segment: Segment): Promise<Map<string, unknown>> {
      let loading = packs.get(segment.segmentId);
      if (loading === undefined) {
        loading = (async () => {
          const object = await signedGet(io, sessionId, {
            kind: "pack",
            segmentId: segment.segmentId,
          });
          if (object === null)
            throw new BodyUnreadable("A committed transcript pack is not readable.");
          const expected = segment.sha256 ?? object.sha256;
          if (
            expected !== null &&
            createHash("sha256").update(object.bytes).digest("hex") !== expected
          ) {
            throw new BodyUnreadable("A transcript pack does not match its checksum.");
          }
          return readPack(await inflate(object.bytes), sessionId, segment);
        })();
        packs.set(segment.segmentId, loading);
      }
      return loading;
    }

    async function body(digest: string): Promise<unknown> {
      await stage([digest]);
      const held = staged.get(digest);
      if (held?.status === "inline") return parseBody(held.body);
      if (held?.status === "spilled") {
        const object = await signedGet(io, sessionId, { kind: "spill", digest });
        // Absent now: packed since the staging read, so its pack has it.
        if (object !== null) return parseBody(await inflate(object.bytes));
      }
      const sequence = window.sequences.get(digest);
      if (sequence === undefined)
        throw new BodyUnreadable("No fact in the window names this body.");
      const segment = await segmentFor(sequence);
      if (segment === null) {
        throw new BodyUnreadable("The body is neither staged nor in a committed transcript pack.");
      }
      const bodies = await pack(segment);
      if (!bodies.has(digest))
        throw new BodyUnreadable("The transcript pack covering it does not hold it.");
      return bodies.get(digest);
    }

    return {
      async prefetch(references) {
        await stage(references.map(digestOf).filter((digest): digest is string => digest !== null));
      },
      async read(reference) {
        try {
          const digest = digestOf(reference);
          if (digest === null) throw new BodyUnreadable("A transcript reference names no digest.");
          return artifactOf(await body(digest));
        } catch (error) {
          reason ??= bodyReason(error);
          throw error;
        }
      },
      get reason() {
        return reason;
      },
    };
  }

  // ── the verbs ──────────────────────────────────────────────────────────────

  async function targetFor(io: ReadIo, request: AgentRequest) {
    const selector = request.args["project"];
    const projectId =
      typeof selector === "string" ? (await projectFor(io, selector)).id : undefined;
    return resolveIn(io, request.args["id"], projectId);
  }

  return {
    resolveTarget: (callerSessionId, handle, projectId, callOptions = {}) =>
      (async (): Promise<CloudSessionResolution> => {
        const found: { target: CloudSessionTarget | null } = { target: null };
        const response = await guarded(async () => {
          found.target = (
            await resolveIn(ioFor(callerSessionId, callOptions.deadline), handle, projectId)
          ).target;
          return { v: 1, ok: true, data: {} };
        });
        return found.target === null ? { ok: false, response } : { ok: true, target: found.target };
      })(),

    "session.list": verb(async (io, request) => {
      const window = readSessionUsageWindow(request.args["since"]);
      if (window === "invalid") {
        return failure(
          "INVALID_REQUEST",
          "since must be an RFC 3339 instant or a look-back like 7d, 24h or 90m.",
        );
      }
      const states = request.args["state"];
      if (
        states !== undefined &&
        (!Array.isArray(states) || states.length === 0 || !states.every(isSessionListState))
      ) {
        return failure(
          "INVALID_REQUEST",
          `Unknown session state (valid: ${SESSION_LIST_STATES.join(", ")}).`,
        );
      }
      const observedAt = now();
      const since =
        window === null
          ? observedAt - 24 * 60 * 60 * 1000
          : sessionUsageWindowSince(window, observedAt);
      const ticketSelector = request.args["ticket"];
      let ticket: { ticketId: string; projectId: string } | null = null;
      if (ticketSelector !== undefined) {
        if (typeof ticketSelector !== "string" || ticketSelector.trim() === "") {
          return failure("INVALID_REQUEST", "A ticket display id is required.");
        }
        try {
          const resolved: unknown = await io.query("board:resolveTicketKey", {
            key: ticketSelector.trim(),
          });
          if (
            !isRecord(resolved) ||
            typeof resolved["ticketId"] !== "string" ||
            typeof resolved["projectId"] !== "string"
          ) {
            throw new CloudReadMalformed("ticket key");
          }
          ticket = { ticketId: resolved["ticketId"], projectId: resolved["projectId"] };
        } catch (error) {
          if (error instanceof CloudFunctionError && error.code === "not_found") {
            return failure("TICKET_NOT_FOUND", error.message);
          }
          if (error instanceof CloudFunctionError && error.code === "ambiguous_key") {
            return failure("AMBIGUOUS_TICKET", error.message);
          }
          throw error;
        }
      }
      const { projects } = await io.projects();
      let project: ProjectRow;
      if (ticket !== null) {
        const ticketProjectId = ticket.projectId;
        const owner = projects.find(({ id }) => id === ticketProjectId);
        if (owner === undefined) {
          return failure(
            "PROJECT_NOT_FOUND",
            `Ticket ${String(ticketSelector)}'s project is not one you can see.`,
          );
        }
        if (request.args["project"] !== undefined) {
          const selected = await projectFor(io, request.args["project"]);
          if (selected.id !== owner.id) {
            return failure(
              "CONTEXT_MISMATCH",
              `Ticket ${String(ticketSelector)} belongs to project ${owner.name}, not the requested project ${selected.name}.`,
            );
          }
        }
        project = owner;
      } else {
        project = await projectFor(io, request.args["project"]);
      }
      const scan = await listing(io, project.id, ticket?.ticketId ?? null, SESSION_LIST_MAX_PAGES);
      const keyOf = await ticketKeys(
        io,
        project,
        scan.rows.map((row) => row.ticketId),
      );
      const records = subagentRecords(scan.rows);
      const rows = scan.rows.map((row) => ({
        id: shortSessionId(row.id),
        kind: "chat",
        role: row.role,
        ticket: keyOf(row.ticketId),
        title: row.title,
        status: row.activity as string,
        waitingOn: row.waitingOn,
        // Why a turn died is the fold's (`show` and `peek` read it); every
        // other state has none, as locally.
        ...(row.activity === "interrupted" ? {} : { interruptedReason: null, interruption: null }),
        pendingSubagents: pendingSubagentIds(row.id, records),
        lastActivityAgeMs: Math.max(0, observedAt - row.lastActivityAt),
        ageMs: Math.max(0, observedAt - row.createdAt),
        live: row.live,
        model: row.model === null ? null : `${row.model.providerId}/${row.model.modelId}`,
        reasoning: row.model === null ? null : row.model.reasoningLevel,
        costUsd: row.usage.costUsd,
        costBasis: row.usage.costBasis,
        costCoverage: row.usage.costCoverage,
        tokens: row.usage.tokens,
        startedBy: publicStartedBy(row.origin, undefined),
      }));
      const scoped = rows.filter(
        (row) =>
          states === undefined || (states as unknown[]).some((state) => state === row.status),
      );
      const visible = scoped.filter(
        (row) =>
          request.args["all"] === true ||
          ["working", "waiting", "interrupted"].includes(row.status) ||
          (row.status === "idle" && row.pendingSubagents.length > 0) ||
          row.lastActivityAgeMs <= observedAt - since,
      );
      visible.sort((a, b) => a.lastActivityAgeMs - b.lastActivityAgeMs);
      return {
        v: 1,
        ok: true,
        data: {
          sessions: visible,
          hidden: scoped.length - visible.length,
          // The listing was read to its bound: older Sessions exist unread, so
          // `hidden` counts only the ones read.
          ...(scan.complete ? {} : { truncated: true }),
        },
      };
    }),

    "session.show": verb(async (io, request) => {
      const resolved = await targetFor(io, request);
      const { target, view } = await snapshotOf(io, resolved.target.id);
      const observedAt = now();
      const rows =
        resolved.rows ?? (await listing(io, target.projectId, null, SESSION_LIST_MAX_PAGES)).rows;
      const { projects } = await io.projects();
      const project = projects.find(({ id }) => id === target.projectId);
      const keyOf = await ticketKeys(io, project, [target.ticketId]);
      const records = subagentRecords(rows);
      const parent = rows.find((row) => row.id === target.parentSessionId);
      const children = rows
        .filter(
          (row) =>
            (row.role === "subagent" && row.parentSessionId === target.id) ||
            (row.origin?.kind === "session" && row.origin.sessionId === target.id),
        )
        .toSorted((a, b) => a.createdAt - b.createdAt)
        .map(sessionRelationSummary);
      const startedByParent =
        target.origin?.kind === "session"
          ? (rows.find((row) => row.id === (target.origin as { sessionId: string }).sessionId)
              ?.title ?? null)
          : undefined;
      return {
        v: 1,
        ok: true,
        data: {
          id: shortSessionId(target.id),
          title: target.title,
          project: project?.name ?? null,
          ticket: keyOf(target.ticketId),
          ageMs: Math.max(0, observedAt - target.createdAt),
          lastActivityAgeMs: Math.max(0, observedAt - target.lastActivityAt),
          kind: "chat",
          status: target.activity,
          role: target.role,
          signal:
            view === null
              ? listingSignal(target, observedAt)
              : publicSignal(view.signal, observedAt),
          waitingOn: target.waitingOn,
          pendingQuestions: view === null ? [] : pendingSessionQuestions(asProjection(view)),
          ...(view === null
            ? {}
            : {
                interruptedReason: interruptedReasonOf(target.activity, view),
              }),
          startedBy: publicStartedBy(target.origin, startedByParent),
          parentSession:
            target.parentSessionId === null
              ? null
              : parent
                ? sessionRelationSummary(parent)
                : { id: shortSessionId(target.parentSessionId), title: null },
          children,
          pendingSubagents: pendingSubagentIds(target.id, records),
          live: target.live,
          ...(view === null ? {} : viewOrchestrationCells(view)),
          ...(view === null
            ? {
                model:
                  target.model === null
                    ? null
                    : `${target.model.providerId}/${target.model.modelId}`,
                reasoning: target.model === null ? null : target.model.reasoningLevel,
                costUsd: target.usage.costUsd,
                costBasis: target.usage.costBasis,
                costCoverage: target.usage.costCoverage,
                tokens: target.usage.tokens,
              }
            : {
                ...viewModelCells(view),
                ...usageCells(view.usage ?? EMPTY_SESSION_USAGE_SUMMARY),
              }),
        },
      };
    }),

    "session.peek": verb(async (io, request) => {
      const resolved = await targetFor(io, request);
      const { target, view } = await foldedSnapshot(io, resolved.target);
      const limit = positiveIntOr(request.args["lines"], CHAT_PEEK_ENTRIES);
      const rows =
        resolved.rows ?? (await listing(io, target.projectId, null, SESSION_LIST_MAX_PAGES)).rows;
      const window = await historyWindow(io, target.id, (events) => {
        let references = 0;
        let turnStarted = false;
        for (const event of events) {
          if (transcriptReferenceFor(event) !== null) references += 1;
          if (event.payload.kind === "turn.started") turnStarted = true;
        }
        return references >= limit && turnStarted;
      });
      const bodies = bodyReader(io, target.id, window);
      const tailReferences = window.events
        .map(transcriptReferenceFor)
        .filter((reference): reference is TranscriptReference => reference !== null)
        .slice(-limit);
      await swallowBodyFailure(() => bodies.prefetch(tailReferences));
      const tail = await readSessionTranscriptTail(
        {
          listEvents: async () => window.events,
          readArtifact: (reference) => bodies.read(reference),
        },
        { sessionId: target.id, limit },
      );
      const turnStartedInWindow = window.events.some(
        (event) => event.payload.kind === "turn.started",
      );
      const observedAt = now();
      const attention = view.attention.primary;
      const stopped = view.stopped;
      const signal = publicSignal(view.signal, observedAt);
      return {
        v: 1,
        ok: true,
        data: {
          session: shortSessionId(target.id),
          attention:
            attention === null
              ? null
              : {
                  ...sessionPeekAttention(attention, {
                    turnActive: view.turnActive,
                    liveExecutor: view.liveAttachment,
                  }),
                  detail: clip(attention.detail),
                },
          stopped:
            stopped === null
              ? null
              : {
                  ...stopped,
                  reason: clip(stopped.reason),
                  by:
                    stopped.by.kind === "session"
                      ? { kind: "session", sessionId: shortSessionId(stopped.by.sessionId) }
                      : stopped.by,
                },
          signal: signal === null ? null : { ...signal, reason: clip(signal.reason) },
          lastTurnOutcome: view.lastTurnOutcome,
          status: target.activity,
          waitingOn: target.waitingOn,
          pendingQuestions: pendingSessionQuestions(asProjection(view)),
          interruptedReason: interruptedReasonOf(target.activity, view),
          ...viewOrchestrationCells(view),
          pendingSubagents: pendingSubagentIds(target.id, subagentRecords(rows)),
          startedBy: publicStartedBy(target.origin, undefined),
          interruption:
            target.activity === "stopped" ? null : sessionInterruptionDetail(asProjection(view)),
          live: target.live,
          lastActivityAgeMs: Math.max(0, observedAt - target.lastActivityAt),
          // Life-long counts only when the window reached the first fact.
          turns: window.complete ? tail.turns : null,
          turnDepth: window.complete || turnStartedInWindow ? tail.turnDepth : null,
          messages: window.complete ? tail.messages : null,
          unreadable: tail.unreadable,
          ...(tail.unreadable > 0 && bodies.reason !== null
            ? { unreadableReason: bodies.reason }
            : {}),
          historyComplete: window.complete,
          transcript: tail.entries.map((entry) => {
            const row: {
              ageMs: number;
              role: string;
              text: string;
              tools: readonly string[];
              delivery?: string;
            } = {
              ageMs: Math.max(0, observedAt - entry.at),
              role: entry.role,
              text: entry.text,
              tools: entry.tools,
            };
            if (entry.delivery !== undefined) row.delivery = entry.delivery;
            return row;
          }),
        },
      };
    }),

    "session.answer": verb(async (io, request) => {
      const resolved = await targetFor(io, request);
      const { target, view } = await foldedSnapshot(io, resolved.target);
      const window = await historyWindow(io, target.id, (events) => {
        let turnStarted = false;
        let answer = false;
        for (const event of events) {
          if (event.payload.kind === "turn.started") turnStarted = true;
          // A message whose role was recorded beside it, or one recorded
          // before roles were (its body says): either may be the answer.
          if (
            event.payload.kind === "transcript.referenced" &&
            (event.payload.digest === undefined || event.payload.digest.role === "assistant")
          ) {
            answer = true;
          }
        }
        return turnStarted && answer;
      });
      const bodies = bodyReader(io, target.id, window);
      const candidates = window.events
        .flatMap((event) =>
          event.payload.kind === "transcript.referenced" ? [event.payload.reference] : [],
        )
        .slice(-STAGE_ARTIFACTS_MAX_BATCH);
      await swallowBodyFailure(() => bodies.prefetch(candidates));
      const read = await readSessionAnswer(
        {
          listEvents: async () => window.events,
          readArtifact: (reference) => bodies.read(reference),
        },
        { sessionId: target.id },
      );
      const turnStartedInWindow = window.events.some(
        (event) => event.payload.kind === "turn.started",
      );
      const state: SessionAnswerState =
        window.complete || turnStartedInWindow
          ? foldSessionAnswerState(window.events).state
          : stateFromView(view);
      // An answer older than the window is not "nothing said": say it could
      // not be read, and why.
      const beyondWindow = !window.complete && read.text === null && !read.unreadable;
      return {
        v: 1,
        ok: true,
        data: {
          session: shortSessionId(target.id),
          role: target.role,
          title: target.title,
          state,
          signal: publicSignal(view.signal, now()),
          turns: window.complete ? read.turns : null,
          unreadable: read.unreadable || beyondWindow,
          ...(read.unreadable && bodies.reason !== null
            ? { unreadableReason: bodies.reason }
            : beyondWindow
              ? {
                  unreadableReason: `Its last message is older than the newest ${SESSION_HISTORY_MAX_PAGES * HISTORY_PAGE} facts this read covers.`,
                }
              : {}),
          historyComplete: window.complete,
          answer: read.text,
        },
      };
    }),
  };
}

/** A turn state from the fold, for a history window that holds no turn start. */
function stateFromView(view: CloudSessionView): SessionAnswerState {
  if (view.latestTurnId === null) return "not-started";
  if (view.turnActive) return "running";
  if (view.stopped !== null) return "stopped";
  return view.lastTurnOutcome ?? "interrupted";
}

/** A staging prefetch that fails leaves each body to its own read, which reports it. */
async function swallowBodyFailure(read: () => Promise<void>): Promise<void> {
  try {
    await read();
  } catch (error) {
    if (
      error instanceof CloudFunctionError ||
      error instanceof CloudOfflineError ||
      error instanceof CloudReadMalformed
    ) {
      return;
    }
    throw error;
  }
}

function bodyReason(error: unknown): string {
  if (error instanceof BodyUnreadable || error instanceof CloudReadMalformed) return error.message;
  if (error instanceof CloudFunctionError) {
    return error.code === "storage_unconfigured"
      ? "This Volli Cloud deployment has no object storage configured, so packed or spilled bodies cannot be read."
      : `Volli Cloud refused the transcript read (${error.code}): ${error.message}`;
  }
  if (error instanceof CloudOfflineError) return "Volli Cloud stopped answering mid-read.";
  return "A transcript body could not be read.";
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyUnreadable("A transcript body is not JSON.");
  }
}

/**
 * A `volli.transcript-pack/1` object's bodies by digest. The header must name
 * this Session and the segment's range; every line after it is one artifact.
 */
function readPack(
  text: string,
  sessionId: string,
  segment: Pick<Segment, "firstSequence" | "lastSequence">,
): Map<string, unknown> {
  const lines = text.split("\n").filter((line) => line.length > 0);
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    throw new BodyUnreadable("A transcript pack's header is not JSON.");
  }
  if (
    !isRecord(header) ||
    header["format"] !== TRANSCRIPT_PACK_FORMAT ||
    header["sessionId"] !== sessionId ||
    header["firstSequence"] !== segment.firstSequence ||
    header["lastSequence"] !== segment.lastSequence
  ) {
    throw new BodyUnreadable("A transcript pack does not match its segment.");
  }
  if (typeof header["artifactCount"] === "number" && header["artifactCount"] !== lines.length - 1) {
    throw new BodyUnreadable("A transcript pack is incomplete.");
  }
  const bodies = new Map<string, unknown>();
  for (const line of lines.slice(1)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new BodyUnreadable("A transcript pack holds an entry that is not JSON.");
    }
    if (!isRecord(entry) || typeof entry["digest"] !== "string" || !("body" in entry)) {
      throw new BodyUnreadable("A transcript pack holds a malformed entry.");
    }
    bodies.set(entry["digest"], entry["body"]);
  }
  return bodies;
}
