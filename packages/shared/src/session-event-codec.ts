/**
 * The Session Event codec: one table owning every durable payload kind's
 * parse and its renderer-safe scrub, exhaustive by construction.
 *
 * `SessionEventPayload` in ./session-ledger stays the declared, documented
 * source of truth for what each kind carries; this table is checked against it
 * with `satisfies`, so a new union arm without a codec entry fails to compile.
 * Deriving the union *from* the table was considered and rejected: it buys no
 * extra compile safety, costs real readability, and churns every downstream
 * `Extract<>`.
 *
 * Session Events are exhaustive on write, tolerant on read (CLAUDE.md), and
 * the tolerance is this module's property rather than any single caller's: an
 * unrecognised `kind` raises {@link UnknownSessionEventKindError}, a distinct
 * catchable signal read paths drop, while a malformed field inside a known
 * kind is corruption and stays a loud plain `Error` at every read site.
 * History outlives the build that wrote it, so a category we can add but
 * cannot retire is permanent by accident — retiring a durable kind depends on
 * every reader treating "unknown" as skippable, never as fatal.
 *
 * The payload graph's other roots live here too: `command.recorded` carries a
 * whole `SessionCommand` and `command.receipt.recorded` a `CommandReceipt`,
 * so intent, route, receipt and provenance decoding are this module's as well.
 * Encode stays a plain canonical `JSON.stringify` behind a strict JSON-safety
 * assertion — the codec never re-orders or rewrites what is already on disk.
 *
 * The renderer-safe form is the same table's other column. Each entry's
 * `scrub` maps a durable payload onto what may cross the product edge to the
 * renderer — runtime identity (`adapterId`) and adapter-native detail
 * (recovery locators, diagnostics, provenance internals) stay behind it — and
 * {@link RendererSessionEventPayload} is **derived from the scrub return
 * types**, so the published renderer type and the runtime scrub cannot
 * disagree. That derivation replaces a mapped type the edge once kept beside
 * a hand-written switch, whose quiet divergence is exactly the failure mode
 * this table exists to make impossible.
 */

import { COMPACTION_REASONS, REASONING_LEVELS } from "./agent-runtime";
import type { ModelSelection, PromptResource } from "./agent-runtime";
import { isSessionToolId } from "./agent-tool-surface";
import type { AuthoritySnapshot, SessionToolId } from "./authority";
import { JUDGMENT_MODES } from "./authority-config";
import { errorMessage } from "./errors";
import {
  SESSION_ATTACHMENT_CONTINUITIES,
  SESSION_ATTENTION_KINDS,
  SESSION_INTERACTION_CANCEL_REASONS,
} from "./session-ledger";
import type {
  CommandReceipt,
  CommandReceiptResult,
  Session,
  SessionAttachment,
  SessionAttachmentFailure,
  SessionAttention,
  SessionCommand,
  SessionCommandIntent,
  SessionCommandRoute,
  SessionEvent,
  SessionEventPayload,
  SessionEventProvenance,
  SessionExecutionVenue,
  SessionInteraction,
  SessionInteractionAnswer,
  SessionInteractionOption,
  SessionInteractionPrompt,
  SessionInteractionResolution,
  SessionNativeDetail,
  SessionNativeReference,
  SessionProjection,
  TranscriptReference,
} from "./session-ledger";

type JsonRecord = Record<string, unknown>;

const VENUE_KINDS = ["local", "cloud", "remote", "unknown"] as const;

/**
 * Thrown when durable history carries a payload kind this build does not know.
 *
 * Separate from every other decode failure on purpose: a retired kind is an
 * expected consequence of removing a Session Event, while a malformed field
 * inside a known kind is corruption. Read paths drop the first and still fail
 * loudly on the second.
 */
export class UnknownSessionEventKindError extends Error {
  // Assigned in the body, not as a parameter property: this package runs
  // under Node's type-stripping in repo scripts, and a parameter property is
  // the one class syntax stripping cannot erase.
  readonly payloadKind: string;

  constructor(payloadKind: string, context: string) {
    super(`${context}.kind is not a known Session event payload`);
    this.name = "UnknownSessionEventKindError";
    this.payloadKind = payloadKind;
  }
}

type SessionEventKind = SessionEventPayload["kind"];
type PayloadOf<Kind extends SessionEventKind> = Extract<SessionEventPayload, { kind: Kind }>;

interface SessionEventKindCodec<Kind extends SessionEventKind, Safe = unknown> {
  /** Durable JSON (already parsed) → typed payload. Loud `Error` on a malformed known kind. */
  decode(record: JsonRecord, context: string): PayloadOf<Kind>;
  /**
   * Durable payload → renderer-safe payload. Total and pure; the renderer
   * union is derived from these return types, so what this returns *is* the
   * published contract for its kind.
   */
  scrub(payload: PayloadOf<Kind>): Safe;
  /**
   * Renderer-safe JSON → typed renderer payload, for the read back on the
   * renderer's side of the edge. Only needed when the scrub *removes* keys —
   * `decode` then rejects the scrubbed JSON — so most kinds omit it and the
   * renderer parse runs `scrub(decode(…))` instead, which both validates the
   * shape and re-nulls anything an unscrubbed value could be leaking.
   */
  decodeRenderer?(record: JsonRecord, context: string): Safe;
}

/**
 * The per-kind table. The `satisfies` clause is what makes the codec
 * exhaustive by construction: adding a `SessionEventPayload` arm without an
 * entry here fails to compile, and an entry whose decode returns the wrong
 * shape fails with it.
 */
const codecs = {
  "command.recorded": {
    decode: (record, context) => ({
      kind: "command.recorded",
      command: decodeSessionCommand(record.command, `${context}.command`),
    }),
    scrub: (payload) => ({ ...payload, command: scrubSessionCommand(payload.command) }),
    decodeRenderer: (record, context) => ({
      kind: "command.recorded" as const,
      command: decodeRendererCommand(record.command, `${context}.command`),
    }),
  },
  "session.created": {
    decode: (record, context) => ({
      kind: "session.created",
      session: decodeSessionValue(record.session, `${context}.session`),
    }),
    scrub: (payload) => payload,
  },
  "session.archived": {
    decode: () => ({ kind: "session.archived" }),
    scrub: (payload) => payload,
  },
  "session.retitled": {
    decode: (record, context) => ({
      kind: "session.retitled",
      title: readNullableString(record.title, `${context}.title`),
    }),
    scrub: (payload) => payload,
  },
  "model.selected": {
    decode: (record, context) => ({
      kind: "model.selected",
      selection: decodeModelSelection(record.selection, `${context}.selection`),
    }),
    scrub: (payload) => payload,
  },
  "session.input.recorded": {
    decode: (record, context) => {
      const input = asRecord(record.input, `${context}.input`);
      const kind = enumValue(
        input.kind,
        ["runtime-brief", "prompt-resources", "tool-surface"],
        `${context}.input.kind`,
      );
      const decoded =
        kind === "runtime-brief"
          ? { kind, text: readString(input.text, `${context}.input.text`) }
          : kind === "prompt-resources"
            ? {
                kind,
                resources: decodePromptResources(input.resources, `${context}.input.resources`),
              }
            : { kind, tools: decodeSessionToolIds(input.tools, `${context}.input.tools`) };
      return { kind: "session.input.recorded", input: decoded };
    },
    scrub: (payload) => payload,
  },
  "session.signaled": {
    decode: (record, context) => ({
      kind: "session.signaled",
      signal: enumValue(record.signal, ["done", "blocked"], `${context}.signal`),
      reason: readNullableString(record.reason, `${context}.reason`),
    }),
    scrub: (payload) => payload,
  },
  "attachment.opened": {
    decode: (record, context) => ({
      kind: "attachment.opened",
      attachment: decodeAttachment(record.attachment, `${context}.attachment`),
    }),
    scrub: (payload) => ({ ...payload, attachment: scrubSessionAttachment(payload.attachment) }),
    decodeRenderer: (record, context) => ({
      kind: "attachment.opened" as const,
      attachment: decodeRendererAttachment(record.attachment, `${context}.attachment`),
    }),
  },
  "attachment.native_referenced": {
    decode: (record, context) => ({
      kind: "attachment.native_referenced",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      native: decodeNative(record.native, `${context}.native`),
    }),
    scrub: (payload) => ({ ...payload, native: scrubbedNativeReference() }),
  },
  "attachment.failed": {
    decode: (record, context) => ({
      kind: "attachment.failed",
      attachment: decodeAttachment(record.attachment, `${context}.attachment`),
      failure: decodeFailure(record.failure, `${context}.failure`),
    }),
    scrub: (payload) => ({
      ...payload,
      attachment: scrubSessionAttachment(payload.attachment),
      failure: scrubSessionAttachmentFailure(payload.failure),
    }),
    decodeRenderer: (record, context) => ({
      kind: "attachment.failed" as const,
      attachment: decodeRendererAttachment(record.attachment, `${context}.attachment`),
      // Decoded with the durable reader, then re-scrubbed: a leaked diagnostic
      // is nulled rather than trusted.
      failure: scrubSessionAttachmentFailure(decodeFailure(record.failure, `${context}.failure`)),
    }),
  },
  "attachment.closed": {
    decode: (record, context) => ({
      kind: "attachment.closed",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      outcome: enumValue(
        record.outcome,
        ["completed", "failed", "interrupted"],
        `${context}.outcome`,
      ),
    }),
    scrub: (payload) => payload,
  },
  "run.started": {
    decode: (record, context) => ({
      kind: "run.started",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      runId: readString(record.runId, `${context}.runId`),
    }),
    scrub: (payload) => payload,
  },
  "run.completed": {
    decode: (record, context) => ({
      kind: "run.completed",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      runId: readString(record.runId, `${context}.runId`),
    }),
    scrub: (payload) => payload,
  },
  "turn.started": {
    decode: (record, context) => ({
      kind: "turn.started",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      turnId: readString(record.turnId, `${context}.turnId`),
    }),
    scrub: (payload) => payload,
  },
  "turn.completed": {
    decode: (record, context) => ({
      kind: "turn.completed",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      turnId: readString(record.turnId, `${context}.turnId`),
    }),
    scrub: (payload) => payload,
  },
  "turn.interrupted": {
    decode: (record, context) => ({
      kind: "turn.interrupted",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      turnId: readString(record.turnId, `${context}.turnId`),
    }),
    scrub: (payload) => payload,
  },
  // Token counts are read as integers, which is what every producer of one
  // counts in. A fractional count is not a tolerable rounding difference here:
  // it is a number nothing in the pipeline can have written, and the loud read
  // is the same answer this table gives every malformed field inside a known
  // kind.
  "context.compacted": {
    decode: (record, context) => ({
      kind: "context.compacted",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      reason: enumValue(record.reason, COMPACTION_REASONS, `${context}.reason`),
      entryId: readString(record.entryId, `${context}.entryId`),
      tokensBefore: readInteger(record.tokensBefore, `${context}.tokensBefore`),
      tokensAfter: readInteger(record.tokensAfter, `${context}.tokensAfter`),
    }),
    // Both counts and the reason are Volli's own vocabulary; `entryId` names an
    // entry in the executor's history and not a path, a locator or a credential,
    // so the whole payload crosses to the renderer as it stands.
    scrub: (payload) => payload,
  },
  "context.compaction_failed": {
    decode: (record, context) => ({
      kind: "context.compaction_failed",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      reason: enumValue(record.reason, COMPACTION_REASONS, `${context}.reason`),
      detail: readString(record.detail, `${context}.detail`),
    }),
    // `detail` was sanitized at the runtime boundary, like every other
    // diagnostic that reaches a person.
    scrub: (payload) => payload,
  },
  "transcript.referenced": {
    decode: (record, context) => ({
      kind: "transcript.referenced",
      attachmentId: readNullableString(record.attachmentId, `${context}.attachmentId`),
      turnId: readNullableString(record.turnId, `${context}.turnId`),
      reference: decodeTranscriptReference(record.reference, `${context}.reference`),
    }),
    scrub: (payload) => payload,
  },
  "attention.raised": {
    decode: (record, context) => ({
      kind: "attention.raised",
      attention: decodeAttention(record.attention, `${context}.attention`),
    }),
    scrub: (payload) => ({ ...payload, attention: scrubSessionAttention(payload.attention) }),
  },
  "attention.cleared": {
    decode: (record, context) => ({
      kind: "attention.cleared",
      attentionId: readString(record.attentionId, `${context}.attentionId`),
    }),
    scrub: (payload) => payload,
  },
  "interaction.opened": {
    decode: (record, context) => ({
      kind: "interaction.opened",
      interaction: decodeInteraction(record.interaction, `${context}.interaction`),
    }),
    scrub: (payload) => ({
      ...payload,
      interaction: scrubSessionInteraction(payload.interaction),
    }),
  },
  "interaction.resolved": {
    decode: (record, context) => ({
      kind: "interaction.resolved",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      interactionId: readString(record.interactionId, `${context}.interactionId`),
      resolution: decodeInteractionResolution(record.resolution, `${context}.resolution`),
    }),
    scrub: (payload) => payload,
  },
  // No resolution is read back, because none was written: the reason is the
  // whole fact. Decoding one here would be inventing the decision the event
  // exists to say nobody made.
  "interaction.cancelled": {
    decode: (record, context) => ({
      kind: "interaction.cancelled",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      interactionId: readString(record.interactionId, `${context}.interactionId`),
      reason: enumValue(record.reason, SESSION_INTERACTION_CANCEL_REASONS, `${context}.reason`),
    }),
    scrub: (payload) => payload,
  },
  "command.receipt.recorded": {
    decode: (record, context) => ({
      kind: "command.receipt.recorded",
      receipt: decodeCommandReceipt(record.receipt, `${context}.receipt`),
    }),
    scrub: (payload) => payload,
  },
  // `cause` is read as a plain string, not checked against the live rule pack.
  // History outlives the pack that wrote it, and a decoder that rejected a
  // retired rule id would make an old Session unreadable — every later read of
  // that Session, not just this event, because the decode throws.
  "authority.denied": {
    decode: (record, context) => ({
      kind: "authority.denied",
      attachmentId: readString(record.attachmentId, `${context}.attachmentId`),
      turnId: readNullableString(record.turnId, `${context}.turnId`),
      tool: readString(record.tool, `${context}.tool`),
      cause: readString(record.cause, `${context}.cause`),
      reason: readString(record.reason, `${context}.reason`),
    }),
    // `authority.denied` crosses untouched — `tool`, `cause` and `reason` are
    // Volli's own vocabulary already, not a harness's.
    scrub: (payload) => payload,
  },
  "adapter.observed": {
    decode: (record, context) => ({
      kind: "adapter.observed",
      attachmentId: readNullableString(record.attachmentId, `${context}.attachmentId`),
      name: readString(record.name, `${context}.name`),
      native: decodeNativeDetail(record.native, `${context}.native`),
    }),
    scrub: (payload) => ({ ...payload, native: null }),
  },
} satisfies { [Kind in SessionEventKind]: SessionEventKindCodec<Kind> };

/**
 * The table again, viewed by an arbitrary string kind. The widening is sound —
 * each entry's decode returns its own arm of the union and each scrub one arm
 * of the derived renderer union — and it is what lets an unknown kind be
 * answered with the distinct error instead of a type hole.
 */
const codecByKind: Partial<
  Record<string, SessionEventKindCodec<SessionEventKind, RendererSessionEventPayload>>
> = codecs;

/* ------------------------------------------------------- renderer-safe form */

/**
 * An adapter correlation reference as the renderer sees it: both halves
 * removed. The Pi adapter stores an attachment's recovery locator (runtime
 * session id, session file path) in `native`, which must never cross the
 * product edge — and the type says so, rather than claiming a field survives
 * that never arrives. Renderer correlation keys on durable ids instead
 * (see `askInteractionId`).
 */
export interface RendererSessionNativeReference {
  id: null;
  detail: null;
}

/** An attachment without executor routing identity or its recovery locator. */
/**
 * `authority` is scrubbed with the two host-only fields rather than projected.
 *
 * Not because a Snapshot is a secret — it is policy, and a person is entitled to
 * read the policy their Session runs under. It is withheld because no surface
 * renders it yet, and the renderer's attachment shape is a contract: putting a
 * field there before something displays it invites a client to depend on a shape
 * that has never been designed. VC-44 makes the Snapshot durable; showing it is
 * a later, deliberate act.
 */
export type RendererSessionAttachment = Omit<
  SessionAttachment,
  "adapterId" | "native" | "authority"
>;

export type RendererSessionAttachmentFailure = Omit<SessionAttachmentFailure, "diagnostic"> & {
  diagnostic: null;
};

/** Distributes over the union so the rate-limit and quota arms keep their own fields. */
type WithNulledDiagnostic<Attention> = Attention extends unknown
  ? Omit<Attention, "diagnostic"> & { diagnostic: null }
  : never;

export type RendererSessionAttention = WithNulledDiagnostic<SessionAttention>;

export type RendererSessionInteraction = Omit<SessionInteraction, "native"> & {
  native: RendererSessionNativeReference;
};

type ScrubbedIntent<Intent> = Intent extends { kind: "executor.start" }
  ? Omit<Intent, "adapterId">
  : Intent;

export type RendererSessionCommandIntent = ScrubbedIntent<SessionCommandIntent>;

export type RendererSessionCommandRoute = Pick<SessionCommandRoute, "attachmentId">;

export type RendererSessionCommand = Omit<SessionCommand, "intent" | "route"> & {
  intent: RendererSessionCommandIntent;
  route: RendererSessionCommandRoute | null;
};

/** Provenance with the adapter arm gone: the scrub rewrites it to a system source. */
export interface RendererSessionEventProvenance {
  source: { kind: "user" | "system"; id: string; detail: SessionNativeDetail | null };
  venue: SessionExecutionVenue | null;
}

/**
 * The renderer-safe payload union, **derived from the scrub return types** so
 * the published type and the runtime scrub cannot disagree. A kind whose
 * scrub is identity keeps its durable arm verbatim; a kind whose scrub strips
 * something publishes exactly what is left.
 */
export type RendererSessionEventPayload = {
  [Kind in SessionEventKind]: ReturnType<(typeof codecs)[Kind]["scrub"]>;
}[SessionEventKind];

export type RendererSessionEvent = Omit<SessionEvent, "provenance" | "payload"> & {
  provenance: RendererSessionEventProvenance;
  payload: RendererSessionEventPayload;
};

/** Durable payload → renderer-safe payload, through the owning kind's table entry. */
export function scrubSessionEventPayload(
  payload: SessionEventPayload,
): RendererSessionEventPayload {
  // Present for every kind the union can name; only an untyped caller could
  // miss, and the parse owns that path.
  return codecByKind[payload.kind]!.scrub(payload);
}

/** One whole event made renderer-safe: provenance and payload scrubbed together. */
export function scrubSessionEvent(event: SessionEvent): RendererSessionEvent {
  return {
    ...event,
    provenance: scrubSessionEventProvenance(event.provenance),
    payload: scrubSessionEventPayload(event.payload),
  };
}

export function scrubSessionEventProvenance(
  provenance: SessionEventProvenance,
): RendererSessionEventProvenance {
  const { kind, id, detail } = provenance.source;
  if (kind === "adapter") {
    return {
      source: { kind: "system", id: "session-runtime", detail: null },
      venue: provenance.venue,
    };
  }
  return { source: { kind, id, detail }, venue: provenance.venue };
}

export function scrubSessionAttachment(attachment: SessionAttachment): RendererSessionAttachment {
  const {
    adapterId: _adapterId,
    native: _native,
    authority: _authority,
    ...presentation
  } = attachment;
  return presentation;
}

export function scrubSessionAttachmentFailure(
  failure: SessionAttachmentFailure,
): RendererSessionAttachmentFailure {
  return { ...failure, diagnostic: null };
}

export function scrubSessionAttention(attention: SessionAttention): RendererSessionAttention {
  return { ...attention, diagnostic: null };
}

export function scrubSessionInteraction(
  interaction: SessionInteraction,
): RendererSessionInteraction {
  return { ...interaction, native: scrubbedNativeReference() };
}

export function scrubSessionCommand(command: SessionCommand): RendererSessionCommand {
  const intent =
    command.intent.kind === "executor.start"
      ? (({ adapterId: _adapterId, ...presentation }) => presentation)(command.intent)
      : command.intent;
  return {
    ...command,
    intent,
    route: command.route === null ? null : { attachmentId: command.route.attachmentId },
  };
}

function scrubbedNativeReference(): RendererSessionNativeReference {
  return { id: null, detail: null };
}

/* ------------------------------------------------------- renderer-side parse */

/**
 * The non-throwing read of one renderer-safe event, for consumers that must
 * not throw — the chat wire reader runs inside React state updaters, where a
 * throw takes the whole surface down instead of losing one frame.
 *
 * The two failure arms are deliberately distinct, mirroring the ledger's read
 * rule: an `unknown-kind` is an expected consequence of a writer newer than
 * this build (live on the lab HTTP transport, and on any replay) and the
 * caller keeps the envelope while folding nothing; `malformed` is corruption
 * of a known kind and the caller surfaces it.
 */
export type RendererSessionEventParse =
  | { ok: true; event: RendererSessionEvent }
  | { ok: false; reason: "unknown-kind"; kind: string }
  | { ok: false; reason: "malformed"; message: string };

export function parseRendererSessionEvent(
  value: unknown,
  context: string,
): RendererSessionEventParse {
  try {
    return { ok: true, event: decodeRendererSessionEvent(value, context) };
  } catch (error) {
    if (error instanceof UnknownSessionEventKindError) {
      return { ok: false, reason: "unknown-kind", kind: error.payloadKind };
    }
    return { ok: false, reason: "malformed", message: errorMessage(error) };
  }
}

/**
 * Renderer-safe JSON → typed renderer payload. Throws exactly like
 * {@link decodeSessionEventPayload}: the distinct error on an unknown kind, a
 * plain one on a malformed known kind.
 */
export function decodeRendererSessionEventPayload(
  value: unknown,
  context: string,
): RendererSessionEventPayload {
  const record = asRecord(value, context);
  const kind = readString(record.kind, `${context}.kind`);
  const codec = codecByKind[kind];
  if (codec === undefined) throw new UnknownSessionEventKindError(kind, context);
  // `scrub(decode(…))` where the scrubbed JSON is still durable-decodable:
  // one parse per kind, and re-scrubbing on read means an unscrubbed leak is
  // nulled here rather than trusted. The kinds whose scrub removes keys carry
  // their own renderer decode instead, because `decode` would refuse them.
  return codec.decodeRenderer === undefined
    ? codec.scrub(codec.decode(record, context))
    : codec.decodeRenderer(record, context);
}

function decodeRendererSessionEvent(value: unknown, context: string): RendererSessionEvent {
  const row = asRecord(value, context);
  const attachmentId = readAbsentableString(row.attachmentId, `${context}.attachmentId`);
  const commandId = readAbsentableString(row.commandId, `${context}.commandId`);
  const event: RendererSessionEvent = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    sequence: readInteger(row.sequence, `${context}.sequence`),
    occurredAt: readInteger(row.occurredAt, `${context}.occurredAt`),
    recordedAt: readInteger(row.recordedAt, `${context}.recordedAt`),
    // Decoded with the durable reader, then re-scrubbed for the same reason
    // the payload is: an adapter source that leaked through arrives here as a
    // system one, never as itself.
    provenance: scrubSessionEventProvenance(
      decodeSessionEventProvenance(row.provenance, `${context}.provenance`),
    ),
    payload: decodeRendererSessionEventPayload(row.payload, `${context}.payload`),
  };
  if (!event.id || !event.sessionId || event.sequence < 1) {
    throw new Error(`${context} has an invalid envelope`);
  }
  if (attachmentId !== null) event.attachmentId = attachmentId;
  if (commandId !== null) event.commandId = commandId;
  return event;
}

function decodeRendererCommand(value: unknown, context: string): RendererSessionCommand {
  const row = asRecord(value, context);
  const command: RendererSessionCommand = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    createdAt: readInteger(row.createdAt, `${context}.createdAt`),
    intent: decodeRendererCommandIntent(row.intent, `${context}.intent`),
    route: row.route === null ? null : decodeRendererCommandRoute(row.route, `${context}.route`),
  };
  if (!command.id || !command.sessionId) {
    throw new Error(`${context} is not a valid Session command`);
  }
  return command;
}

function decodeRendererCommandIntent(
  value: unknown,
  context: string,
): RendererSessionCommandIntent {
  const row = asRecord(value, context);
  // The one arm the scrub reshapes: no `adapterId` to read, and none returned
  // even when an unscrubbed value carries one.
  if (row.kind === "executor.start") {
    return {
      kind: "executor.start",
      continuity: enumValue(
        row.continuity,
        SESSION_ATTACHMENT_CONTINUITIES,
        `${context}.continuity`,
      ),
    };
  }
  // Every other arm crosses the edge unchanged, so the durable decoder is the
  // renderer decoder — and each durable arm is assignable to its renderer arm.
  return decodeSessionCommandIntent(value, context);
}

function decodeRendererCommandRoute(value: unknown, context: string): RendererSessionCommandRoute {
  const row = asRecord(value, context);
  return { attachmentId: readNullableString(row.attachmentId, `${context}.attachmentId`) };
}

function decodeRendererAttachment(value: unknown, context: string): RendererSessionAttachment {
  const row = asRecord(value, context);
  const venue = asRecord(row.venue, `${context}.venue`);
  const attachment: RendererSessionAttachment = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    venue: {
      id: readString(venue.id, `${context}.venue.id`),
      kind: enumValue(venue.kind, VENUE_KINDS, `${context}.venue.kind`),
    },
    continuity: enumValue(row.continuity, SESSION_ATTACHMENT_CONTINUITIES, `${context}.continuity`),
  };
  if (!attachment.id || !attachment.sessionId || !attachment.venue.id) {
    throw new Error(`${context} is not a valid Session attachment`);
  }
  return attachment;
}

/* --------------------------------------------------- renderer-safe projection */

export interface RendererSessionAttentionProjection {
  active: readonly RendererSessionAttention[];
  primary: RendererSessionAttention | null;
}

export interface RendererSessionInteractionProjection {
  active: readonly RendererSessionInteraction[];
  resolved: readonly {
    interaction: RendererSessionInteraction;
    resolution: SessionInteractionResolution;
    resolvedAt: number;
  }[];
}

/**
 * Renderer-owned Session state with executor implementation details removed.
 * Lives beside the scrubs it is built from so its attention and interaction
 * fields are the same renderer-safe types the event stream publishes — one
 * contract, not a projection-shaped restatement of it.
 */
export interface SessionPresentationProjection extends Pick<
  SessionProjection,
  | "session"
  | "status"
  | "signal"
  | "modelSelection"
  | "turnActive"
  | "lastActivityAt"
  | "bornTicketless"
> {
  attention: RendererSessionAttentionProjection;
  interactions: RendererSessionInteractionProjection;
  liveExecutor: { id: string } | null;
}

/**
 * Durable JSON → typed payload. Throws {@link UnknownSessionEventKindError}
 * on a kind this build does not know, and a plain `Error` on a malformed
 * field inside a known kind.
 */
export function decodeSessionEventPayload(value: unknown, context: string): SessionEventPayload {
  const record = asRecord(value, context);
  const kind = readString(record.kind, `${context}.kind`);
  const codec = codecByKind[kind];
  if (codec === undefined) throw new UnknownSessionEventKindError(kind, context);
  return codec.decode(record, context);
}

export function decodeSessionEventProvenance(
  value: unknown,
  context: string,
): SessionEventProvenance {
  const row = asRecord(value, context);
  const source = asRecord(row.source, `${context}.source`);
  const venue = row.venue === null ? null : asRecord(row.venue, `${context}.venue`);
  return {
    source: {
      kind: enumValue(source.kind, ["user", "adapter", "system"], `${context}.source.kind`),
      id: readString(source.id, `${context}.source.id`),
      detail: decodeNativeDetail(source.detail, `${context}.source.detail`),
    },
    venue:
      venue === null
        ? null
        : {
            id: readString(venue.id, `${context}.venue.id`),
            kind: enumValue(venue.kind, VENUE_KINDS, `${context}.venue.kind`),
          },
  };
}

export function decodeSessionCommand(value: unknown, context: string): SessionCommand {
  const row = asRecord(value, context);
  const command: SessionCommand = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    createdAt: readInteger(row.createdAt, `${context}.createdAt`),
    intent: decodeSessionCommandIntent(row.intent, `${context}.intent`),
    route: row.route === null ? null : decodeSessionCommandRoute(row.route, `${context}.route`),
  };
  assertCommandShape(command, context);
  return command;
}

export function decodeSessionCommandIntent(value: unknown, context: string): SessionCommandIntent {
  const row = asRecord(value, context);
  const kind = readString(row.kind, `${context}.kind`);
  switch (kind) {
    case "session.create":
      return {
        kind,
        projectId: readString(row.projectId, `${context}.projectId`),
        ticketId: readNullableString(row.ticketId, `${context}.ticketId`),
        title: readNullableString(row.title, `${context}.title`),
      };
    case "session.archive":
      return { kind };
    case "session.retitle":
      return { kind, title: readNullableString(row.title, `${context}.title`) };
    case "session.signal":
      return {
        kind,
        signal: enumValue(row.signal, ["done", "blocked"], `${context}.signal`),
        reason: readNullableString(row.reason, `${context}.reason`),
      };
    case "model.select":
      return {
        kind,
        selection: decodeModelSelection(row.selection, `${context}.selection`),
      };
    case "executor.start":
      return {
        kind,
        adapterId: readString(row.adapterId, `${context}.adapterId`),
        continuity: enumValue(
          row.continuity,
          SESSION_ATTACHMENT_CONTINUITIES,
          `${context}.continuity`,
        ),
      };
    case "executor.stop":
    case "executor.interrupt":
    case "executor.retry":
      return { kind, attachmentId: readString(row.attachmentId, `${context}.attachmentId`) };
    case "context.compact":
      return {
        kind,
        attachmentId: readString(row.attachmentId, `${context}.attachmentId`),
        instructions: readNullableString(row.instructions, `${context}.instructions`),
      };
    case "message.submit":
      return {
        kind,
        reference: decodeTranscriptReference(row.reference, `${context}.reference`),
      };
    case "interaction.resolve":
      return {
        kind,
        attachmentId: readString(row.attachmentId, `${context}.attachmentId`),
        interactionId: readString(row.interactionId, `${context}.interactionId`),
        resolution: decodeInteractionResolution(row.resolution, `${context}.resolution`),
        reference: decodeTranscriptReference(row.reference, `${context}.reference`),
      };
    default:
      throw new Error(`${context}.kind is not a known Session command`);
  }
}

export function decodeSessionCommandRoute(value: unknown, context: string): SessionCommandRoute {
  const row = asRecord(value, context);
  return {
    adapterId: readString(row.adapterId, `${context}.adapterId`),
    attachmentId: readNullableString(row.attachmentId, `${context}.attachmentId`),
  };
}

export function decodeCommandReceipt(value: unknown, context: string): CommandReceipt {
  const row = asRecord(value, context);
  const base = {
    id: readString(row.id, `${context}.id`),
    commandId: readString(row.commandId, `${context}.commandId`),
    sequence: readInteger(row.sequence, `${context}.sequence`),
    recordedAt: readInteger(row.recordedAt, `${context}.recordedAt`),
  };
  const status = readString(row.status, `${context}.status`);
  if (status === "accepted") {
    return {
      ...base,
      status,
      acceptedAt: readInteger(row.acceptedAt, `${context}.acceptedAt`),
      result: decodeReceiptResult(row.result, `${context}.result`),
    };
  }
  if (status === "rejected") {
    return {
      ...base,
      status,
      code: readString(row.code, `${context}.code`),
      detail: readNullableString(row.detail, `${context}.detail`),
    };
  }
  if (status === "completed") {
    return { ...base, status, result: decodeReceiptResult(row.result, `${context}.result`) };
  }
  if (status === "unreconciled") {
    return { ...base, status, detail: readNullableString(row.detail, `${context}.detail`) };
  }
  throw new Error(`${context}.status is not a known receipt status`);
}

/**
 * Write-side validation for one whole event: envelope sanity, then the same
 * decoders every read path runs, then JSON-safety of what will be persisted.
 * The SQLite ledger and the in-memory ledger both call this on append, which
 * is what gives lab and test writes parity with durable ones — an event the
 * codec cannot read back is refused before it is ever written.
 */
export function assertSessionEvent(value: SessionEvent, context: string): void {
  if (
    !value.id ||
    !value.sessionId ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isInteger(value.occurredAt) ||
    !Number.isInteger(value.recordedAt)
  ) {
    throw new Error(`${context} has an invalid envelope`);
  }
  decodeSessionEventProvenance(value.provenance, `${context}.provenance`);
  decodeSessionEventPayload(value.payload, `${context}.payload`);
  if (value.payload.kind === "command.receipt.recorded") {
    if (
      value.commandId !== value.payload.receipt.commandId ||
      value.sequence !== value.payload.receipt.sequence ||
      value.recordedAt !== value.payload.receipt.recordedAt
    ) {
      throw new Error(`${context} receipt envelope does not match receipt`);
    }
  }
  // Last, mirroring the SQLite write order: decode failures name the field
  // that is wrong, which is the better error when both would fire.
  assertJsonValue(value.provenance, `${context}.provenance`);
  assertJsonValue(value.payload, `${context}.payload`);
}

export function assertSession(value: Session, context: string): void {
  if (!value.id || !value.projectId || !Number.isInteger(value.createdAt)) {
    throw new Error(`${context} is not a valid Session`);
  }
}

/**
 * Canonical persisted form: a plain `JSON.stringify` behind a strict
 * JSON-safety assertion. No re-ordering — what is already on disk stays
 * byte-identical when re-encoded from the same value.
 */
export function encodeSessionJson(value: unknown): string {
  assertJsonValue(value, "JSON value");
  // `JSON.stringify` returns `undefined` only for values `assertJsonValue`
  // already refused (undefined, functions, symbols), so the result is a string.
  return JSON.stringify(value);
}

/* ------------------------------------------------------------ entity decoders */

function decodeSessionValue(value: unknown, context: string): Session {
  const row = asRecord(value, context);
  const session: Session = {
    id: readString(row.id, `${context}.id`),
    projectId: readString(row.projectId, `${context}.projectId`),
    ticketId: readNullableString(row.ticketId, `${context}.ticketId`),
    title: readNullableString(row.title, `${context}.title`),
    createdAt: readInteger(row.createdAt, `${context}.createdAt`),
  };
  assertSession(session, context);
  return session;
}

function assertCommandShape(value: SessionCommand, context: string): void {
  if (!value.id || !value.sessionId || !Number.isInteger(value.createdAt)) {
    throw new Error(`${context} is not a valid Session command`);
  }
}

function decodeReceiptResult(value: unknown, context: string): CommandReceiptResult {
  const row = asRecord(value, context);
  const kind = enumValue(
    row.kind,
    [
      "session.created",
      "session.archived",
      "session.retitled",
      "session.signaled",
      "model.selected",
      "executor.start.requested",
      "executor.stop.requested",
      "executor.interrupted",
      "executor.retried",
      "context.compacted",
      "message.submitted",
      "interaction.resolved",
    ],
    `${context}.kind`,
  );
  return { kind, sessionId: readString(row.sessionId, `${context}.sessionId`) };
}

/**
 * The attach-time skill record's resources. Each is a `{ name, text }` pair
 * whose text is the whole delivered body, so a Session re-attaching months
 * later composes the same system prompt it first composed — the record, never
 * the skill file as it stands today.
 */
function decodePromptResources(value: unknown, context: string): readonly PromptResource[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((entry, index) => {
    const row = asRecord(entry, `${context}[${index}]`);
    return {
      name: readString(row.name, `${context}[${index}].name`),
      text: readString(row.text, `${context}[${index}].text`),
    };
  });
}

/**
 * A frozen Agent Tool Surface, read back.
 *
 * Guarded by {@link isSessionToolId} rather than one closed list, because the
 * vocabulary now has two halves that live in different modules: the capability
 * tools, and the Verb Registry keys this build can project as tools (VC-162).
 * A name from either half decodes; anything else is a record this build cannot
 * honestly rebind, and refusing it beats handing back a tool array quietly
 * missing an entry.
 *
 * Refusing is EXPENSIVE, and deliberately stated so rather than softened. This
 * throws a plain `Error`, and only {@link UnknownSessionEventKindError} is
 * droppable at a ledger — so a record naming a name this build cannot bind
 * fails every later read of that Session, not just its next attachment. That is
 * the same bargain the closed list struck before VC-162, but the stakes moved:
 * the capability half is a hand-edited list that does not shrink, while the
 * verb half is derived from registry `accessModes`. Removing a `tool` access
 * mode, or renaming a verb key, therefore makes every Session that recorded it
 * unreadable — which is a migration to write, not a refactor to do quietly.
 */
function decodeSessionToolIds(value: unknown, context: string): readonly SessionToolId[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((tool, index) => {
    if (!isSessionToolId(tool)) throw new Error(`${context}[${index}] has an unsupported value`);
    return tool;
  });
}

function decodeModelSelection(value: unknown, context: string): ModelSelection {
  const row = asRecord(value, context);
  return {
    providerId: readString(row.providerId, `${context}.providerId`),
    modelId: readString(row.modelId, `${context}.modelId`),
    reasoningLevel: enumValue(row.reasoningLevel, REASONING_LEVELS, `${context}.reasoningLevel`),
  };
}

function decodeAttachment(value: unknown, context: string): SessionAttachment {
  const row = asRecord(value, context);
  const venue = asRecord(row.venue, `${context}.venue`);
  const attachment: SessionAttachment = {
    id: readString(row.id, `${context}.id`),
    sessionId: readString(row.sessionId, `${context}.sessionId`),
    adapterId: readString(row.adapterId, `${context}.adapterId`),
    venue: {
      id: readString(venue.id, `${context}.venue.id`),
      kind: enumValue(venue.kind, VENUE_KINDS, `${context}.venue.kind`),
    },
    continuity: enumValue(row.continuity, SESSION_ATTACHMENT_CONTINUITIES, `${context}.continuity`),
    native: row.native === null ? null : decodeNative(row.native, `${context}.native`),
    // Absent reads as null, and must: every attachment written before VC-44 has
    // no `authority` key at all, and history that refused to decode without one
    // would make those Sessions unopenable rather than merely quiet about the
    // policy they ran under.
    authority:
      row.authority === undefined || row.authority === null
        ? null
        : decodeAuthoritySnapshot(row.authority, `${context}.authority`),
  };
  if (!attachment.id || !attachment.sessionId || !attachment.adapterId || !attachment.venue.id) {
    throw new Error(`${context} is not a valid Session attachment`);
  }
  return attachment;
}

/**
 * One durably recorded Authority Snapshot, read back.
 *
 * The tool list and the rule pack strings are read as written rather than
 * validated against today's vocabulary, for the reason `authority.denied`'s
 * `cause` is a bare string: history outlives the pack and the tool surface that
 * produced it, and a decoder that rejected a retired tool name or an unknown
 * pack id would make an old Session unreadable in exactly the case the record
 * exists to serve — reading a denial back long after the pack changed.
 *
 * The enums are the exception and are validated, because each names a branch
 * this codebase still switches on; a value outside them is not a record from an
 * older vocabulary but a corrupt one.
 */
function decodeAuthoritySnapshot(value: unknown, context: string): AuthoritySnapshot {
  const row = asRecord(value, context);
  const fallback = asRecord(row.fallback, `${context}.fallback`);
  return {
    mode: enumValue(row.mode, ["auto"] as const, `${context}.mode`),
    location: enumValue(
      row.location,
      ["worktree", "main-checkout"] as const,
      `${context}.location`,
    ),
    enforcement: enumValue(
      row.enforcement,
      ["observe", "enforce"] as const,
      `${context}.enforcement`,
    ),
    judgmentMode: enumValue(row.judgmentMode, JUDGMENT_MODES, `${context}.judgmentMode`),
    tools: readToolIds(row.tools, `${context}.tools`),
    rulePackId: readString(row.rulePackId, `${context}.rulePackId`),
    rulePackHash: readString(row.rulePackHash, `${context}.rulePackHash`),
    classifierModel: readNullableString(row.classifierModel, `${context}.classifierModel`),
    fallback: {
      consecutiveDenials: readInteger(
        fallback.consecutiveDenials,
        `${context}.fallback.consecutiveDenials`,
      ),
      sessionDenials: readInteger(fallback.sessionDenials, `${context}.fallback.sessionDenials`),
    },
  };
}

/**
 * The recorded Agent Tool Surface, read as written.
 *
 * Not checked against {@link SessionToolId}, deliberately. A Snapshot naming a
 * tool this build no longer offers is the normal shape of old history, and the
 * record is most valuable precisely then — it is how a reader learns that the
 * Session which made a call held a tool that has since been retired.
 */
function readToolIds(value: unknown, context: string): AuthoritySnapshot["tools"] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) =>
    readString(item, `${context}[${index}]`),
  ) as AuthoritySnapshot["tools"];
}

function decodeNative(value: unknown, context: string): SessionNativeReference {
  const row = asRecord(value, context);
  return {
    id: readNullableString(row.id, `${context}.id`),
    detail: decodeNativeDetail(row.detail, `${context}.detail`),
  };
}

function decodeFailure(value: unknown, context: string): SessionAttachmentFailure {
  const row = asRecord(value, context);
  return {
    code: readString(row.code, `${context}.code`),
    detail: readNullableString(row.detail, `${context}.detail`),
    diagnostic: decodeNativeDetail(row.diagnostic, `${context}.diagnostic`),
  };
}

function decodeTranscriptReference(value: unknown, context: string): TranscriptReference {
  const row = asRecord(value, context);
  return {
    id: readString(row.id, `${context}.id`),
    mediaType: readNullableString(row.mediaType, `${context}.mediaType`),
    digest: readNullableString(row.digest, `${context}.digest`),
  };
}

function decodeAttention(value: unknown, context: string): SessionAttention {
  const row = asRecord(value, context);
  const kind = enumValue(row.kind, SESSION_ATTENTION_KINDS, `${context}.kind`);
  const base = {
    id: readString(row.id, `${context}.id`),
    attachmentId: readNullableString(row.attachmentId, `${context}.attachmentId`),
    detail: readNullableString(row.detail, `${context}.detail`),
    diagnostic: decodeNativeDetail(row.diagnostic, `${context}.diagnostic`),
  };
  if (kind === "rate_limited") {
    return { ...base, kind, retryAt: readNullableInteger(row.retryAt, `${context}.retryAt`) };
  }
  if (kind === "quota_exhausted") {
    return { ...base, kind, resetAt: readNullableInteger(row.resetAt, `${context}.resetAt`) };
  }
  return { ...base, kind };
}

function decodeInteractionOptions(
  value: unknown,
  context: string,
): readonly SessionInteractionOption[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => {
    const option = asRecord(item, `${context}[${index}]`);
    // Both absences, because both occur. `SessionInteractionOption.description`
    // is `string | null` and every adapter writes the explicit `null` — while
    // events persisted before that contract simply omit the key. Reading only
    // `undefined` as absent threw on the null, which killed the whole
    // `interaction.opened` event at the persistence boundary: no durable
    // interaction, an always-empty `projection.interactions`, and an approval
    // nothing could ever resolve. The throw surfaced nowhere, so the gate
    // still drew its buttons from the adapter's in-memory state and simply
    // did not respond.
    const description = readAbsentableString(
      option.description,
      `${context}[${index}].description`,
    );
    return {
      id: readString(option.id, `${context}[${index}].id`),
      label: readString(option.label, `${context}[${index}].label`),
      description,
    };
  });
}

function decodeInteractionPrompts(
  value: unknown,
  context: string,
): readonly SessionInteractionPrompt[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => {
    const prompt = asRecord(item, `${context}[${index}]`);
    return {
      id: readString(prompt.id, `${context}[${index}].id`),
      label: readString(prompt.label, `${context}[${index}].label`),
      detail: readNullableString(prompt.detail, `${context}[${index}].detail`),
      options: decodeInteractionOptions(prompt.options, `${context}[${index}].options`),
      multiple: readBoolean(prompt.multiple, `${context}[${index}].multiple`),
      custom: readBoolean(prompt.custom, `${context}[${index}].custom`),
    };
  });
}

function decodeInteractionAnswers(
  value: unknown,
  context: string,
): readonly SessionInteractionAnswer[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => {
    const answer = asRecord(item, `${context}[${index}]`);
    if (!Array.isArray(answer.optionIds)) {
      throw new Error(`${context}[${index}].optionIds must be an array`);
    }
    return {
      promptId: readString(answer.promptId, `${context}[${index}].promptId`),
      optionIds: answer.optionIds.map((optionId, position) =>
        readString(optionId, `${context}[${index}].optionIds[${position}]`),
      ),
      response: readNullableString(answer.response, `${context}[${index}].response`),
    };
  });
}

function decodeInteraction(value: unknown, context: string): SessionInteraction {
  const row = asRecord(value, context);
  const interaction: SessionInteraction = {
    id: readString(row.id, `${context}.id`),
    attachmentId: readString(row.attachmentId, `${context}.attachmentId`),
    kind: enumValue(row.kind, ["permission", "question"], `${context}.kind`),
    title: readString(row.title, `${context}.title`),
    detail: readNullableString(row.detail, `${context}.detail`),
    options: decodeInteractionOptions(row.options, `${context}.options`),
    multiple: readBoolean(row.multiple, `${context}.multiple`),
    native: decodeNative(row.native, `${context}.native`),
  };
  // `prompts` is optional in both directions. A record written before an
  // interaction could carry per-question detail must decode back without the
  // key — not with an empty array, and not with one synthesised from the flat
  // fields. Synthesis belongs to `readInteractionPrompts` at the read seam;
  // doing it here would persist a derived value on the next write.
  if (row.prompts === undefined) return interaction;
  return { ...interaction, prompts: decodeInteractionPrompts(row.prompts, `${context}.prompts`) };
}

function decodeInteractionResolution(
  value: unknown,
  context: string,
): SessionInteractionResolution {
  const row = asRecord(value, context);
  if (!Array.isArray(row.optionIds)) throw new Error(`${context}.optionIds must be an array`);
  const resolution: SessionInteractionResolution = {
    optionIds: row.optionIds.map((item, index) =>
      readString(item, `${context}.optionIds[${index}]`),
    ),
    response: readNullableString(row.response, `${context}.response`),
  };
  // Absent stays absent, for the same reason `prompts` does: a flat resolution
  // answers the interaction's first prompt, and `readInteractionAnswers` is
  // what says so.
  if (row.answers === undefined) return resolution;
  return { ...resolution, answers: decodeInteractionAnswers(row.answers, `${context}.answers`) };
}

/* ----------------------------------------------------------------- readers */

function decodeNativeDetail(value: unknown, context: string): SessionNativeDetail | null {
  assertJsonValue(value, context);
  return value as SessionNativeDetail;
}

function assertJsonValue(value: unknown, context: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${context} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${context}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${context}.${key}`);
    return;
  }
  throw new Error(`${context} is not JSON-compatible`);
}

function asRecord(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function readString(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  return value;
}

function readNullableString(value: unknown, context: string): string | null {
  return value === null ? null : readString(value, context);
}

/** Absent either way — an explicit `null` or a key an older event never wrote. */
function readAbsentableString(value: unknown, context: string): string | null {
  return value === null || value === undefined ? null : readString(value, context);
}

function readBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function readInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${context} must be an integer`);
  }
  return value;
}

function readNullableInteger(value: unknown, context: string): number | null {
  return value === null ? null : readInteger(value, context);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  context: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${context} has an unsupported value`);
  }
  return value as T[number];
}
