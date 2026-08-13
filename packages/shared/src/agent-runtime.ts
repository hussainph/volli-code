/**
 * Product-owned Session and model policy consumed by the Agent Runtime, and the
 * Agent Runtime contracts themselves.
 *
 * This is the boundary between Volli's Session Engine and the singular
 * Pi-backed executor. It speaks Volli vocabulary only: no Pi SDK types, no
 * Electron, no renderer concerns. Pi-native detail crosses this boundary in
 * exactly two bounded forms — the opaque {@link RuntimeRecoveryRef} stored on
 * the Session Attachment, and sanitized diagnostic strings. Nothing above the
 * runtime may dispatch on Pi tool or event names.
 *
 * {@link RuntimeObservation} is the only observation vocabulary. What a Session
 * writes down is derived from it in `@volli/session-engine`, which owns Session
 * facts; an executor states what happened and never what to record.
 */

import type { ActivityDescriptor } from "./session-activity";
import type { AuthorityDenialCause, AuthoritySnapshot, CodingToolId } from "./authority";
import {
  SESSION_ESCALATION_OPTIONS,
  SESSION_ESCALATION_STOP_ID,
  SESSION_PERMISSION_OPTIONS,
  SESSION_REFUSAL_OPTION_IDS,
  type SessionInteraction,
  type SessionInteractionCancelReason,
  type SessionInteractionOption,
  type SessionInteractionResolution,
} from "./session-ledger";

export type SessionRole = "project" | "ticket" | "subagent";

/** Volli's reasoning policy, independent of any provider's type names. */
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The selected model access for one Session attachment. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
}

/** Whether the singular Agent Runtime can truthfully use one account or model. */
export type ModelAccessState = "available" | "authentication-required" | "unavailable";

/** Sanitized hint about how use of one provider is billed. */
export type ModelAccessBillingSource =
  | "subscription"
  | "api-key"
  | "gateway"
  | "local"
  | "ambient"
  | "unknown";

/** Product recovery vocabulary. Runtime-native login detail stays behind the host seam. */
export interface ModelAccessRecovery {
  kind: "external-sign-in" | "retry";
}

/** One provider account as the renderer may see it. Never contains credentials. */
export interface ModelAccessProvider {
  id: string;
  label: string;
  state: ModelAccessState;
  accountLabel: string | null;
  billingSource: ModelAccessBillingSource;
  recovery: ModelAccessRecovery | null;
}

/** One model the runtime knows, qualified by current account availability. */
export interface ModelAccessModel {
  providerId: string;
  modelId: string;
  label: string;
  state: ModelAccessState;
  reasoningLevels: readonly ReasoningLevel[];
}

/** The complete sanitized Model Access view at one observation time. */
export interface ModelAccessSnapshot {
  observedAt: number;
  providers: readonly ModelAccessProvider[];
  models: readonly ModelAccessModel[];
}

/** The Roles that attach a runtime. Subagent Sessions have no attachment of their own. */
export type RuntimeSessionRole = Extract<SessionRole, "ticket" | "project">;

/** Volli identities every runtime attachment carries, whatever its Role. All opaque. */
interface RuntimeIdentityFields {
  sessionId: string;
  rootThreadId: string;
  attachmentId: string;
  projectId: string;
}

/** A Ticket Session's identity: the Role is what guarantees the Ticket is there. */
export interface TicketRuntimeIdentity extends RuntimeIdentityFields {
  role: Extract<RuntimeSessionRole, "ticket">;
  ticketId: string;
}

/** A project-scoped Session's identity: ticketless by construction, never by omission. */
export interface ProjectRuntimeIdentity extends RuntimeIdentityFields {
  role: Extract<RuntimeSessionRole, "project">;
  ticketId: null;
}

/**
 * Role and identity are one value, not two agreeing fields.
 *
 * The Role decides what the runtime may assume about the Session — a Ticket to
 * work, or a project root and nothing else — so a spec that named the Role
 * separately from the identity could state a Ticket Session with no Ticket. Here
 * that shape does not typecheck.
 */
export type RuntimeSessionIdentity = TicketRuntimeIdentity | ProjectRuntimeIdentity;

/** Where execution happens. Local is the only venue built today. */
export type ExecutionVenue = "local";

export interface RuntimeToolBundle {
  tools: readonly CodingToolId[];
}

/** Generated Runtime Brief, delivered as persisted Session input. */
export interface RuntimeBrief {
  text: string;
}

/** A controlled prompt resource supplied by the product, never discovered. */
export interface PromptResource {
  name: string;
  text: string;
}

/**
 * Bounded runtime-native recovery reference stored on the Session Attachment.
 * Opaque to every layer above the runtime; used to reopen the Pi sidecar and
 * deduplicate completed entries after restart.
 */
export interface RuntimeRecoveryRef {
  runtime: "pi";
  sessionId: string;
  sessionFilePath: string;
}

/**
 * Which half of {@link AuthorityFallback} sent the runtime to ask.
 *
 * Worth naming rather than collapsing, because the two mean different things to
 * the person answering: a run of refusals back to back means the policy is in
 * the way of one line of work, while a total across the Session means it is in
 * the way of the Session.
 */
export type RuntimeAskTrip = "consecutive" | "session";

/**
 * One escalation: a question the runtime blocks on because its own policy keeps
 * refusing.
 *
 * Deliberately a port and not an observation. An observation states what
 * happened and expects no reply; this needs an answer before the tool call it
 * belongs to can proceed either way. Keeping it a typed port is also what keeps
 * `@volli/agent-runtime` free of ledger types — the host owns the interaction
 * record, and the runtime owns only the question.
 */
export interface RuntimeAskRequest {
  /** The rule that refused, or `call.unreadable` when the gate refused before any ran. */
  cause: AuthorityDenialCause;
  /** The runtime tool name as requested, which may not be a tool Volli offers. */
  tool: string;
  /**
   * The runtime's own id for the call being judged.
   *
   * Carried so a producer can correlate the question to the activity row it is
   * about. Without it an ask can only ever be shown at the foot of the
   * transcript, never against the call that raised it.
   */
  toolCallId: string;
  /** The turn the blocked call belongs to. Null before the first turn opens. */
  turnId: string | null;
  /** The refusing rule's own words, as the model would otherwise have received them. */
  reason: string;
  trip: RuntimeAskTrip;
  /**
   * Whether a person may overrule this refusal.
   *
   * Not "could the call run if this layer stood aside" — for the hard-deny rules
   * that is true and is exactly why they are not overridable. See
   * {@link OVERRIDABLE_AUTHORITY_RULES}, which keeps the two reasons apart: some
   * refusals an override could not honour anyway, because the sandbox denies
   * them too or the tool is not loaded; the rest are perfectly grantable and
   * must not be granted, because a login item or a disabled certificate check
   * outlives the Session that asked for it.
   *
   * The runtime enforces this rather than trusting it: a host that answers
   * `allow` to a refusal that is not overridable is not obeyed.
   */
  overridable: boolean;
}

/**
 * What a person chose when the runtime stopped and asked.
 *
 * `allow` grants exactly this call: there is no durable policy store to write a
 * standing answer into, so nothing here can mean "always". `stop` ends the turn,
 * not the Session.
 *
 * Named a choice rather than an outcome or an answer deliberately — `CONTEXT.md`
 * reserves both of those for the durable Session Interaction vocabulary, and
 * this is the runtime's private reading of a decision that is recorded there.
 */
export type RuntimeAskChoice = "allow" | "refuse" | "stop";

/** What one escalation puts in front of a person. */
export interface RuntimeAskOffer {
  kind: SessionInteraction["kind"];
  options: readonly SessionInteractionOption[];
}

const PERMISSION_OPTION_IDS = { once: "once", reject: "reject" } as const;

/**
 * The choices one escalation offers, in Volli's own interaction vocabulary.
 *
 * Both pairs are minted from the ledger's own lists rather than written out
 * here, because the surface that offers a choice and the runtime that reads the
 * answer are one decision made twice, and the option ids are the wire between
 * them. A literal restated on either side compiles cleanly and fails silently.
 * Two things about the pairs are deliberate.
 *
 * `always` is absent from the overridable pair even though
 * {@link SESSION_PERMISSION_OPTIONS} declares it: there is no durable policy
 * store to write a standing grant into, and an option that silently meant
 * `once` would be a lie told in the one place a person is being asked to trust
 * us. It is filtered from that list rather than restated as literals, so the
 * labels stay defined in the one place the ledger defines them.
 *
 * A refusal that cannot be overridden still asks, because it is still a real
 * question — not "may it run", which is settled, but "is this policy in your
 * way badly enough to stop". That is why it is an interaction and not an
 * Attention: it has a consequence either way.
 */
export function askOffer(request: RuntimeAskRequest): RuntimeAskOffer {
  if (!request.overridable) return { kind: "question", options: SESSION_ESCALATION_OPTIONS };
  const offered = new Set<string>([PERMISSION_OPTION_IDS.once, PERMISSION_OPTION_IDS.reject]);
  return {
    kind: "permission",
    options: SESSION_PERMISSION_OPTIONS.filter((option) => offered.has(option.id)),
  };
}

/**
 * Read a person's chosen option ids back as an outcome.
 *
 * Fails to a refusal. Every id this does not recognise — an empty answer, a
 * stale option from a build that offered something else, free text where a
 * choice was expected — leaves the call refused, which is the state it was
 * already in. The only answers that change anything are the two this
 * deliberately spells out.
 */
export function askChoice(
  request: RuntimeAskRequest,
  optionIds: readonly string[],
): RuntimeAskChoice {
  // Refusal is read first, so an answer carrying both a grant and a refusal
  // resolves toward the state the call was already in. A multi-select that
  // accumulated `once` and `reject` together is incoherent, and resolving an
  // incoherent permission toward execution is the wrong direction to be wrong in.
  const chosen = optionIds.map((id) => id.toLowerCase());
  if (chosen.some((id) => SESSION_REFUSAL_OPTION_IDS.includes(id))) return "refuse";
  if (request.overridable) {
    return chosen.includes(PERMISSION_OPTION_IDS.once) ? "allow" : "refuse";
  }
  return chosen.includes(SESSION_ESCALATION_STOP_ID) ? "stop" : "refuse";
}

/** Everything the Agent Runtime needs to start one Session, whatever its Role. */
export interface SessionRuntimeSpec {
  identity: RuntimeSessionIdentity;
  /**
   * Immutable execution root — a Ticket's isolated worktree, or a project root
   * for a ticketless Session. All filesystem and process work stays inside it.
   */
  workspacePath: string;
  venue: ExecutionVenue;
  model: ModelSelection;
  authority: AuthoritySnapshot;
  brief: RuntimeBrief;
  promptResources?: readonly PromptResource[];
  tools: RuntimeToolBundle;
  /** Opaque Pi sidecar locator from the durable Session Attachment. */
  recovery?: RuntimeRecoveryRef;
  signal?: AbortSignal;
  /**
   * Refusals this Session already accrued, before this attachment existed.
   *
   * Carried beside {@link AuthoritySnapshot} rather than inside it because a
   * count is live machine state and not policy — the snapshot's own rule is that
   * the facts its rules read stay live while the policy is pinned. The per-
   * Session half of {@link AuthorityFallback} is a fact about the Session, so a
   * counter starting from zero on every attach would never reach its threshold;
   * the consecutive half has no equivalent, since an allowed call is not an
   * event and only a live runtime sees both answers.
   */
  priorAuthorityDenials?: number;
  /**
   * Ask a person, and block until they answer.
   *
   * Optional, and its absence is a working configuration rather than a
   * degradation: with no host to ask, the fallback thresholds have nothing to
   * escalate to and every refusal stays silent, which is exactly what shipped
   * before this port existed.
   *
   * There is no timeout, invented or otherwise — an unanswered question parks
   * the turn for as long as it takes. `signal` is how the wait ends without an
   * answer, and a host must listen to it: it fires when the turn is interrupted
   * or the attachment is released, and it is the host's only notice that the
   * question it is showing has been abandoned and must be withdrawn. A host that
   * ignores it strands whatever it opened, because the runtime stops waiting
   * either way.
   *
   * Rejecting the promise is a different statement, and the runtime treats it as
   * one: it means the host cannot obtain an answer at all, so the refusal stands
   * and *is recorded*. Aborting means nobody was asked; rejecting means nobody
   * could be.
   *
   * A host that opens a durable record for the question should commit it before
   * parking, and commit the answer before resolving — otherwise a relaunch
   * mid-wait loses the question while the runtime is still blocked on it.
   */
  ask?: (request: RuntimeAskRequest, signal: AbortSignal) => Promise<RuntimeAskChoice>;
  /** Resolves only after the observation reaches its required consumer boundary. */
  observer: (observation: RuntimeObservation) => Promise<void>;
}

/** Sanitized failure surfaced through observations. Never contains secrets. */
export interface RuntimeFailure {
  reason: "auth" | "configuration" | "context" | "model" | "aborted" | "unknown";
  message: string;
}

export interface SanitizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface SettledAssistantMessage {
  /** Stable runtime entry identity; deduplicates replay after restart. */
  entryId: string;
  role: "assistant";
  text: string;
  reasoning?: string;
  model?: { providerId: string; modelId: string };
  usage?: SanitizedUsage;
}

export type RuntimeObservation =
  | AttachmentObservation
  | TurnObservation
  | TranscriptDeltaObservation
  | SettledMessageObservation
  | RuntimeActivityObservation
  | AuthorityObservation
  | AttentionObservation
  | InteractionObservation;

/**
 * The Session's authority refused a call, before the tool ran.
 *
 * Not an activity that failed: no tool executed, and the runtime is reporting
 * Volli's own decision back to Volli. Emitted through the same observer as
 * everything else so the refusal reaches durable history before the model is
 * told — `observer` resolves only at the consumer boundary, which is what makes
 * "recorded, then refused" an ordering the runtime can actually keep.
 */
export interface AuthorityObservation {
  kind: "authority";
  state: "denied";
  /** Null before the first turn opens, which a refusal need not wait for. */
  turnId: string | null;
  tool: string;
  cause: AuthorityDenialCause;
  reason: string;
  occurredAt?: number;
}

export interface AttachmentObservation {
  kind: "attachment";
  state: "started" | "recovered" | "closed" | "failed";
  recovery?: RuntimeRecoveryRef;
  failure?: RuntimeFailure;
}

export interface TurnObservation {
  kind: "turn";
  state: "started" | "completed" | "interrupted";
  turnId: string;
  occurredAt?: number;
  recoveryCursor?: string;
}

/** Transient stream delta. Never advances the durable recovery cursor. */
export interface TranscriptDeltaObservation {
  kind: "delta";
  turnId: string;
  channel: "text" | "reasoning";
  text: string;
}

/** A completed runtime message settling exactly once into durable history. */
export interface SettledMessageObservation {
  kind: "message-settled";
  turnId: string;
  message: SettledAssistantMessage;
  occurredAt?: number;
  recoveryCursor?: string;
}

/** JSON-safe, runtime-normalized tool input and output. */
export type RuntimeActivityValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeActivityValue[]
  | { readonly [key: string]: RuntimeActivityValue };

interface RuntimeActivityObservationBase {
  kind: "activity";
  /** The Volli turn that owns this activity lifecycle. */
  turnId: string;
  activityId: string;
  descriptor: ActivityDescriptor;
  input: RuntimeActivityValue;
  output: RuntimeActivityValue;
  occurredAt?: number;
  recoveryCursor?: string;
}

export type RuntimeActivityObservation =
  | (RuntimeActivityObservationBase & {
      state: "started" | "progress" | "completed";
      error?: never;
    })
  | (RuntimeActivityObservationBase & {
      state: "failed";
      error?: string;
    });

/**
 * Attention's `reason` is frozen, unlike the arms of this union.
 *
 * Pi's recovery sidecar validates a persisted marker by switching on `kind` and
 * then whitelisting this exact set — and it throws rather than skipping what it
 * does not recognise. Adding a whole new observation kind is therefore safe: the
 * sidecar never sees one, so no marker already on disk changes how it validates.
 * Adding a `reason` is not: every attention marker written by an older build is
 * re-validated against the new list on the next recovery, and a Session whose
 * marker no longer matches fails to attach outright.
 */
export interface AttentionObservation {
  kind: "attention";
  state: "raised" | "cleared";
  reason: "auth" | "configuration" | "context" | "runtime-failure" | "partial-turn";
  message: string;
  occurredAt?: number;
  recoveryCursor?: string;
}

/**
 * The executor is waiting on a person, until it is answered or stops being asked.
 *
 * The runtime owns everything about the ask except which attachment is doing the
 * asking: the Session Engine injects `attachmentId` when it records the fact, so
 * the runtime cannot name an attachment other than its own. The Pi adapter
 * raises all three arms around its {@link SessionRuntimeSpec.ask} host: an
 * escalation opens one, an answer resolves it, and an abort cancels it.
 *
 * `cancelled` carries a reason where `resolved` carries a resolution, and
 * deliberately cannot carry both — see {@link SessionInteractionCancelReason}
 * for why an ask that ended undecided must leave nothing a reader could take for
 * a decision.
 */
export type InteractionObservation =
  | {
      kind: "interaction";
      state: "opened";
      interaction: Omit<SessionInteraction, "attachmentId">;
      occurredAt?: number;
    }
  | {
      kind: "interaction";
      state: "resolved";
      interactionId: string;
      resolution: SessionInteractionResolution;
      occurredAt?: number;
    }
  | {
      kind: "interaction";
      state: "cancelled";
      interactionId: string;
      reason: SessionInteractionCancelReason;
      occurredAt?: number;
    };

export type RuntimeMessageDelivery = "queue" | "steer" | "replace";

/** Observable outcome of one delivery attempt. Never silently reinterpreted. */
export type DeliveryOutcome =
  | { kind: "delivered"; delivery: "prompt" | "queue" | "steer" | "retry" }
  | {
      kind: "rejected";
      reason: "busy-unsupported" | "closed" | "replace-unsupported" | "retry-unavailable";
      message: string;
    };

/** Observable outcome of applying one idle-time Session model policy. */
export type ModelSelectionOutcome =
  | { kind: "selected" }
  | {
      kind: "rejected";
      reason: "busy-unsupported" | "closed" | "model-unavailable" | "reasoning-unsupported";
      message: string;
    };

/** One live runtime attachment. Closing it never ends Session identity. */
export interface RuntimeAttachmentHandle {
  submitUserMessage(
    text: string,
    delivery?: RuntimeMessageDelivery,
    commandId?: string,
  ): Promise<DeliveryOutcome>;
  /** Apply a validated model policy only while this attachment is idle. */
  selectModel(selection: ModelSelection): Promise<ModelSelectionOutcome>;
  /** Retry the last failed run without duplicating its user message. */
  retry(commandId?: string): Promise<DeliveryOutcome>;
  /** Abort the current run and settle the resulting state honestly. */
  interrupt(): Promise<void>;
  /** Release local resources; the Session and its history remain. */
  close(): Promise<void>;
  /** Replays durable semantic markers after an optional sidecar checkpoint. */
  reconcile(cursor: string | null): Promise<{
    cursor: string | null;
    observations: readonly RuntimeObservation[];
    /** Commands Pi durably accepted into a turn, for post-crash receipt repair. */
    receipts?: readonly { commandId: string; acceptedAt: number }[];
  }>;
  /** Recovery metadata persisted by the Session owner for exact sidecar reopen. */
  readonly recovery: RuntimeRecoveryRef | undefined;
}

/** The singular runtime port. Not a registry; there is exactly one executor. */
export interface AgentRuntime {
  /** Inspect provider accounts and models without exposing runtime credentials or native types. */
  inspectModelAccess(input?: {
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<ModelAccessSnapshot>;
  startSession(spec: SessionRuntimeSpec): Promise<RuntimeAttachmentHandle>;
}
