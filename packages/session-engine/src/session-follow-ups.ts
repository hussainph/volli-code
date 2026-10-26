import type {
  CommandReceipt,
  SessionCommand,
  SessionEvent,
  SessionOrigin,
  Synchronous,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { SessionRuntimeCommandResult } from "./session-runtime";

/** Separate from the event vocabulary: older readers must still open this DB. */
export interface SessionFollowUpItem {
  id: string;
  message: UIMessage;
  commandId: string;
  state: "queued" | "releasing";
  /** Display-only wait hint; target identity stays host-private. */
  afterCurrentStep?: true;
}

export interface SessionFollowUpCommand {
  id: string;
  sessionId: string;
  createdAt: number;
  route: null;
  intent:
    | { kind: "message.queue"; message: UIMessage }
    | { kind: "message.edit"; messageId: string; message: UIMessage; expectedRevision?: number }
    | { kind: "message.cancel"; messageId: string; expectedRevision?: number };
}

export interface StoredSessionFollowUp extends SessionFollowUpItem {
  origin?: SessionOrigin;
  model?: { providerId: string; modelId: string } | null;
  agent?: string | null;
  variant?: string | null;
  /** Never reused for a different payload, even after an edit. */
  deliveryCommandId: string;
  /** A queued steer owns the payload and its original active turn until settled. */
  steer?: { signature: string; targetTurnId: string };
  /** Terminal refusal is safe to edit/cancel, but must not be retried unchanged. */
  refused?: boolean;
  /** Host-only refusal explanation, retained so a later boot can restore Attention. */
  refusedDetail?: string;
}

/** Full replies have a retry window/floor; compact queue identities also protect N−1. */
export interface SessionFollowUpState {
  version: 1;
  revision: number;
  entries: StoredSessionFollowUp[];
  commands: Record<string, { signature: string; result: SessionRuntimeCommandResult }>;
  /** One release per durable idle boundary, including across process restarts. */
  releasedBoundary: string | null;
  /** Transaction-local delivery outcomes; adapters always persist this as {} for N−1. */
  releases: Record<string, { command: SessionCommand; receipt: CommandReceipt }>;
}

export function sessionFollowUpDeliveryCommandId(sessionId: string, commandId: string): string {
  return `follow-up:${encodeURIComponent(sessionId)}:${encodeURIComponent(commandId)}`;
}

export function emptySessionFollowUpState(): SessionFollowUpState {
  return {
    version: 1,
    revision: 0,
    entries: [],
    commands: {},
    releasedBoundary: null,
    releases: {},
  };
}

/**
 * A synchronous proof read scoped to the queue transaction's storage snapshot.
 * The host must read the event ledger in that SAME transaction, not use a
 * cached projection or begin a separate async transaction. Missing proof
 * support fails closed for withdrawal of releasing rows.
 */
export type SessionFollowUpDeliveryProof = (deliveryCommandId: string) => boolean;

/** Exact runner-local proof that this identity was used by a queue command. */
export type SessionFollowUpQueuedMessageProof = (messageId: string) => boolean;

/**
 * Atomic, synchronous read/modify/write. Storage commits before resolving.
 * Writers index message.queue identities before pruning their last reply;
 * queuedMessageProof reads that exact, Session-scoped index in this snapshot.
 */
export interface SessionFollowUpLedger {
  transaction<T>(
    sessionId: string,
    work: (
      state: SessionFollowUpState,
      deliveryProof?: SessionFollowUpDeliveryProof,
      queuedMessageProof?: SessionFollowUpQueuedMessageProof,
    ) => Synchronous<T>,
    /** A snapshot-only transaction: mutations to its private state are discarded. */
    options?: { mode: "read" },
  ): Promise<T>;
  pendingSessionIds(): Promise<readonly string[]>;
}

/** At least the backend's seven-day terminal-job dedupe window. */
export const FOLLOW_UP_COMMAND_RETENTION_MS = 7 * 24 * 60 * 60_000;
const FOLLOW_UP_RECENT_COMMANDS = 64;
// Not canonical JSON: no runtime command signature can equal this sentinel.
// N−1 still scans message.queue identities here, but an expired command-id
// replay must conflict rather than reuse a reply whose payload was discarded.
const EXPIRED_FOLLOW_UP_SIGNATURE = "follow-up-reply-expired";

/** Applied after atomically indexing queue identities, never on a pure read. */
export function pruneSessionFollowUpState(state: SessionFollowUpState, now: number): void {
  // Keep writing the v1 field: older readers require a record, even when empty.
  state.releases = {};
  const commands = Object.entries(state.commands).toSorted(
    ([, left], [, right]) =>
      (right.result.receipt?.recordedAt ?? right.result.command.createdAt) -
      (left.result.receipt?.recordedAt ?? left.result.command.createdAt),
  );
  const pendingMessages = new Set(state.entries.map(({ id }) => id));
  const pendingCommands = new Set(
    state.entries.flatMap(({ commandId, deliveryCommandId }) => [commandId, deliveryCommandId]),
  );
  for (const [index, [id, { result }]] of commands.entries()) {
    if (index < FOLLOW_UP_RECENT_COMMANDS || pendingCommands.has(id)) continue;
    const receipt = result.receipt;
    if (
      !receipt ||
      receipt.status === "unreconciled" ||
      !Number.isFinite(receipt.recordedAt) ||
      receipt.recordedAt >= now - FOLLOW_UP_COMMAND_RETENTION_MS
    )
      continue;
    const intent = result.command.intent;
    const messageId =
      intent.kind === "message.queue"
        ? intent.message.id
        : intent.kind === "message.edit" || intent.kind === "message.cancel"
          ? intent.messageId
          : undefined;
    if (messageId !== undefined && pendingMessages.has(messageId)) continue;
    if (intent.kind === "message.queue") {
      if (state.commands[id]!.signature === EXPIRED_FOLLOW_UP_SIGNATURE) continue;
      // Previous runtimes cannot read the compact index. Keep just the shape
      // their stale-steer guard needs, never the old body/metadata/signature.
      // Identity metadata grows until those readers retire; reply payloads do not.
      state.commands[id] = {
        signature: EXPIRED_FOLLOW_UP_SIGNATURE,
        result: {
          sessionId: result.sessionId,
          command: {
            id: result.command.id,
            sessionId: result.command.sessionId,
            createdAt: result.command.createdAt,
            route: null,
            intent: {
              kind: "message.queue",
              message: { id: intent.message.id, role: "user", parts: [] },
            },
          },
          receipt,
          throughSequence: result.throughSequence,
          refusal: null,
        },
      };
    } else delete state.commands[id];
  }
}

export function projectSessionFollowUps(snapshot: SessionFollowUpState): SessionFollowUpItem[] {
  return snapshot.entries.map(({ id, message, commandId, state, steer, refused }) => ({
    id,
    message,
    commandId,
    state,
    ...(steer === undefined || refused ? {} : { afterCurrentStep: true as const }),
  }));
}

/** The same delivery proof for recovery and synchronous transactional cancellation. */
export function sessionFollowUpDeliveryEvidence(
  sessionId: string,
  command: SessionCommand,
  receipts: readonly CommandReceipt[],
  events: readonly SessionEvent[],
): CommandReceipt | null {
  const accepted = receipts.findLast(
    ({ commandId, status }) =>
      commandId === command.id && (status === "accepted" || status === "completed"),
  );
  if (accepted) return accepted;
  const recorded = events.findIndex(
    ({ payload }) => payload.kind === "command.recorded" && payload.command.id === command.id,
  );
  if (recorded < 0) return null;
  for (const event of events.slice(recorded + 1)) {
    const { payload } = event;
    if (payload.kind === "turn.started") {
      if (
        payload.attachmentId !== command.route?.attachmentId ||
        (event.commandId != null
          ? event.commandId !== command.id
          : payload.turnId !== `turn:${command.id}`)
      )
        return null;
      return {
        id: `${command.id}:turn-evidence`,
        commandId: command.id,
        status: "accepted",
        acceptedAt: event.occurredAt,
        result: { kind: "message.submitted", sessionId },
        recordedAt: event.recordedAt,
        sequence: event.sequence,
      };
    }
    if (
      payload.kind === "turn.completed" ||
      payload.kind === "turn.interrupted" ||
      (payload.kind === "command.recorded" &&
        (payload.command.intent.kind === "message.submit" ||
          payload.command.intent.kind === "executor.retry"))
    )
      return null;
  }
  return null;
}
