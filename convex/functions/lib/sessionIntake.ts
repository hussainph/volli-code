/**
 * The Session intake: how accepted facts enter the cloud ledger and fold.
 * `sessions.accept` (the claimed runner's drain) and the internal catch-up
 * both run through here, so a fact means the same thing whichever path
 * folded it. What a folded fact derives (turns, attention, receipts, the
 * listing row) is in `sessionDerived.ts`.
 *
 * The rules, in the order `accept` applies them:
 * 1. The head comes from `sessionIntake` (one document read), never from an
 *    index scan, whose cost grows with the Session's length.
 * 2. The caller must be the claimed runner at the claimed generation
 *    (`fenced`), working for the Session's owner (`not_your_runner`).
 * 3. Sequences are contiguous from 1. A resent fact at or below the head is a
 *    duplicate when its id and envelope match the stored one, and `conflict`
 *    (a forked history) when they do not; the first new fact must be the
 *    head + 1 (`out_of_order`, with the head, so the drain resends from it).
 *    A new fact's id must be new to the Session.
 * 4. Every fact is stored. An unknown kind is stored with `kindKnown: false`
 *    and not folded (a build that learns it refolds); a malformed known kind,
 *    or one the bounded fold cannot hold, is stored quarantined, not folded,
 *    and raised to the owner, so the sequence keeps moving and nothing is
 *    dropped.
 * 5. The bounded fold (`CloudSessionState`) advances, and with it what each
 *    fact derives.
 *
 * Session facts cross the backend boundary as JSON text, the codec's own wire
 * form, and are stored that way: their payloads carry object keys a Convex
 * value refuses (`$schema` in an MCP tool schema, non-ASCII keys).
 */

import {
  UnknownSessionEventKindError,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
  SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY,
  assertSessionProjectionCheckpoint,
  assertSessionEvent,
  decodeSessionEventPayload,
  decodeSessionEventProvenance,
  encodeSessionJson,
  readSessionOrigin,
  type Session,
  type SessionEvent,
  type SessionEventPayload,
} from "@volli/shared";
import {
  CLOUD_SESSION_FOLD_VERSION,
  CloudSessionStateTooLargeError,
  cloudSessionView as readCloudSessionView,
  foldCloudSessionState,
  isUuid,
  readCloudSessionState,
  type CloudSessionState,
} from "@volli/shared/cloud";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server";
import { raiseQuarantine } from "./attention";
import { findVisibleProject, projectImporting } from "./auth";
import type { CallingRunner } from "./runnerAuth";
import { visibilityForNewSession } from "./visibility";
import { EMPTY_USAGE_TOTALS, deriveFromFact, stableJson, syncListing } from "./sessionDerived";
import { onDelegationHead } from "./delegations";
import { endedTurnsOf, scheduleStreamCleanup } from "./streamChunks";
import { intakeError, type IntakeDiagnostics } from "./sessionIntakeDiagnostics";

// ── limits ──────────────────────────────────────────────────────────────────

/** Facts per `accept`. Steady state sends one; catch-up and migration batch. */
const MAX_ACCEPT_EVENTS = 100;
/** A batch of more than one fact stays under this; one larger fact is sent alone. */
const MAX_ACCEPT_BATCH_BYTES = 128 * 1024;
/** One fact's JSON text. Larger payloads are spilled to object storage (not yet built). */
const MAX_EVENT_BYTES = 256 * 1024;
/** Event ids are frozen derived strings; this bounds them. */
const MAX_EVENT_ID_LENGTH = 512;
/** Facts one catch-up step folds, and the bytes it reads, before it schedules the next. */
const CATCH_UP_PAGE_EVENTS = 256;
const CATCH_UP_PAGE_BYTES = 4 * 1024 * 1024;
/** A scheduled catch-up that has not finished in this long is scheduled again. */
const CATCH_UP_RETRY_MS = 60_000;
const QUARANTINE_DETAIL_LENGTH = 1_000;

export interface AcceptReply {
  acceptedThrough: number;
  /** Resent facts that matched what is stored. */
  duplicates: number;
  /** New facts stored quarantined: a known kind this build could not read or fold. */
  quarantined: number;
  /** New facts of a kind this build does not know, stored and not folded. */
  unknownKinds: number;
}

// ── the envelope on the wire ────────────────────────────────────────────────

/** One fact as the runner sent it, its envelope checked, its payload not yet. */
interface Envelope {
  id: string;
  sequence: number;
  occurredAt: number;
  recordedAt: number;
  attachmentId: string | null;
  commandId: string | null;
  provenance: unknown;
  payload: unknown;
  kind: string;
  bytes: number;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * The envelope of one fact's JSON text. Only what the intake itself needs is
 * checked here (id, Session, sequence, clocks, the two JSON parts); a fact
 * whose envelope is unreadable is refused, because it cannot even be stored
 * in order.
 */
function readEnvelope(text: string, sessionId: string, bytes: number, head: number): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw intakeError("invalid_request", "A fact is not JSON.", head);
  }
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_EVENT_ID_LENGTH ||
    value.sessionId !== sessionId ||
    !Number.isInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.occurredAt !== "number" ||
    !Number.isFinite(value.occurredAt) ||
    typeof value.recordedAt !== "number" ||
    !Number.isFinite(value.recordedAt) ||
    !optionalId(value.attachmentId) ||
    !optionalId(value.commandId) ||
    !isRecord(value.provenance) ||
    !isRecord(value.payload)
  ) {
    throw intakeError("invalid_request", "A fact's envelope is not a Session event.", head);
  }
  const kind = value.payload.kind;
  return {
    id: value.id,
    sequence: value.sequence as number,
    occurredAt: value.occurredAt,
    recordedAt: value.recordedAt,
    attachmentId: value.attachmentId ?? null,
    commandId: value.commandId ?? null,
    provenance: value.provenance,
    payload: value.payload,
    kind: typeof kind === "string" ? kind.slice(0, 200) : "",
    bytes,
  };
}

/**
 * The stored JSON text of a payload or provenance: the codec's canonical
 * encoding, which allowlists credential-bearing interactions. A value the
 * codec refuses (a quarantined fact) is stored as sent, minus any
 * `credential` field, so a malformed interaction cannot store a secret.
 */
function storedJson(value: unknown): string {
  try {
    return encodeSessionJson(value);
  } catch {
    return JSON.stringify(value, (key, item: unknown) => (key === "credential" ? undefined : item));
  }
}

/**
 * A stored payload or provenance as a value. The intake stores JSON text; a
 * row written another way (the migration import stores the value itself) is
 * read as it is.
 */
function storedValue(stored: unknown): unknown {
  try {
    return typeof stored === "string" ? JSON.parse(stored) : stored;
  } catch (error) {
    throw intakeError(
      "corrupt_history",
      "An accepted fact's stored JSON is unreadable.",
      null,
      error,
    );
  }
}

function sameStoredJson(stored: unknown, incoming: unknown): boolean {
  return stableJson(storedValue(stored)) === stableJson(JSON.parse(storedJson(incoming)));
}

type Readability =
  | { kindKnown: true; quarantine: null; event: SessionEvent }
  | { kindKnown: false; quarantine: null }
  | { kindKnown: true; quarantine: { code: string; detail: string } };

/** Reads a fact with the shared codec, as every other ledger does on write. */
function readFact(sessionId: string, envelope: Envelope): Readability {
  const candidate = {
    id: envelope.id,
    sessionId,
    sequence: envelope.sequence,
    occurredAt: envelope.occurredAt,
    recordedAt: envelope.recordedAt,
    attachmentId: envelope.attachmentId,
    commandId: envelope.commandId,
    provenance: envelope.provenance,
    payload: envelope.payload,
  };
  const context = `Session event ${envelope.sequence}`;
  try {
    assertSessionEvent(candidate as SessionEvent, context);
    return {
      kindKnown: true,
      quarantine: null,
      event: {
        ...candidate,
        provenance: decodeSessionEventProvenance(candidate.provenance, `${context}.provenance`),
        payload: decodeSessionEventPayload(candidate.payload, `${context}.payload`),
      },
    };
  } catch (error) {
    if (error instanceof UnknownSessionEventKindError)
      return { kindKnown: false, quarantine: null };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kindKnown: true,
      quarantine: { code: "malformed_event", detail: detail.slice(0, QUARANTINE_DETAIL_LENGTH) },
    };
  }
}

function storedEnvelope(row: Doc<"sessionEvents">): Envelope {
  return {
    id: row.eventId,
    sequence: row.sequence,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    attachmentId: row.attachmentId,
    commandId: row.commandId,
    provenance: storedValue(row.provenance),
    payload: storedValue(row.payload),
    kind: row.kind,
    bytes: row.bytes,
  };
}

/**
 * A stored fact read again with this build's codec. A retired kind reads as
 * unknown, a stricter decode as quarantined. Unreadable stored JSON is storage
 * corruption, not an unknown event, and fails with typed `corrupt_history`.
 */
export function readStoredFact(row: Doc<"sessionEvents">): Readability {
  return readFact(row.sessionId, storedEnvelope(row));
}

// ── accept ──────────────────────────────────────────────────────────────────

export async function acceptFacts(
  ctx: MutationCtx,
  caller: CallingRunner,
  args: { sessionId: string; generation: number; events: readonly string[] },
  diagnostics?: IntakeDiagnostics,
): Promise<AcceptReply> {
  const now = Date.now();
  const { sessionId } = args;
  if (diagnostics) diagnostics.phase = "validate";
  if (!isUuid(sessionId)) throw intakeError("invalid_request", "The session id is not a UUID.");
  if (diagnostics) diagnostics.phase = "head";
  let intake = await intakeOf(ctx, sessionId);
  const head = intake?.acceptedThrough ?? 0;
  if (diagnostics) {
    diagnostics.acceptedThrough = head;
    diagnostics.expectedSequence = head + 1;
    diagnostics.phase = "validate";
  }
  if (args.events.length === 0 || args.events.length > MAX_ACCEPT_EVENTS) {
    throw intakeError(
      "invalid_request",
      `Send between 1 and ${MAX_ACCEPT_EVENTS} facts at a time.`,
      head,
    );
  }
  const sizes = diagnostics?.eventBytes ?? args.events.map(utf8Bytes);
  const largest = Math.max(...sizes);
  if (largest > MAX_EVENT_BYTES) {
    throw intakeError(
      "event_too_large",
      `A fact is ${largest} bytes; the limit is ${MAX_EVENT_BYTES}.`,
      head,
    );
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (args.events.length > 1 && total > MAX_ACCEPT_BATCH_BYTES) {
    throw intakeError(
      "batch_too_large",
      `A batch is ${total} bytes; send batches under ${MAX_ACCEPT_BATCH_BYTES} or one fact alone.`,
      head,
    );
  }
  const envelopes = args.events.map((text, index) =>
    readEnvelope(text, sessionId, sizes[index]!, head),
  );

  if (diagnostics) {
    diagnostics.firstSequence = envelopes[0]!.sequence;
    diagnostics.lastSequence = envelopes.at(-1)!.sequence;
    diagnostics.sequence = envelopes[0]!.sequence;
    diagnostics.kind = envelopes[0]!.kind;
    diagnostics.phase = "birth";
  }
  let session: Doc<"sessions">;
  if (intake === null) {
    ({ session, intake } = await createFromFirstFact(ctx, caller, args, envelopes[0]!));
  } else {
    const row = await sessionRow(ctx, sessionId);
    // A Session of a project still being imported takes no facts until its commit.
    if (row === null || row.deletedAt !== null || (await projectImporting(ctx, row.projectId))) {
      throw intakeError("not_found", "That session does not exist.", head);
    }
    session = row;
  }
  if (diagnostics) diagnostics.phase = "claim";
  if (
    intake.state === "released" ||
    intake.claim.runnerId !== caller.runnerId ||
    intake.claim.generation !== args.generation
  ) {
    throw intakeError("fenced", "This runner no longer holds the session's claim.", head);
  }
  if (session.ownerUserId !== caller.ownerUserId) {
    throw intakeError("not_your_runner", "This runner does not run its owner's work.", head);
  }
  if (diagnostics) diagnostics.phase = "validate";
  for (const [index, envelope] of envelopes.entries()) {
    if (diagnostics) {
      diagnostics.sequence = envelope.sequence;
      diagnostics.kind = envelope.kind;
    }
    if (envelope.sequence !== envelopes[0]!.sequence + index) {
      throw intakeError("out_of_order", "A batch must be contiguous.", head);
    }
  }

  if (diagnostics) diagnostics.phase = "duplicates";
  let duplicates = 0;
  const fresh: Envelope[] = [];
  for (const envelope of envelopes) {
    if (diagnostics) {
      diagnostics.sequence = envelope.sequence;
      diagnostics.kind = envelope.kind;
    }
    if (envelope.sequence <= head) {
      await checkDuplicate(ctx, sessionId, envelope, head);
      duplicates += 1;
    } else if (envelope.sequence === head + fresh.length + 1) {
      fresh.push(envelope);
    } else {
      throw intakeError(
        "out_of_order",
        `Expected sequence ${head + 1}, got ${envelope.sequence}.`,
        head,
      );
    }
  }
  if (fresh.length === 0) {
    return { acceptedThrough: head, duplicates, quarantined: 0, unknownKinds: 0 };
  }
  // A new fact's id must be new to the Session: the batch's and the stored ones.
  const ids = new Set<string>();
  for (const envelope of fresh) {
    if (diagnostics) {
      diagnostics.sequence = envelope.sequence;
      diagnostics.kind = envelope.kind;
    }
    const taken =
      ids.has(envelope.id) ||
      (await ctx.db
        .query("sessionEvents")
        .withIndex("by_session_event", (q) =>
          q.eq("sessionId", sessionId).eq("eventId", envelope.id),
        )
        .first()) !== null;
    if (taken) {
      throw intakeError("conflict", `Fact ${envelope.sequence} reuses an accepted id.`, head);
    }
    ids.add(envelope.id);
  }

  if (diagnostics) diagnostics.phase = "write";
  let quarantined = 0;
  let unknownKinds = 0;
  const foldable: FoldFact[] = [];
  for (const envelope of fresh) {
    if (diagnostics) {
      diagnostics.sequence = envelope.sequence;
      diagnostics.kind = envelope.kind;
    }
    const read = readFact(sessionId, envelope);
    if (
      read.quarantine === null &&
      read.kindKnown &&
      read.event.payload.kind === "session.created"
    ) {
      assertBirthMatches(session, read.event.payload, envelope.payload, head);
    }
    if (read.quarantine !== null) quarantined += 1;
    if (!read.kindKnown) unknownKinds += 1;
    const rowId = await ctx.db.insert("sessionEvents", {
      sessionId,
      sequence: envelope.sequence,
      eventId: envelope.id,
      kind: envelope.kind,
      kindKnown: read.kindKnown,
      quarantine: read.quarantine,
      occurredAt: envelope.occurredAt,
      recordedAt: envelope.recordedAt,
      acceptedAt: now,
      attachmentId: envelope.attachmentId,
      commandId: envelope.commandId,
      provenance: storedJson(envelope.provenance),
      payload: storedJson(envelope.payload),
      bytes: envelope.bytes,
    });
    if (read.quarantine !== null) await raiseQuarantine(ctx, session, envelope, read.quarantine);
    else if (read.kindKnown) foldable.push({ event: read.event, rowId, learned: false });
  }
  const acceptedThrough = head + fresh.length;
  await ctx.db.patch(intake._id, {
    acceptedThrough,
    lastEventId: fresh.at(-1)!.id,
    lastAcceptedAt: now,
  });
  // Streamed text: the chunk rows of every turn this batch ended go (S3).
  if (diagnostics) diagnostics.phase = "cleanup";
  await scheduleStreamCleanup(
    ctx,
    sessionId,
    { turnIds: endedTurnsOf(foldable.map(({ event }) => event)), messageIds: [] },
    now,
  );
  quarantined += await advanceFold(ctx, session, head, foldable, acceptedThrough, now, diagnostics);
  return { acceptedThrough, duplicates, quarantined, unknownKinds };
}

async function intakeOf(ctx: MutationCtx, sessionId: string) {
  return ctx.db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}

async function sessionRow(ctx: MutationCtx, sessionId: string): Promise<Doc<"sessions"> | null> {
  return ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
}

/**
 * A resend at or below the head. One indexed read: the stored fact must have
 * the same id and the same envelope. A fact that is no longer stored hot was
 * compacted, and an archive covering it is authoritative.
 */
async function checkDuplicate(
  ctx: MutationCtx,
  sessionId: string,
  envelope: Envelope,
  head: number,
): Promise<void> {
  const row = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_sequence", (q) =>
      q.eq("sessionId", sessionId).eq("sequence", envelope.sequence),
    )
    .unique();
  if (row === null) {
    const archive = await ctx.db
      .query("eventArchives")
      .withIndex("by_session_first", (q) =>
        q.eq("sessionId", sessionId).lte("firstSequence", envelope.sequence),
      )
      .order("desc")
      .first();
    if (archive !== null && archive.lastSequence >= envelope.sequence) return;
    throw intakeError("conflict", `Fact ${envelope.sequence} is accepted but not stored.`, head);
  }
  const same =
    row.eventId === envelope.id &&
    row.occurredAt === envelope.occurredAt &&
    row.recordedAt === envelope.recordedAt &&
    row.attachmentId === envelope.attachmentId &&
    row.commandId === envelope.commandId &&
    sameStoredJson(row.payload, envelope.payload) &&
    sameStoredJson(row.provenance, envelope.provenance);
  if (!same) {
    throw intakeError(
      "conflict",
      `Fact ${envelope.sequence} differs from the one already accepted.`,
      head,
    );
  }
}

/**
 * The `session.created` fact must describe the row it lands on, including the
 * owner the Engine stamps on it (read from the raw payload: older Engines do
 * not stamp one, and the codec does not carry it).
 */
function assertBirthMatches(
  session: Doc<"sessions">,
  payload: Extract<SessionEventPayload, { kind: "session.created" }>,
  raw: unknown,
  head: number,
): void {
  const born = payload.session;
  const stamped = (raw as { session?: { ownerUserId?: unknown } }).session?.ownerUserId;
  if (stamped !== undefined && stamped !== session.ownerUserId) {
    throw intakeError("not_your_runner", "The session belongs to someone else.", head);
  }
  if (
    born.createdAt !== session.createdAt ||
    born.id !== session.id ||
    born.projectId !== session.projectId ||
    born.ticketId !== session.ticketId ||
    born.role !== session.role ||
    born.parentSessionId !== session.parentSessionId
  ) {
    throw intakeError("conflict", "The session's creation fact does not match the session.", head);
  }
}

/**
 * A Session the backend has not seen, started on the runner (an agent's
 * start, a delegation, an Automation run, a start while offline). Its first
 * fact must be the Engine's `session.create` command at sequence 1 (the
 * `session.created` fact follows at 2), which creates the rows: the owner is
 * the runner's owner and the claim is the calling runner's.
 */
async function createFromFirstFact(
  ctx: MutationCtx,
  caller: CallingRunner,
  args: { sessionId: string; generation: number },
  first: Envelope,
): Promise<{ session: Doc<"sessions">; intake: Doc<"sessionIntake"> }> {
  const read = first.sequence === 1 ? readFact(args.sessionId, first) : null;
  const payload =
    read !== null && read.quarantine === null && read.kindKnown ? read.event.payload : null;
  const command = payload?.kind === "command.recorded" ? payload.command : null;
  const intent = command?.intent;
  if (read === null || !read.kindKnown || command === null || intent?.kind !== "session.create") {
    throw intakeError(
      "unknown_session",
      "A new session's first fact must be its session.create command at sequence 1.",
      0,
    );
  }
  if (args.generation !== 1) throw intakeError("fenced", "A new session's claim starts at 1.", 0);
  if (command.sessionId !== args.sessionId)
    throw intakeError("unknown_session", "The creation command names another session.", 0);
  const born: Session = {
    id: args.sessionId,
    projectId: intent.projectId,
    ticketId: intent.ticketId,
    role: intent.role,
    parentSessionId: intent.parentSessionId,
    title: intent.title,
    createdAt: command.createdAt,
  };
  if ((await sessionRow(ctx, args.sessionId)) !== null) {
    throw intakeError("conflict", "That session id is already taken.", 0);
  }
  // The runner's owner must be an active Member of the project's current Workspace.
  const project = await findVisibleProject(ctx, caller.ownerUserId, born.projectId);
  if (project === null) throw intakeError("not_found", "That project does not exist.", 0);
  if (born.ticketId !== null) {
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", born.ticketId!))
      .unique();
    if (ticket === null || ticket.projectId !== project.id || ticket.deletedAt !== null) {
      throw intakeError("not_found", "That ticket does not exist.", 0);
    }
  }
  if (born.parentSessionId !== null) {
    const parent = await sessionRow(ctx, born.parentSessionId);
    if (
      parent === null ||
      parent.deletedAt !== null ||
      parent.projectId !== project.id ||
      parent.ownerUserId !== caller.ownerUserId
    ) {
      throw intakeError("not_found", "That parent session does not exist.", 0);
    }
  }
  const visibility = await visibilityForNewSession(ctx, {
    projectId: born.projectId,
    ownerUserId: caller.ownerUserId,
    role: born.role,
    parentSessionId: born.parentSessionId,
    createdAt: born.createdAt,
  });
  const detail = read.quarantine === null ? read.event.provenance.source.detail : null;
  const origin = readSessionOrigin(isRecord(detail) ? detail.sessionOrigin : null);
  const sessionDocId = await ctx.db.insert("sessions", {
    id: born.id,
    projectId: born.projectId,
    ticketId: born.ticketId,
    role: born.role,
    parentSessionId: born.parentSessionId,
    ownerUserId: caller.ownerUserId,
    origin,
    title: born.title,
    ...visibility,
    status: "open",
    turnActive: false,
    lastTurnOutcome: null,
    signal: null,
    stopped: null,
    needsUser: false,
    attentionCount: 0,
    placeRunnerId: caller.runnerId,
    model: null,
    usageTotals: EMPTY_USAGE_TOTALS,
    createdAt: born.createdAt,
    lastActivityAt: born.createdAt,
    deletedAt: null,
    purgeAfter: null,
  });
  const intakeDocId = await ctx.db.insert("sessionIntake", {
    sessionId: born.id,
    claim: { runnerId: caller.runnerId, generation: 1 },
    acceptedThrough: 0,
    lastEventId: null,
    lastAcceptedAt: null,
    state: "active",
  });
  return { session: (await ctx.db.get(sessionDocId))!, intake: (await ctx.db.get(intakeDocId))! };
}

// ── the fold ────────────────────────────────────────────────────────────────

/** A readable fact on its way into the fold, and the row it is stored in. */
interface FoldFact {
  event: SessionEvent;
  rowId: Id<"sessionEvents">;
  /** Stored unread by an older build and read now: what it derives was never written. */
  learned: boolean;
}

/** The Session as it was born, from its row: what a fold with no state starts from. */
function birthOf(session: Doc<"sessions">): Session {
  return {
    id: session.id,
    projectId: session.projectId,
    ticketId: session.ticketId,
    role: session.role,
    parentSessionId: session.parentSessionId,
    title: session.title,
    createdAt: session.createdAt,
  };
}

function readFoldView(state: CloudSessionState) {
  try {
    return readCloudSessionView(state);
  } catch (error) {
    throw intakeError("fold_failed", "The Session's folded view is unreadable.", null, error);
  }
}

async function stateDocOf(ctx: MutationCtx, sessionId: string) {
  return ctx.db
    .query("sessionStates")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}

/**
 * The stored state, or `null` when there is none or another fold version or
 * event vocabulary wrote it (the next accept then refolds).
 */
export function readStoredState(doc: Doc<"sessionStates"> | null): CloudSessionState | null {
  if (doc === null || typeof doc.state !== "string") return null;
  try {
    const state = readCloudSessionState(JSON.parse(doc.state));
    if (state === null) return null; // Another vocabulary/version still triggers a normal refold.
    assertSessionProjectionCheckpoint(
      {
        ...state.fold,
        version: SESSION_PROJECTION_CHECKPOINT_VERSION,
        compatibility: SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY,
      },
      { expectedSessionId: doc.sessionId, latestSequence: doc.throughSequence },
    );
    if (state.throughSequence !== doc.throughSequence) {
      throw intakeError("corrupt_state", "The stored fold cursor does not match its document.");
    }
    readCloudSessionView(state); // Validate the view's required arrays and bounded-state metadata.
    return state;
  } catch (error) {
    throw intakeError("corrupt_state", "The Session's stored fold is unreadable.", null, error);
  }
}

/**
 * Folds an accept's readable facts when the state is caught up with the head
 * the accept started from; otherwise leaves them to the catch-up, which reads
 * them back in order. Returns how many facts the fold set aside.
 */
async function advanceFold(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  previousHead: number,
  facts: readonly FoldFact[],
  through: number,
  now: number,
  diagnostics?: IntakeDiagnostics,
): Promise<number> {
  if (diagnostics) diagnostics.phase = "read_state";
  const doc = await stateDocOf(ctx, session.id);
  if (diagnostics) {
    diagnostics.hasStateDoc = doc !== null;
    diagnostics.stateBytes = typeof doc?.state === "string" ? utf8Bytes(doc.state) : null;
  }
  const state = readStoredState(doc);
  if ((state?.throughSequence ?? 0) !== previousHead) {
    await requestCatchUp(ctx, session.id, doc, now);
    return 0;
  }
  return applyFold(ctx, session, doc, state, facts, through, { atHead: true }, diagnostics);
}

async function requestCatchUp(
  ctx: MutationCtx,
  sessionId: string,
  doc: Doc<"sessionStates"> | null,
  now: number,
): Promise<void> {
  const scheduledAt = doc?.catchUpAt ?? null;
  if (scheduledAt !== null && now - scheduledAt < CATCH_UP_RETRY_MS) return;
  if (doc === null) {
    await ctx.db.insert("sessionStates", {
      sessionId,
      throughSequence: 0,
      foldVersion: 0,
      state: null,
      catchUpAt: now,
      derivedThrough: 0,
    });
  } else {
    await ctx.db.patch(doc._id, { catchUpAt: now });
  }
  await ctx.scheduler.runAfter(0, internal.sessions.catchUp, { sessionId });
}

/**
 * Folds `facts` (readable, ascending, after the state's cursor) one at a time
 * and stores the state through `through`.
 *
 * What a fact derives is written once: for facts past `derivedThrough`, and
 * for facts an older build stored unread. A refold therefore rebuilds the
 * state without replaying old attention, turns or receipts over newer ones,
 * and the listing row is synced only when the fold reaches the head (`atHead`),
 * never to a historical state on the way there.
 *
 * A fact the bounded fold cannot hold is set aside like a quarantined one:
 * marked on its row, raised to the owner, not folded. Returns how many.
 */
async function applyFold(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  doc: Doc<"sessionStates"> | null,
  initial: CloudSessionState | null,
  facts: readonly FoldFact[],
  through: number,
  options: { atHead: boolean },
  diagnostics?: IntakeDiagnostics,
): Promise<number> {
  const birth = birthOf(session);
  const derivedThrough = doc?.derivedThrough ?? 0;
  let state = initial;
  let view = state === null ? null : readFoldView(state);
  let setAside = 0;
  for (const fact of facts) {
    const { event } = fact;
    let next: CloudSessionState;
    if (diagnostics) {
      diagnostics.phase = "fold";
      diagnostics.sequence = event.sequence;
      diagnostics.kind = event.payload.kind;
    }
    try {
      next = foldCloudSessionState(state, birth, [event], event.sequence);
    } catch (error) {
      if (!(error instanceof CloudSessionStateTooLargeError)) {
        throw intakeError(
          "fold_failed",
          "The Session's fold could not advance over its history.",
          null,
          error,
        );
      }
      const quarantine = { code: "fold_too_large", detail: error.message };
      await ctx.db.patch(fact.rowId, { quarantine });
      await raiseQuarantine(
        ctx,
        session,
        { sequence: event.sequence, kind: event.payload.kind, occurredAt: event.occurredAt },
        quarantine,
      );
      setAside += 1;
      continue;
    }
    const nextView = readFoldView(next);
    if (event.sequence > derivedThrough || fact.learned) {
      if (diagnostics) diagnostics.phase = "derive";
      await deriveFromFact(ctx, session, event, view, nextView);
    }
    state = next;
    view = nextView;
  }
  // Facts passed over (unknown, quarantined, set aside) still move the cursor.
  if (diagnostics) diagnostics.phase = "fold";
  if (state === null || state.throughSequence < through) {
    try {
      state = foldCloudSessionState(state, birth, [], through);
    } catch (error) {
      throw intakeError(
        "fold_failed",
        "The Session's fold could not advance to its head.",
        null,
        error,
      );
    }
  }
  if (diagnostics) diagnostics.phase = "store_state";
  const stored = {
    throughSequence: through,
    foldVersion: CLOUD_SESSION_FOLD_VERSION,
    state: JSON.stringify(state),
    catchUpAt: null,
    derivedThrough: Math.max(derivedThrough, through),
  };
  if (doc === null) await ctx.db.insert("sessionStates", { sessionId: session.id, ...stored });
  else await ctx.db.patch(doc._id, stored);
  if (options.atHead) {
    if (diagnostics) diagnostics.phase = "listing";
    const current = readFoldView(state);
    await syncListing(ctx, session, current);
    await onDelegationHead(ctx, session, current);
  }
  return setAside;
}

/**
 * One catch-up step: folds the next page of accepted facts after the state's
 * cursor and schedules the next step while more remain. Every fact is read
 * again with this build's codec, so a kind stored unread folds once known.
 *
 * A step reads a bounded range of facts, not the Session's head, so it does
 * not conflict with live accepts landing past it; only the last step reads
 * the head, to prove nothing between the cursor and the head is missing.
 */
export async function catchUpStep(
  ctx: MutationCtx,
  sessionId: string,
  diagnostics?: IntakeDiagnostics,
): Promise<void> {
  const now = Date.now();
  if (diagnostics) diagnostics.phase = "read_state";
  const session = await sessionRow(ctx, sessionId);
  const doc = await stateDocOf(ctx, sessionId);
  if (diagnostics) {
    diagnostics.hasStateDoc = doc !== null;
    diagnostics.stateBytes = typeof doc?.state === "string" ? utf8Bytes(doc.state) : null;
  }
  if (doc === null) return;
  if (session === null || session.deletedAt !== null) {
    if (doc.catchUpAt !== null) await ctx.db.patch(doc._id, { catchUpAt: null });
    return;
  }
  const state = readStoredState(doc);
  const after = state?.throughSequence ?? 0;
  if (diagnostics) {
    diagnostics.phase = "catch_up";
    diagnostics.expectedSequence = after + 1;
  }
  const facts: FoldFact[] = [];
  let through = after;
  let bytes = 0;
  let more = false;
  for await (const row of ctx.db.query("sessionEvents").withIndex("by_session_sequence", (q) =>
    q
      .eq("sessionId", sessionId)
      .gt("sequence", after)
      .lte("sequence", after + CATCH_UP_PAGE_EVENTS + 1),
  )) {
    if (through - after >= CATCH_UP_PAGE_EVENTS || bytes >= CATCH_UP_PAGE_BYTES) {
      more = true;
      break;
    }
    if (row.sequence !== through + 1) {
      if (diagnostics) diagnostics.expectedSequence = through + 1;
      throw intakeError("corrupt_history", "The Session is missing an accepted fact.");
    }
    through = row.sequence;
    if (diagnostics) {
      diagnostics.sequence = row.sequence;
      diagnostics.kind = row.kind;
    }
    bytes += row.bytes;
    if (row.quarantine !== null) continue;
    const read = readStoredFact(row);
    if (read.kindKnown !== row.kindKnown || read.quarantine !== null) {
      await ctx.db.patch(row._id, { kindKnown: read.kindKnown, quarantine: read.quarantine });
    }
    if (read.quarantine !== null) {
      await raiseQuarantine(ctx, session, row, read.quarantine);
    } else if (read.kindKnown) {
      facts.push({ event: read.event, rowId: row._id, learned: !row.kindKnown });
    }
  }
  if (!more) {
    const intake = await intakeOf(ctx, sessionId);
    if (diagnostics) diagnostics.acceptedThrough = intake?.acceptedThrough ?? null;
    if (intake !== null && intake.acceptedThrough > through) {
      if (diagnostics) diagnostics.expectedSequence = through + 1;
      throw intakeError("corrupt_history", "The Session is missing accepted facts after its fold.");
    }
  }
  if (through === after && !more) {
    if (doc.catchUpAt !== null) await ctx.db.patch(doc._id, { catchUpAt: null });
    return;
  }
  await applyFold(ctx, session, doc, state, facts, through, { atHead: !more }, diagnostics);
  if (more) {
    await ctx.db.patch(doc._id, { catchUpAt: now });
    await ctx.scheduler.runAfter(0, internal.sessions.catchUp, { sessionId });
  }
}

/**
 * Starts the Session's fold again from its first accepted fact. Refused
 * (`false`) for a Session without a state, or with history compacted to the
 * archive tier, which the catch-up cannot read yet.
 */
export async function startRefold(ctx: MutationCtx, sessionId: string): Promise<boolean> {
  const doc = await stateDocOf(ctx, sessionId);
  if (doc === null) return false;
  const archived = await ctx.db
    .query("eventArchives")
    .withIndex("by_session_first", (q) => q.eq("sessionId", sessionId))
    .first();
  if (archived !== null) return false;
  await ctx.db.patch(doc._id, {
    throughSequence: 0,
    foldVersion: 0,
    state: null,
    catchUpAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.sessions.catchUp, { sessionId });
  return true;
}
