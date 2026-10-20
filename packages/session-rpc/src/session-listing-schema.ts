/**
 * JSON-wire schemas for the Session listing (VC-713, feature
 * `sessions.listing`): the rows the desktop's own listing serves
 * (`SessionListingRow`, `volli:session-list`), so a Client of a remote host
 * paints its rail, Home and ticket panel from the same shape and subscribes
 * from a row's full Session id.
 *
 * Frozen from the start (AM3): every string and array is bounded
 * (`SESSION_LISTING_BOUNDS`, which the host clips display text to), and every
 * enum and union is declared CLOSED below — a listing reader branches on a
 * row's `kind`, its `activity` and its provenance, so an unknown value would
 * be misdrawn, not skipped. A later fact joins a row as a new optional field,
 * never as a new member of one of these. No transforms: these validators also
 * publish through `z.toJSONSchema` (VC-669).
 */
import {
  COST_BASES,
  REASONING_LEVELS,
  SESSION_LAUNCH_KINDS,
  SESSION_LISTING_BOUNDS,
  SESSION_PLACEMENTS,
  SESSION_ROLES,
  type SessionListingPage,
  type SessionListingRow,
} from "@volli/shared";
import { z } from "zod";

const integer = z.number().int();
const count = integer.nonnegative();
/** Every string is bounded (`SESSION_LISTING_BOUNDS`): the host clips display text to these. */
const id = z.string().max(SESSION_LISTING_BOUNDS.id);
const nullableId = id.nullable();
const text = z.string().max(SESSION_LISTING_BOUNDS.text);
const nullableText = text.nullable();
const path = z.string().max(SESSION_LISTING_BOUNDS.path);
const name = z.string().max(SESSION_LISTING_BOUNDS.name);

/** A Session's input: the project, the one resource the catalog authorizes. */
export const sessionListingInput = z.object({ projectId: z.string().min(1).max(512) });
/** One ticket's Sessions: the ticket is the resource, so a foreign one is refused unread. */
export const sessionListingForTicketInput = z.object({ ticketId: z.string().min(1).max(256) });

// Enums. Every one is CLOSED (no `x-volli-open-union`, no tolerant reader):
// the rail, Home and ticket panel branch on each, and an unknown value would
// be drawn wrongly rather than skipped. A new value needs a new feature.
/** Closed: the model policy a picker and a row read (`REASONING_LEVELS`). */
const reasoningLevel = z.enum(REASONING_LEVELS);
/** Closed: a terminal row's launch and placement (`SESSION_LAUNCH_KINDS`, `SESSION_PLACEMENTS`). */
const launchKind = z.enum(SESSION_LAUNCH_KINDS);
const placement = z.enum(SESSION_PLACEMENTS);
/** Closed: a chat row's honest subset of the activity states (`ChatSessionRecord.activity`). */
const activity = z.enum(["working", "waiting", "idle", "stopped", "interrupted"]);
/** Closed: what a waiting row waits on (`ChatWaitingReason`). */
const waitingOn = z.enum(["question", "permission", "auth"]);
/** Closed: how the latest turn ended (`SessionTurnOutcome`). */
const outcome = z.enum(["completed", "interrupted", "failed"]);
/** Closed: the Role a Session was created under (`SESSION_ROLES`). */
const role = z.enum(SESSION_ROLES);
/** Closed: a usage summary's coverage and basis (`SessionUsageSummary`). */
const costCoverage = z.enum(["complete", "partial", "unavailable"]);
const costBasis = z.enum([...COST_BASES, "mixed"]);
/** Closed: the host's own reasons for a turn (`SessionOrigin`, kind `volli`). */
const hostReason = z.enum([
  "watch-notice",
  "subagent-notice",
  "relaunch-recovery",
  "scheduled-resume",
  "supervision",
  "browser-notice",
  "shell-notice",
  "worktree-notice",
  "auto-title",
]);

const modelSelection = z.object({ providerId: name, modelId: name, reasoningLevel });

/** Closed union on `kind`: who asked for the latest turn (`SessionOrigin`). */
const turnOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("session"), sessionId: id }),
  z.object({ kind: z.literal("automation"), automationRunId: id, automationName: nullableText }),
  z.object({ kind: z.literal("volli"), reason: hostReason }),
]);

const terminalRecord = z.object({
  id,
  projectId: id,
  ticketId: nullableId,
  harnessId: name,
  activeHarnessId: name.nullable(),
  harnessSessionId: nullableId,
  launchKind,
  placement,
  title: text,
  cwd: path,
  createdAt: integer,
  endedAt: integer.nullable(),
  exitCode: integer.nullable(),
  lastActivityAt: integer,
  bornTicketless: z.boolean(),
});

const chatRecord = z.object({
  latestTurnOrigin: turnOrigin.nullable().optional(),
  resumedAfterStop: z.boolean().optional(),
  sessionId: id,
  title: text,
  projectId: id,
  ticketId: nullableId,
  createdAt: integer,
  adapterId: name.nullable(),
  live: z.boolean(),
  activity,
  waitingOn: waitingOn.nullable(),
  outcome: outcome.nullable(),
  lastActivityAt: integer,
  bornTicketless: z.boolean(),
  role,
  parentSessionId: nullableId,
  model: modelSelection.nullable(),
});

const usageSummary = z.object({
  requestCount: count,
  tokenRequestCount: count,
  pricedRequestCount: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  knownCostUsd: z.number().nullable(),
  costCoverage,
  costBasis,
  cachedInputShare: z.number().nullable(),
});

/** Closed union on `kind`: who started the Session (`SessionProvenance`). */
const provenance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({
    kind: z.literal("automation"),
    automationName: nullableText,
    automationRunId: nullableId,
  }),
  z.object({ kind: z.literal("session"), parentSessionId: id, parentTitle: nullableText }),
]);

const rowFacts = {
  usage: usageSummary,
  provenance,
  read: z.object({ unreadSince: integer.nullable() }).optional(),
};

/** Closed union on `kind`: a terminal companion's row or a chat's (`SessionListingRow`). */
export const sessionListingRowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), record: terminalRecord, ...rowFacts }),
  z.object({ kind: z.literal("chat"), record: chatRecord, ...rowFacts }),
]);

export const sessionListingPageSchema = z.object({
  sessions: z.array(sessionListingRowSchema).max(SESSION_LISTING_BOUNDS.rows),
  omitted: count,
});

/** The typed views the exactness test compares the uncast schemas to. */
export type SessionListingWireTypes = {
  readonly row: SessionListingRow;
  readonly page: SessionListingPage;
};

/**
 * A handler's answer as its wire type. The JSON is the same; the types differ
 * only in readonly-ness and in the domain's wider string brands. The output
 * validator checks the value on every network door, and
 * `session-listing-schema.test-d.ts` checks key by key that nothing is stripped.
 */
export function listingWire(page: SessionListingPage): z.output<typeof sessionListingPageSchema> {
  return page as z.output<typeof sessionListingPageSchema>;
}
