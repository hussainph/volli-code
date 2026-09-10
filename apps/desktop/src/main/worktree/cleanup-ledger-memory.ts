/**
 * The in-process cleanup ledger.
 *
 * The engine's port with no database behind it: used by the suite, and by any
 * composition that wants the command core without durability (there is none in
 * the app today — `cleanup-ledger.ts` is what main wires up). It exists so the
 * core's rules can be tested as rules, without SQLite deciding whether they
 * hold.
 */
import type {
  OrphanCleanupCommand,
  OrphanCleanupFact,
  OrphanCleanupLedger,
} from "./cleanup-engine";
import type { OrphanCleanupReceipt } from "@volli/shared";

export interface MemoryOrphanCleanupLedger extends OrphanCleanupLedger {
  /** Every fact appended so far, in order — the suite's window on the append log. */
  facts(): readonly OrphanCleanupFact[];
}

export function createMemoryOrphanCleanupLedger(): MemoryOrphanCleanupLedger {
  const commands = new Map<string, OrphanCleanupCommand>();
  const order: string[] = [];
  const facts: OrphanCleanupFact[] = [];
  const receipts: OrphanCleanupReceipt[] = [];

  return {
    facts: () => facts,
    async transaction(work) {
      return work({
        getCommand: (commandId) => commands.get(commandId) ?? null,
        insertCommand: (command) => {
          commands.set(command.id, command);
          order.unshift(command.id);
        },
        appendFact: (fact) => {
          facts.push(fact);
        },
        listFacts: (commandId) => facts.filter((fact) => fact.commandId === commandId),
        listReceipts: (commandId) => receipts.filter((receipt) => receipt.commandId === commandId),
        appendReceipt: (receipt) => {
          receipts.push(receipt);
        },
        recentCommandIds: (limit) => order.slice(0, limit),
        // Oldest first, and never truncated: the same statement the SQLite
        // adapter makes, so a recovery test proves the rule and not the store.
        openCommandIds: () =>
          order
            .toReversed()
            .filter(
              (commandId) =>
                facts.some(
                  (fact) => fact.commandId === commandId && fact.kind === "cleanup.accepted",
                ) &&
                !facts.some(
                  (fact) =>
                    fact.commandId === commandId &&
                    (fact.kind === "cleanup.run.finished" ||
                      fact.kind === "cleanup.run.interrupted"),
                ),
            ),
      });
    },
  };
}
