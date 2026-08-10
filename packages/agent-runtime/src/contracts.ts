/**
 * Product-owned Agent Runtime contracts.
 *
 * This is the boundary between Volli's Session Engine and the singular
 * Pi-backed executor. It speaks Volli vocabulary only: no Pi SDK types, no
 * Electron, no renderer concerns. Pi-native detail crosses this boundary in
 * exactly two bounded forms — the opaque {@link RuntimeRecoveryRef} stored on
 * the Session Attachment, and sanitized diagnostic strings. Nothing above the
 * runtime may dispatch on Pi tool or event names.
 *
 * Later migration sessions add activity and interaction observations only
 * after their canonical vocabulary exists in `@volli/shared`.
 */

import type {
  ActivityDescriptor,
  AuthoritySnapshot,
  ModelAccessSnapshot,
  ModelSelection,
  SessionRole,
} from "@volli/shared";

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

/**
 * Explicit coding tools the runtime may load. Ambient user/project extensions
 * never load. Product names, mapped to concrete runtime tools internally.
 */
export type CodingToolId = "read" | "edit" | "write" | "execute";

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
  | AttentionObservation;

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

export interface AttentionObservation {
  kind: "attention";
  state: "raised" | "cleared";
  reason: "auth" | "configuration" | "context" | "runtime-failure" | "partial-turn";
  message: string;
  occurredAt?: number;
  recoveryCursor?: string;
}

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
