/**
 * The durable, harness-agnostic facts that make up a Session's local history.
 * A Session belongs to Volli; adapters and UI surfaces only attach to it.
 */

export interface Session {
  id: string;
  projectId: string;
  ticketId: string | null;
  title: string | null;
  /** Epoch milliseconds. Metadata only; ordering comes from `SessionEvent.sequence`. */
  createdAt: number;
}

export const SESSION_ATTACHMENT_CONTINUITIES = [
  "fresh",
  "native_resume",
  "context_replay",
  "recreate",
] as const;

/** How this attachment continues the durable Session, without claiming provider parity. */
export type SessionAttachmentContinuity = (typeof SESSION_ATTACHMENT_CONTINUITIES)[number];

export function isSessionAttachmentContinuity(
  value: unknown,
): value is SessionAttachmentContinuity {
  return (
    typeof value === "string" &&
    (SESSION_ATTACHMENT_CONTINUITIES as readonly string[]).includes(value)
  );
}

export type SessionNativeDetail =
  | null
  | boolean
  | number
  | string
  | readonly SessionNativeDetail[]
  | { readonly [key: string]: SessionNativeDetail };

/**
 * Adapter-provided correlation only. It is never a Volli command receipt and
 * deliberately leaves native shape open for capability-specific adapters.
 */
export interface SessionNativeReference {
  id: string | null;
  detail: SessionNativeDetail | null;
}

export type SessionCapabilityState = "available" | "unavailable" | "unknown";
export type SessionCapabilityEvidence = "declared" | "reported" | "observed" | "verified";

export interface SessionCapabilityFeature {
  id: string;
  state: SessionCapabilityState;
  evidence: SessionCapabilityEvidence;
  detail: string | null;
}

export interface SessionCapabilityCatalogItem {
  kind: "model" | "agent" | "command" | "mcp" | "skill" | "tool";
  id: string;
  label: string;
  state: SessionCapabilityState;
  evidence: SessionCapabilityEvidence;
  detail: SessionNativeDetail | null;
}

/** A versioned, binding-scoped view of what a native harness can do right now. */
export interface SessionCapabilitySnapshot {
  id: string;
  adapterId: string;
  attachmentId: string | null;
  profileId: string;
  revision: number;
  observedAt: number;
  expiresAt: number | null;
  features: readonly SessionCapabilityFeature[];
  catalog: readonly SessionCapabilityCatalogItem[];
}

export interface SessionInteractionOption {
  id: string;
  label: string;
  description: string | null;
}

/**
 * What a permission offers. These three ids are Volli's own vocabulary, not any
 * harness's — an adapter maps its provider's reply onto them — so they are
 * defined once here and every producer, adapter or fixture, mints them from
 * this list rather than restating it.
 */
export const SESSION_PERMISSION_OPTIONS: readonly SessionInteractionOption[] = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

/**
 * The option ids that mean "no".
 *
 * Refusing is its own act, and both halves of the seam have to agree on which
 * ids carry it: a surface that offers refusal and an adapter that recognizes it
 * are the same decision read twice. Compared lowercased, and only ever against
 * an id no harness declared — a provider's own value outranks this vocabulary.
 */
export const SESSION_REFUSAL_OPTION_IDS: readonly string[] = [
  "reject",
  "deny",
  "decline",
  "no",
  "cancel",
];

/**
 * One question inside an interaction. A permission is a single prompt; a
 * harness that asks several things at once declares one prompt per question,
 * each with its own options and its own answer rules.
 */
export interface SessionInteractionPrompt {
  id: string;
  label: string;
  detail: string | null;
  options: readonly SessionInteractionOption[];
  multiple: boolean;
  /** The harness accepts a free-text answer beside the declared options. */
  custom: boolean;
}

/** One prompt's answer. */
export interface SessionInteractionAnswer {
  promptId: string;
  optionIds: readonly string[];
  /** Free text, when the prompt declares `custom`. */
  response: string | null;
}

/** A provider-neutral user decision with an opaque native correlation reference. */
export interface SessionInteraction {
  id: string;
  attachmentId: string;
  kind: "permission" | "question";
  title: string;
  detail: string | null;
  options: readonly SessionInteractionOption[];
  multiple: boolean;
  /**
   * Per-question detail. Absent on records written before interactions carried
   * more than one question; read it through `readInteractionPrompts`, never
   * directly.
   */
  prompts?: readonly SessionInteractionPrompt[];
  native: SessionNativeReference;
}

export interface SessionInteractionResolution {
  optionIds: readonly string[];
  response: string | null;
  /** Per-prompt answers. Read it through `readInteractionAnswers`, never directly. */
  answers?: readonly SessionInteractionAnswer[];
}

export const SESSION_INTERACTION_CANCEL_REASONS = ["abandoned", "superseded", "withdrawn"] as const;

/**
 * Why an interaction stopped waiting without a decision: the user left it
 * unanswered, a newer interaction replaced it, or the harness stopped asking.
 * None of them is an answer — a cancelled interaction never carries a
 * resolution, so nothing downstream can read one as a refusal.
 */
export type SessionInteractionCancelReason = (typeof SESSION_INTERACTION_CANCEL_REASONS)[number];

/**
 * The id of the prompt at `index`. Every producer of a synthesized prompt id —
 * adapters, fixtures, and the fallback below — goes through this one definition
 * so a harness that declares one question and a stored record that predates
 * `prompts` cannot drift apart.
 */
export function promptId(index: number): string {
  return `prompt:${index}`;
}

/** The prompt id a single-prompt interaction carries. */
export const DEFAULT_INTERACTION_PROMPT_ID = promptId(0);

/**
 * The questions an interaction asks, whether or not it was written with
 * `prompts`. A record without them is one prompt built from the flat fields;
 * no consumer should branch on their absence itself.
 *
 * A declared empty list is returned as it stands. Absent means "written before
 * an interaction could carry questions"; empty means "this interaction asks
 * none", and collapsing the second into the first would answer a question the
 * record never asked.
 */
export function readInteractionPrompts(
  interaction: SessionInteraction,
): readonly SessionInteractionPrompt[] {
  const { prompts } = interaction;
  if (prompts !== undefined) return prompts;
  return [
    {
      id: DEFAULT_INTERACTION_PROMPT_ID,
      label: interaction.title,
      detail: interaction.detail,
      options: interaction.options,
      multiple: interaction.multiple,
      // Free text is a declared harness capability, never assumed of a record
      // written before the interaction could carry one.
      custom: false,
    },
  ];
}

/**
 * The answers a resolution gave, whether or not it was written with `answers`.
 * A flat resolution answers the interaction's first (or only) prompt.
 *
 * A declared empty list is returned as it stands, for the reason
 * `readInteractionPrompts` keeps one: an adapter that answers no prompts writes
 * `answers: []`, and synthesizing a single option-less answer for it reads
 * downstream as a refusal the user never gave.
 */
export function readInteractionAnswers(
  interaction: SessionInteraction,
  resolution: SessionInteractionResolution,
): readonly SessionInteractionAnswer[] {
  const { answers } = resolution;
  if (answers !== undefined) return answers;
  return [
    {
      promptId: interaction.prompts?.[0]?.id ?? DEFAULT_INTERACTION_PROMPT_ID,
      optionIds: resolution.optionIds,
      response: resolution.response,
    },
  ];
}

/** An executor attached to a Session. Its end does not end the Session. */
export interface SessionAttachment {
  id: string;
  sessionId: string;
  adapterId: string;
  /** Where this executor ran, independent of the adapter that spoke to it. */
  venue: SessionExecutionVenue;
  continuity: SessionAttachmentContinuity;
  native: SessionNativeReference | null;
}

/** A local machine, cloud sandbox, or other execution venue. */
export interface SessionExecutionVenue {
  id: string;
  kind: "local" | "cloud" | "remote" | "unknown";
}

/** Explicit provenance for audit and future cloud replay. */
export interface SessionEventProvenance {
  source: {
    kind: "user" | "adapter" | "system";
    id: string;
    detail: SessionNativeDetail | null;
  };
  venue: SessionExecutionVenue | null;
}

/** Content is stored elsewhere; the ledger records only its durable reference. */
export interface TranscriptReference {
  id: string;
  mediaType: string | null;
  digest: string | null;
}

export const SESSION_ATTENTION_KINDS = [
  "input_required",
  "permission_required",
  "auth_required",
  "configuration_invalid",
  "rate_limited",
  "quota_exhausted",
  "context_limit_reached",
  "transport_retrying",
  "partial_turn_interrupted",
  "adapter_disconnected",
  "adapter_unrecoverable",
] as const;

export type SessionAttentionKind = (typeof SESSION_ATTENTION_KINDS)[number];

export function isSessionAttentionKind(value: unknown): value is SessionAttentionKind {
  return (
    typeof value === "string" && (SESSION_ATTENTION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The Attention kinds that mean the agent is blocked on a *person*, not on the
 * world. A rate limit or a dead transport is also a stop, but nobody is being
 * asked anything; only these three are cleared by the user doing something.
 */
export const SESSION_USER_BLOCKING_ATTENTION_KINDS = [
  "input_required",
  "permission_required",
  "auth_required",
] as const satisfies readonly SessionAttentionKind[];

/**
 * Whether this Session is currently waiting on its user: an Interaction it has
 * opened and not had answered, or an active Attention only a human can clear.
 *
 * Written once and exported because "waiting" is about to be read by more than
 * one surface — the chat listing row and the sidebar's Active band — and two
 * hand-copies of this rule is how one of them comes to show a question the
 * other has already stopped believing in.
 */
export function sessionAwaitsUser(
  projection: Pick<SessionProjection, "interactions" | "attention">,
): boolean {
  if (projection.interactions.active.length > 0) return true;
  return projection.attention.active.some((attention) =>
    (SESSION_USER_BLOCKING_ATTENTION_KINDS as readonly SessionAttentionKind[]).includes(
      attention.kind,
    ),
  );
}

interface SessionAttentionBase {
  id: string;
  attachmentId: string | null;
  detail: string | null;
  diagnostic: SessionNativeDetail | null;
}

/** A structured state the user may need to recover from. */
export type SessionAttention =
  | (SessionAttentionBase & { kind: "rate_limited"; retryAt: number | null })
  | (SessionAttentionBase & { kind: "quota_exhausted"; resetAt: number | null })
  | (SessionAttentionBase & {
      kind: Exclude<SessionAttentionKind, "rate_limited" | "quota_exhausted">;
    });

export type SessionEventPayload =
  | { kind: "command.recorded"; command: SessionCommand }
  | { kind: "session.created"; session: Session }
  | { kind: "session.archived" }
  | { kind: "session.retitled"; title: string | null }
  /** An adapter-neutral outcome signal; it is not a Ticket lifecycle event. */
  | { kind: "session.signaled"; signal: "done" | "blocked"; reason: string | null }
  | { kind: "attachment.opened"; attachment: SessionAttachment }
  | {
      kind: "attachment.native_referenced";
      attachmentId: string;
      native: SessionNativeReference;
    }
  | { kind: "attachment.failed"; attachment: SessionAttachment; failure: SessionAttachmentFailure }
  | {
      kind: "attachment.closed";
      attachmentId: string;
      outcome: "completed" | "failed" | "interrupted";
    }
  | { kind: "run.started"; attachmentId: string; runId: string }
  | { kind: "run.completed"; attachmentId: string; runId: string }
  | { kind: "turn.started"; attachmentId: string; turnId: string }
  | { kind: "turn.completed"; attachmentId: string; turnId: string }
  | {
      kind: "transcript.referenced";
      attachmentId: string | null;
      turnId: string | null;
      reference: TranscriptReference;
    }
  | { kind: "attention.raised"; attention: SessionAttention }
  | { kind: "attention.cleared"; attentionId: string }
  | { kind: "capabilities.updated"; snapshot: SessionCapabilitySnapshot }
  | { kind: "interaction.opened"; interaction: SessionInteraction }
  | {
      kind: "interaction.resolved";
      attachmentId: string;
      interactionId: string;
      resolution: SessionInteractionResolution;
    }
  /**
   * The interaction stopped waiting and nobody decided it. It is a distinct
   * fact from `interaction.resolved` precisely because history is immutable:
   * an empty resolution would print a refusal the user never made.
   */
  | {
      kind: "interaction.cancelled";
      attachmentId: string;
      interactionId: string;
      reason: SessionInteractionCancelReason;
    }
  | { kind: "command.receipt.recorded"; receipt: CommandReceipt }
  | {
      kind: "adapter.observed";
      attachmentId: string | null;
      name: string;
      native: SessionNativeDetail | null;
    };

/** A failed attachment preserves adapter and venue metadata without pretending it ever opened. */
export interface SessionAttachmentFailure {
  code: string;
  detail: string | null;
  diagnostic: SessionNativeDetail | null;
}

/** One immutable local fact. Sequence, not wall-clock time, defines its order. */
export interface SessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  /** When the fact occurred according to the source, in epoch milliseconds. */
  occurredAt: number;
  /** When Volli durably recorded the fact, in epoch milliseconds. */
  recordedAt: number;
  provenance: SessionEventProvenance;
  /** The executor concerned by this fact, when one exists. */
  attachmentId?: string | null;
  /** The explicit user intent that caused this fact, when one exists. */
  commandId?: string | null;
  payload: SessionEventPayload;
}

interface SessionObservationBase {
  id: string;
  sessionId: string;
  occurredAt: number;
  provenance: SessionEventProvenance;
  attachmentId?: string | null;
  commandId?: string | null;
}

export type SessionObservation =
  | (SessionObservationBase & {
      id: string;
      kind: "attachment.opened";
      attachment: SessionAttachment;
    })
  | (SessionObservationBase & {
      kind: "attachment.native_referenced";
      attachmentId: string;
      native: SessionNativeReference;
    })
  | (SessionObservationBase & {
      kind: "attachment.failed";
      attachment: SessionAttachment;
      failure: SessionAttachmentFailure;
    })
  | (SessionObservationBase & {
      kind: "attachment.closed";
      attachmentId: string;
      outcome: "completed" | "failed" | "interrupted";
    })
  | (SessionObservationBase & { kind: "run.started"; attachmentId: string; runId: string })
  | (SessionObservationBase & {
      kind: "run.completed";
      attachmentId: string;
      runId: string;
    })
  | (SessionObservationBase & { kind: "turn.started"; attachmentId: string; turnId: string })
  | (SessionObservationBase & {
      kind: "turn.completed";
      attachmentId: string;
      turnId: string;
    })
  | (SessionObservationBase & {
      kind: "transcript.referenced";
      attachmentId: string | null;
      turnId: string | null;
      reference: TranscriptReference;
    })
  | (SessionObservationBase & {
      kind: "attention.raised";
      attention: SessionAttention;
    })
  | (SessionObservationBase & { kind: "attention.cleared"; attentionId: string })
  | (SessionObservationBase & {
      kind: "capabilities.updated";
      snapshot: SessionCapabilitySnapshot;
    })
  | (SessionObservationBase & {
      kind: "interaction.opened";
      interaction: SessionInteraction;
    })
  | (SessionObservationBase & {
      kind: "interaction.resolved";
      attachmentId: string;
      interactionId: string;
      resolution: SessionInteractionResolution;
    })
  | (SessionObservationBase & {
      kind: "interaction.cancelled";
      attachmentId: string;
      interactionId: string;
      reason: SessionInteractionCancelReason;
    })
  | (SessionObservationBase & {
      kind: "adapter.observed";
      attachmentId: string | null;
      name: string;
      native: SessionNativeDetail | null;
    })
  | (SessionObservationBase & { kind: "command.receipt"; receipt: UnstampedCommandReceipt });

/** Maps externally observed evidence to the durable event payload it proves. */
export function observationPayload(observation: SessionObservation): SessionEventPayload {
  switch (observation.kind) {
    case "attachment.opened":
      return { kind: observation.kind, attachment: observation.attachment };
    case "attachment.native_referenced":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        native: observation.native,
      };
    case "attachment.failed":
      return {
        kind: observation.kind,
        attachment: observation.attachment,
        failure: observation.failure,
      };
    case "attachment.closed":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        outcome: observation.outcome,
      };
    case "run.started":
    case "run.completed":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        runId: observation.runId,
      };
    case "turn.started":
    case "turn.completed":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        turnId: observation.turnId,
      };
    case "transcript.referenced":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        turnId: observation.turnId,
        reference: observation.reference,
      };
    case "attention.raised":
      return { kind: observation.kind, attention: observation.attention };
    case "attention.cleared":
      return { kind: observation.kind, attentionId: observation.attentionId };
    case "capabilities.updated":
      return { kind: observation.kind, snapshot: observation.snapshot };
    case "interaction.opened":
      return { kind: observation.kind, interaction: observation.interaction };
    case "interaction.resolved":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        interactionId: observation.interactionId,
        resolution: observation.resolution,
      };
    case "interaction.cancelled":
      return {
        kind: observation.kind,
        attachmentId: observation.attachmentId,
        interactionId: observation.interactionId,
        reason: observation.reason,
      };
    case "command.receipt":
      throw new Error("Command receipt observations require Session Engine stamping");
    case "adapter.observed":
      return {
        kind: observation.kind,
        // Observations may omit this optional envelope field; persist the
        // explicit null canonical form so replays have a stable payload.
        attachmentId: observation.attachmentId ?? null,
        name: observation.name,
        native: observation.native,
      };
  }
}

export type SessionCommandIntent =
  | { kind: "session.create"; projectId: string; ticketId: string | null; title: string | null }
  | { kind: "session.archive" }
  | { kind: "session.retitle"; title: string | null }
  | { kind: "session.signal"; signal: "done" | "blocked"; reason: string | null }
  | { kind: "executor.start"; adapterId: string; continuity: SessionAttachmentContinuity }
  | { kind: "executor.stop"; attachmentId: string }
  /** A non-destructive adapter interrupt (for example terminal Esc); the attachment remains live. */
  | { kind: "executor.interrupt"; attachmentId: string }
  | { kind: "message.submit"; reference: TranscriptReference }
  | {
      kind: "interaction.resolve";
      attachmentId: string;
      interactionId: string;
      resolution: SessionInteractionResolution;
      reference: TranscriptReference;
    };

/**
 * The adapter delivery target resolved by the control plane when it records a
 * command. It prevents a later attachment from silently accepting work that
 * was addressed to an earlier executor.
 */
export interface SessionCommandRoute {
  adapterId: string;
  attachmentId: string | null;
}

/** Caller-supplied intent for an existing Session before the control plane resolves a route. */
export interface SessionCommandRequest {
  id: string;
  sessionId: string;
  intent: Exclude<SessionCommandIntent, { kind: "session.create" }>;
}

/** Explicit user intent. A command is not evidence that an executor accepted it. */
export interface SessionCommand {
  id: string;
  sessionId: string;
  createdAt: number;
  intent: SessionCommandIntent;
  /** Null only for Session-level commands or deterministically rejected delivery. */
  route: SessionCommandRoute | null;
}

export type CommandReceiptResult =
  | { kind: "session.created"; sessionId: string }
  | { kind: "session.archived"; sessionId: string }
  | { kind: "session.retitled"; sessionId: string }
  | { kind: "session.signaled"; sessionId: string }
  | { kind: "executor.start.requested"; sessionId: string }
  | { kind: "executor.stop.requested"; sessionId: string }
  | { kind: "executor.interrupted"; sessionId: string }
  | { kind: "message.submitted"; sessionId: string }
  | { kind: "interaction.resolved"; sessionId: string };

interface CommandReceiptDetailsAccepted {
  status: "accepted";
  acceptedAt: number;
  result: CommandReceiptResult;
}

interface CommandReceiptDetailsRejected {
  status: "rejected";
  code: string;
  detail: string | null;
}

interface CommandReceiptDetailsCompleted {
  status: "completed";
  result: CommandReceiptResult;
}

interface CommandReceiptDetailsUnreconciled {
  status: "unreconciled";
  detail: string | null;
}

type CommandReceiptDetails =
  | CommandReceiptDetailsAccepted
  | CommandReceiptDetailsRejected
  | CommandReceiptDetailsCompleted
  | CommandReceiptDetailsUnreconciled;

/** Adapter evidence before Volli assigns durable ordering metadata. */
export type UnstampedCommandReceipt = {
  id: string;
  commandId: string;
} & CommandReceiptDetails;

/** Durable command outcome; native/provider IDs never substitute for this receipt. */
export type CommandReceipt = UnstampedCommandReceipt & {
  /** Assigned by Volli's control plane, never supplied by an adapter. */
  recordedAt: number;
  /** Matches the immutable `command.receipt.recorded` event sequence. */
  sequence: number;
};

export type AcceptedCommandReceipt = Extract<CommandReceipt, { status: "accepted" }>;

export function sameCommandReceipt(left: CommandReceipt, right: CommandReceipt): boolean {
  return left.id === right.id && stableSessionValue(left) === stableSessionValue(right);
}

/** Compares provider evidence with a stamped receipt, ignoring Volli-owned metadata. */
export function sameCommandReceiptOutcome(
  stored: CommandReceipt,
  observed: UnstampedCommandReceipt,
): boolean {
  const { recordedAt: _recordedAt, sequence: _sequence, ...outcome } = stored;
  return stableSessionValue(outcome) === stableSessionValue(observed);
}

export interface GetSessionQuery {
  sessionId: string;
}

/** A project-scoped Session list with no optional/null filter ambiguity. */
export type ListSessionsQuery =
  | { projectId: string; scope: "all" }
  | { projectId: string; scope: "ticket"; ticketId: string }
  | { projectId: string; scope: "scratch" };

/** One project-wide, bounded sidebar read over explicit Session outcome facts. */
export interface ListLatestTicketSignalsQuery {
  projectId: string;
}

export interface ListSessionEventsQuery {
  sessionId: string;
  afterSequence?: number;
  limit?: number;
}

export interface SessionAttachmentProjection extends SessionAttachment {
  status: "open" | "failed" | "closed";
  openedAt: number | null;
  closedAt: number | null;
  outcome: "completed" | "failed" | "interrupted" | null;
  failure: SessionAttachmentFailure | null;
}

export interface SessionAttentionProjection {
  active: readonly SessionAttention[];
  primary: SessionAttention | null;
}

export interface SessionInteractionProjection {
  active: readonly SessionInteraction[];
  resolved: readonly {
    interaction: SessionInteraction;
    resolution: SessionInteractionResolution;
    resolvedAt: number;
  }[];
}

export interface SessionProjection {
  session: Session;
  status: "open" | "archived";
  commands: readonly SessionCommand[];
  receipts: readonly CommandReceipt[];
  /** Latest unresolved executor.start intent; it exists before an attachment is observable. */
  pendingExecutorStart: SessionCommand | null;
  attachments: readonly SessionAttachmentProjection[];
  liveExecutor: SessionAttachmentProjection | null;
  attention: SessionAttentionProjection;
  /** Latest capability snapshot for each adapter/profile/binding scope. */
  capabilities: readonly SessionCapabilitySnapshot[];
  interactions: SessionInteractionProjection;
  /** Latest explicit generic outcome signal, independent of planner history. */
  signal: { signal: "done" | "blocked"; reason: string | null; occurredAt: number } | null;
  /** Whether a turn is open right now — the durable half of "the agent is working". */
  turnActive: boolean;
  /** Epoch milliseconds of the newest thing that happened here; seeded from the Session's creation. */
  lastActivityAt: number;
  /**
   * Whether this Session was ticketless AT BIRTH — from the immutable
   * `session.created` event's own `ticketId`, not the live `session.ticketId`
   * a later fact can change. `sessions.ticket_id` is `ON DELETE SET NULL`
   * (deleting a ticket orphans its sessions into `session.ticketId === null`
   * ones), so `session.ticketId === null && !bornTicketless` is exactly an
   * orphan: a scratch session and an orphaned one both read `ticketId: null`
   * today, but only the scratch one was ever meant to.
   */
  bornTicketless: boolean;
}

/**
 * Derives UI-ready Session state from ordered facts. Turn and executor end
 * events intentionally never close a Session; only `session.archived` does.
 */
export function projectSession(
  session: Session,
  events: readonly SessionEvent[],
  now = Date.now(),
): SessionProjection {
  const attachments = new Map<string, SessionAttachmentProjection>();
  const attention = new Map<string, SessionAttention>();
  const capabilities = new Map<string, SessionCapabilitySnapshot>();
  const interactions = new Map<string, SessionInteraction>();
  const resolvedInteractions: SessionInteractionProjection["resolved"][number][] = [];
  const commands: SessionCommand[] = [];
  const receipts: CommandReceipt[] = [];
  const pendingExecutorStarts = new Map<string, SessionCommand>();
  let status: SessionProjection["status"] = "open";
  let title = session.title;
  let signal: SessionProjection["signal"] = null;
  let turnActive = false;
  let lastActivityAt = session.createdAt;
  // Seeded from the live session row so a fold given no `session.created`
  // event (a degenerate/partial event list) still has an honest answer;
  // every real Session's `session.created` immediately overrides it with the
  // immutable birth fact below.
  let bornTicketless = session.ticketId === null;

  const ordered = [...events]
    .filter((event) => event.sessionId === session.id)
    .toSorted((left, right) => left.sequence - right.sequence);

  for (const event of ordered) {
    // Recency is about the agent's work, so pure Volli bookkeeping does not
    // move it: `command.recorded` / `command.receipt.recorded` fire for a
    // retitle, and `session.retitled` is the rename fact itself. Floating a
    // Session to the top of a recency-sorted list because someone renamed it
    // is a lie about what is happening in it. Nothing is lost by skipping
    // them — a `message.submit` command is followed immediately by the
    // `turn.started` it caused, which does count.
    if (
      event.payload.kind !== "command.recorded" &&
      event.payload.kind !== "command.receipt.recorded" &&
      event.payload.kind !== "session.retitled"
    ) {
      lastActivityAt = event.occurredAt;
    }

    switch (event.payload.kind) {
      case "command.recorded":
        commands.push(event.payload.command);
        if (event.payload.command.intent.kind === "executor.start") {
          pendingExecutorStarts.set(event.payload.command.id, event.payload.command);
        }
        break;
      case "session.archived":
        status = "archived";
        break;
      case "session.retitled":
        title = event.payload.title;
        break;
      case "session.signaled":
        signal = {
          signal: event.payload.signal,
          reason: event.payload.reason,
          occurredAt: event.occurredAt,
        };
        break;
      case "attachment.native_referenced": {
        const existing = attachments.get(event.payload.attachmentId);
        if (existing) {
          attachments.set(existing.id, { ...existing, native: event.payload.native });
        }
        break;
      }
      case "attachment.opened": {
        const { attachment } = event.payload;
        attachments.set(attachment.id, {
          ...attachment,
          status: "open",
          openedAt: event.occurredAt,
          closedAt: null,
          outcome: null,
          failure: null,
        });
        if (event.commandId) pendingExecutorStarts.delete(event.commandId);
        break;
      }
      case "attachment.failed": {
        const { attachment } = event.payload;
        attachments.set(attachment.id, {
          ...attachment,
          status: "failed",
          openedAt: null,
          closedAt: event.occurredAt,
          outcome: "failed",
          failure: event.payload.failure,
        });
        turnActive = false;
        if (event.commandId) pendingExecutorStarts.delete(event.commandId);
        break;
      }
      case "attachment.closed": {
        const existing = attachments.get(event.payload.attachmentId);
        if (existing) {
          attachments.set(existing.id, {
            ...existing,
            status: "closed",
            closedAt: event.occurredAt,
            outcome: event.payload.outcome,
          });
        }
        turnActive = false;
        break;
      }
      case "attention.raised":
        attention.delete(event.payload.attention.id);
        attention.set(event.payload.attention.id, event.payload.attention);
        break;
      case "attention.cleared":
        attention.delete(event.payload.attentionId);
        break;
      case "capabilities.updated": {
        const { snapshot } = event.payload;
        const scope = `${snapshot.adapterId}\u0000${snapshot.profileId}\u0000${snapshot.attachmentId ?? ""}`;
        capabilities.delete(scope);
        if (snapshot.expiresAt === null || snapshot.expiresAt > now) {
          capabilities.set(scope, snapshot);
        }
        break;
      }
      case "interaction.opened":
        interactions.delete(event.payload.interaction.id);
        interactions.set(event.payload.interaction.id, event.payload.interaction);
        break;
      case "interaction.resolved": {
        const interaction = interactions.get(event.payload.interactionId);
        if (interaction) {
          interactions.delete(interaction.id);
          resolvedInteractions.push({
            interaction,
            resolution: event.payload.resolution,
            resolvedAt: event.occurredAt,
          });
        }
        break;
      }
      // A cancelled interaction stops waiting and joins neither list: it has no
      // resolution to project, and `resolved` is where the UI reads the answer
      // back out. The durable `interaction.cancelled` event is what history
      // keeps, and it says the interaction ended undecided.
      case "interaction.cancelled":
        interactions.delete(event.payload.interactionId);
        break;
      case "command.receipt.recorded":
        receipts.push(event.payload.receipt);
        if (event.payload.receipt.status === "rejected") {
          pendingExecutorStarts.delete(event.payload.receipt.commandId);
        }
        break;
      // A turn is the durable half of "the agent is working", and a listing has
      // to answer that without replaying a whole transcript — so unlike runs and
      // transcript references, turns are folded here rather than read from the
      // stream. The end of an attachment ends the turn too (see the attachment
      // cases above): a crashed or interrupted executor leaves a `turn.started`
      // with no `turn.completed` behind it, and without that a Session would
      // latch "working" durably, forever, on the strength of a turn nobody is
      // running any more.
      case "turn.started":
        turnActive = true;
        break;
      case "turn.completed":
        turnActive = false;
        break;
      // `session.created` carries the Session row as it was at birth — the
      // one immutable read of `ticketId` a later ticket deletion (`ON DELETE
      // SET NULL`) cannot touch, because it lives in this event's JSON
      // payload, not the `sessions` row's live column.
      case "session.created":
        bornTicketless = event.payload.session.ticketId === null;
        break;
      // Facts this projection deliberately holds no further state for. They
      // are listed rather than swept up by a `default`, so that adding a
      // payload kind is a compile error here and someone has to decide
      // whether Session state moves. Runs and transcript references are the
      // transcript's shape, read from the event stream directly;
      // `adapter.observed` is adapter evidence that no projected field is
      // derived from.
      case "run.started":
      case "run.completed":
      case "transcript.referenced":
      case "adapter.observed":
        break;
      /* v8 ignore next 4 -- unreachable while the union is exhausted above; it exists to stop being so at compile time. */
      default: {
        const unhandled: never = event.payload;
        return unhandled;
      }
    }
  }

  const attachmentList = [...attachments.values()];
  const liveExecutor = attachmentList.find((attachment) => attachment.status === "open") ?? null;
  const activeAttention = [...attention.values()];
  const pendingExecutorStart = [...pendingExecutorStarts.values()].at(-1) ?? null;

  return {
    session: { ...session, title },
    status,
    commands,
    receipts,
    pendingExecutorStart,
    attachments: attachmentList,
    liveExecutor,
    attention: {
      active: activeAttention,
      primary: activeAttention.at(-1) ?? null,
    },
    capabilities: [...capabilities.values()],
    interactions: { active: [...interactions.values()], resolved: resolvedInteractions },
    signal,
    turnActive,
    lastActivityAt,
    bornTicketless,
  };
}

export function sameSessionCommand(left: SessionCommand, right: SessionCommand): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    sameSessionCommandIntent(left.intent, right.intent) &&
    stableSessionValue(left.route) === stableSessionValue(right.route)
  );
}

/** Compares caller intent without deriving or re-resolving a durable delivery route. */
export function sameSessionCommandRequest(
  command: SessionCommand,
  request: SessionCommandRequest,
): boolean {
  return (
    command.id === request.id &&
    command.sessionId === request.sessionId &&
    sameSessionCommandIntent(command.intent, request.intent)
  );
}

/** Compares the durable content of two facts, independent of ledger-assigned metadata. */
export function sameSessionEventPayload(
  left: SessionEventPayload,
  right: SessionEventPayload,
): boolean {
  return left.kind === right.kind && stableSessionValue(left) === stableSessionValue(right);
}

/** Compares envelope provenance without treating storage timestamps as identity. */
export function sameSessionEventProvenance(
  left: SessionEventProvenance,
  right: SessionEventProvenance,
): boolean {
  return stableSessionValue(left) === stableSessionValue(right);
}

function sameSessionCommandIntent(
  left: SessionCommandIntent,
  right: SessionCommandIntent,
): boolean {
  return left.kind === right.kind && stableSessionValue(left) === stableSessionValue(right);
}

/**
 * A storage transaction for the event ledger, intentionally free of SQL-shaped
 * operations.
 *
 * Sessions, events, commands and receipts are all insert-only here, and that is
 * a contract rather than an omission: there is no verb that updates or removes
 * any of them. Everything about a Session that changes changes by an event, and
 * `projectSession` is what applies them — which is what lets a reader hold a
 * base Session row, or a fold of a prefix of the log, and know it stays true.
 * Adding a verb that rewrites a row breaks every such reader.
 */
export interface SessionLedgerTransaction {
  /** The stored row as inserted. Only its events change what a Session shows. */
  getSession(sessionId: string): Session | null;
  /** Returns immutable base Sessions ordered by creation time descending, then id descending. */
  listSessions(query: ListSessionsQuery): readonly Session[];
  /** Counts base Sessions without reading their event histories or building projections. */
  countSessions(query: ListSessionsQuery): number;
  /** Latest explicit outcome per ticket, selected by occurred time then Session id. */
  listLatestTicketSignals(
    query: ListLatestTicketSignalsQuery,
  ): readonly import("./ticket-events").LatestSessionSignal[];
  insertSession(session: Session): void;
  getEvent(eventId: string): SessionEvent | null;
  appendEvent(event: SessionEvent): void;
  /** Returns events in ascending per-Session sequence order. */
  listEvents(query: ListSessionEventsQuery): readonly SessionEvent[];
  getCommand(commandId: string): SessionCommand | null;
  saveCommand(command: SessionCommand): void;
  getReceipt(receiptId: string): CommandReceipt | null;
  /** Returns receipt history in ascending receipt/event sequence order. */
  listReceipts(commandId: string): readonly CommandReceipt[];
  appendReceipt(receipt: CommandReceipt): void;
}

/** The composition root guarantees atomicity for every function passed here. */
export interface SessionLedger {
  transaction<T>(work: (transaction: SessionLedgerTransaction) => Promise<T> | T): Promise<T>;
}

/** Injected by the composition root so the domain never imports a runtime clock or UUID library. */
export interface SessionLedgerClock {
  now(): number;
}

export interface SessionLedgerIds {
  next(kind: "session" | "event" | "receipt"): string;
}

function stableSessionValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableSessionValue).join(",")}]`;

  const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSessionValue(item)}`).join(",")}}`;
}
