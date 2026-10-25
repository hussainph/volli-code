import type { SessionLedger, Synchronous } from "@volli/shared";
import {
  emptySessionFollowUpState,
  sessionFollowUpDeliveryEvidence,
  type SessionFollowUpDeliveryProof,
  type SessionFollowUpLedger,
  type SessionFollowUpState,
} from "../session-follow-ups";
import { canonicalJson } from "../transcript-artifacts";

/**
 * The follow-up queue held in memory, for tests. Production injects the SQLite
 * queue (host-core's `createSqliteSessionFollowUpLedger`); both are held to
 * `describeSessionFollowUpLedgerContract`.
 *
 * Given the event ledger, a transaction runs inside one of its transactions so
 * the delivery proof reads the same snapshot, as the SQLite queue's does.
 */
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
        // As the SQLite queue does: a Session nobody has written keeps no row
        // until a writer moves its revision.
        if (states.has(sessionId) || state.revision > 0) {
          states.set(sessionId, JSON.parse(canonicalJson(state)) as SessionFollowUpState);
        }
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
      return [...states]
        .filter(([, state]) => state.entries.length > 0)
        .map(([id]) => id)
        .toSorted();
    },
  };
}
