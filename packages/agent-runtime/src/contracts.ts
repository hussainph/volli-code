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

import type { AuthoritySnapshot, ModelSelection, SessionRole } from "@volli/shared";

/** Volli identities for one Ticket Session runtime attachment. All opaque. */
export interface TicketRuntimeIdentity {
  sessionId: string;
  rootThreadId: string;
  attachmentId: string;
  projectId: string;
  ticketId: string;
}

/** Only the Ticket Role ships in this migration. */
export type RuntimeSessionRole = Extract<SessionRole, "ticket">;

/** Where execution happens. Local is the only venue built today. */
export type ExecutionVenue = "local";

/**
 * Explicit coding tools the runtime may load. Ambient user/project extensions
 * never load. Product names, mapped to concrete runtime tools internally.
 */
export type CodingToolId = "read" | "edit" | "write";

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

/** Everything the Agent Runtime needs to start one Ticket Session. */
export interface TicketRuntimeSpec {
  identity: TicketRuntimeIdentity;
  role: RuntimeSessionRole;
  /** Immutable ticket-worktree root; all filesystem and process work stays inside it. */
  worktreePath: string;
  venue: ExecutionVenue;
  model: ModelSelection;
  authority: AuthoritySnapshot;
  brief: RuntimeBrief;
  promptResources?: readonly PromptResource[];
  tools: RuntimeToolBundle;
  signal?: AbortSignal;
  /** Resolves only after the observation reaches its required consumer boundary. */
  observer: (observation: RuntimeObservation) => Promise<void>;
}

/** Sanitized failure surfaced through observations. Never contains secrets. */
export interface RuntimeFailure {
  reason: "auth" | "configuration" | "model" | "aborted" | "unknown";
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
}

export interface AttentionObservation {
  kind: "attention";
  state: "raised" | "cleared";
  reason: "auth" | "configuration" | "context" | "runtime-failure";
  message: string;
}

/** Observable outcome of one delivery attempt. Never silently reinterpreted. */
export type DeliveryOutcome =
  | { kind: "delivered"; delivery: "prompt" }
  | {
      kind: "rejected";
      reason: "busy-unsupported" | "closed";
      message: string;
    };

/** One live runtime attachment. Closing it never ends Session identity. */
export interface RuntimeAttachmentHandle {
  submitUserMessage(text: string): Promise<DeliveryOutcome>;
  /** Abort the current run and settle the resulting state honestly. */
  interrupt(): Promise<void>;
  /** Release local resources; the Session and its history remain. */
  close(): Promise<void>;
  /** Recovery metadata persisted for Session 4; this slice does not reopen it. */
  readonly recovery: RuntimeRecoveryRef | undefined;
}

/** The singular runtime port. Not a registry; there is exactly one executor. */
export interface AgentRuntime {
  startTicketSession(spec: TicketRuntimeSpec): Promise<RuntimeAttachmentHandle>;
}
