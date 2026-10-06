import type {
  CommandReceipt,
  SessionCommand,
  SessionEvent,
  SessionLedger,
  SessionOrigin,
  Synchronous,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { SessionRuntimeCommandResult } from "./session-runtime";
import { canonicalJson } from "./transcript-artifacts";

/** Separate from the event vocabulary: older readers must still open this DB. */
export interface SessionFollowUpItem {
  id: string;
  message: UIMessage;
  commandId: string;
  state: "queued" | "releasing";
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

/** Every command reply survives removal of the corresponding queue item. */
export interface SessionFollowUpState {
  version: 1;
  revision: number;
  entries: StoredSessionFollowUp[];
  commands: Record<string, { signature: string; result: SessionRuntimeCommandResult }>;
  /** One release per durable idle boundary, including across process restarts. */
  releasedBoundary: string | null;
  /** Terminal release evidence, retained after removing its payload. */
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

/** Atomic, synchronous read/modify/write. Storage commits before resolving. */
export interface SessionFollowUpLedger {
  transaction<T>(
    sessionId: string,
    work: (
      state: SessionFollowUpState,
      deliveryProof?: SessionFollowUpDeliveryProof,
    ) => Synchronous<T>,
  ): Promise<T>;
  pendingSessionIds(): Promise<readonly string[]>;
}

/** Test adapter; production must inject durable storage, never this fallback. */
export function createInMemorySessionFollowUpLedger(
  eventLedger?: SessionLedger,
): SessionFollowUpLedger {
  const states = new Map<string, SessionFollowUpState>();
  return {
    async transaction<T>(
      sessionId: string,
      work: (
        state: SessionFollowUpState,
        deliveryProof?: SessionFollowUpDeliveryProof,
      ) => Synchronous<T>,
    ) {
      const apply = (deliveryProof?: SessionFollowUpDeliveryProof): Synchronous<T> => {
        const state = JSON.parse(
          canonicalJson(states.get(sessionId) ?? emptySessionFollowUpState()),
        ) as SessionFollowUpState;
        const result = work(state, deliveryProof);
        if (result && typeof result === "object" && "then" in result) {
          throw new Error("Follow-up ledger transaction must be synchronous");
        }
        states.set(sessionId, JSON.parse(canonicalJson(state)) as SessionFollowUpState);
        return result;
      };
      return eventLedger
        ? eventLedger.transaction((transaction) =>
            apply((deliveryCommandId) => {
              const command = transaction.getCommand(deliveryCommandId);
              return (
                command !== null &&
                sessionFollowUpDeliveryEvidence(
                  sessionId,
                  command,
                  transaction.listReceipts(deliveryCommandId),
                  transaction.listEvents({ sessionId }),
                ) !== null
              );
            }),
          )
        : apply();
    },
    async pendingSessionIds() {
      return [...states].filter(([, state]) => state.entries.length > 0).map(([id]) => id);
    },
  };
}

export function projectSessionFollowUps(snapshot: SessionFollowUpState): SessionFollowUpItem[] {
  return snapshot.entries.map(({ id, message, commandId, state }) => ({
    id,
    message,
    commandId,
    state,
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
