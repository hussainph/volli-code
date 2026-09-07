/**
 * The orphan CLEANUP core: commands in, immutable facts out, one projection
 * over them (VC-284 review S1).
 *
 * The destructive half used to be a raw IPC call that deleted directories and
 * then rewrote a JSON blob describing what it had done. Two things were wrong
 * with that, and they are the same thing twice: the act had no identity, so a
 * repeated invocation was a second deletion rather than the same command; and
 * its record was mutable, so an app that died mid-removal could come back and
 * describe a folder it had already deleted as work nobody had attempted.
 *
 * So cleanup is a command (docs/BOUNDARIES.md rule 5). A caller mints a UUID
 * and hands over intent — which scan revision was confirmed, which items of it
 * were selected, and the preservation policy in force. This core records the
 * command, answers with an acceptance receipt, and thereafter accepts only
 * FACTS: this item's mutation began; this item ended this way. Nothing is ever
 * updated in place. The run a surface renders is a fold of those facts, and the
 * fold takes the FIRST outcome recorded for an item, which is what makes
 * "completed can never become pending again" a property of the shape rather
 * than a promise about the order of writes.
 *
 * It knows nothing about Electron, SQLite, git, or a renderer. The ledger is a
 * port (`cleanup-ledger.ts` is the SQLite adapter, `cleanup-ledger-memory.ts`
 * the in-process one); the executor that actually runs git lives in
 * `cleanup.ts` and talks to this through the same narrow surface a future
 * daemon host would.
 */
import type {
  OrphanCleanupItem,
  OrphanCleanupItemOutcome,
  OrphanCleanupPlanItem,
  OrphanCleanupReceipt,
  OrphanCleanupRejectionCode,
  OrphanCleanupRun,
  OrphanCleanupSource,
} from "@volli/shared";

/** A value a durable host may answer synchronously today or asynchronously later. */
type Awaitable<T> = T | Promise<T>;

/** How many runs a projection reads back by default — enough history to audit, bounded. */
export const RECENT_CLEANUP_RUNS = 20;

/** What one cleanup command asked for. The plan travels with it, so the record is self-describing. */
export interface OrphanCleanupIntent {
  kind: "orphan.cleanup";
  source: OrphanCleanupSource;
  /** The scan revision whose proposal was confirmed. */
  scanRevision: string;
  /** The retention window the proposal was measured against. */
  retentionDays: number;
  /** Preservation rule ids (`@volli/shared`) in force for this run. */
  preservation: readonly string[];
  /** Exactly the items selected out of that revision's plan. */
  items: readonly OrphanCleanupPlanItem[];
}

/** Explicit intent, keyed by the caller's UUID. A command is not evidence anything happened. */
export interface OrphanCleanupCommand {
  id: string;
  intent: OrphanCleanupIntent;
  createdAt: number;
}

/** The fact kinds this core appends. Append-only: a kind is never re-purposed. */
export type OrphanCleanupFactKind =
  | "command.recorded"
  | "cleanup.accepted"
  | "cleanup.rejected"
  | "cleanup.item.started"
  | "cleanup.item.settled"
  | "cleanup.run.finished"
  | "cleanup.run.interrupted"
  | "command.receipt.recorded";

/** One immutable fact about a cleanup command. */
export interface OrphanCleanupFact {
  id: string;
  commandId: string;
  kind: OrphanCleanupFactKind;
  payload: unknown;
  createdAt: number;
}

/** The storage port. Deliberately free of Electron and SQLite types. */
export interface OrphanCleanupLedgerTransaction {
  getCommand(commandId: string): Awaitable<OrphanCleanupCommand | null>;
  insertCommand(command: OrphanCleanupCommand): Awaitable<void>;
  appendFact(fact: OrphanCleanupFact): Awaitable<void>;
  /** Every fact for one command, in the order it was appended. */
  listFacts(commandId: string): Awaitable<readonly OrphanCleanupFact[]>;
  listReceipts(commandId: string): Awaitable<readonly OrphanCleanupReceipt[]>;
  appendReceipt(receipt: OrphanCleanupReceipt): Awaitable<void>;
  /** Command ids, newest first, for the projection and the launch reconcile. */
  recentCommandIds(limit: number): Awaitable<readonly string[]>;
}

export interface OrphanCleanupLedger {
  transaction<T>(work: (transaction: OrphanCleanupLedgerTransaction) => Awaitable<T>): Promise<T>;
}

export interface OrphanCleanupEnginePorts {
  ledger: OrphanCleanupLedger;
  now(): number;
  /** Every persisted id this core mints is a UUID in the desktop composition. */
  nextId(): string;
}

/** Acceptance, replay, or a refusal a caller can act on. */
export type OrphanCleanupAcceptance =
  | { ok: true; run: OrphanCleanupRun; receipt: OrphanCleanupReceipt; replayed: boolean }
  | {
      ok: false;
      code: OrphanCleanupRejectionCode;
      error: string;
      receipt: OrphanCleanupReceipt;
      /** The run already recorded under this command id, when there is one. */
      run: OrphanCleanupRun | null;
    };

export interface OrphanCleanupEngine {
  /**
   * Records intent and answers with local acceptance. Idempotent on the
   * caller's command id: the same id with the same intent replays the first
   * run instead of touching anything twice, and the same id with DIFFERENT
   * intent is refused rather than quietly widened.
   */
  accept(input: {
    commandId: string;
    source: OrphanCleanupSource;
    scanRevision: string;
    retentionDays: number;
    preservation: readonly string[];
    items: readonly OrphanCleanupPlanItem[];
  }): Promise<OrphanCleanupAcceptance>;
  /**
   * Records a command that was refused before any plan existed — an unknown or
   * superseded scan revision, or item ids that revision never proposed. Kept
   * durably on purpose: "something asked to delete against a scan we no longer
   * hold" is exactly the request an audit wants to find.
   */
  reject(input: {
    commandId: string;
    scanRevision: string;
    code: OrphanCleanupRejectionCode;
    error: string;
  }): Promise<OrphanCleanupReceipt>;
  /** Announces that one item's external mutation is ABOUT to run. */
  beginItem(input: { commandId: string; itemId: string }): Promise<void>;
  /** Records one item's immutable outcome. A second outcome for an item is ignored by the fold. */
  settleItem(input: {
    commandId: string;
    itemId: string;
    state: OrphanCleanupItemOutcome;
    detail: string | null;
    branch?: string | null;
  }): Promise<void>;
  /** Closes the run and completes its receipt. */
  finish(input: {
    commandId: string;
  }): Promise<{ run: OrphanCleanupRun; receipt: OrphanCleanupReceipt }>;
  /** Stamps a run the app never finished; completed items are untouched. */
  markInterrupted(input: { commandId: string }): Promise<OrphanCleanupRun | null>;
  /** One run, folded from its facts. */
  run(commandId: string): Promise<OrphanCleanupRun | null>;
  /** The recent runs, newest first — the durable history Storage renders. */
  recentRuns(limit?: number): Promise<OrphanCleanupRun[]>;
  /** Runs with neither a finished nor an interrupted fact: the ones a launch reconciles. */
  openRuns(limit?: number): Promise<OrphanCleanupRun[]>;
}

/** Stable JSON for intent comparison — key order must not decide whether two intents match. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function sameIntent(left: OrphanCleanupIntent, right: OrphanCleanupIntent): boolean {
  return stableJson(left) === stableJson(right);
}

function planItemToProjection(item: OrphanCleanupPlanItem): OrphanCleanupItem {
  return {
    id: item.id,
    kind: item.kind,
    path: item.path,
    projectId: item.projectId,
    projectName: item.projectName,
    branch: item.branch,
    state: "pending",
    detail: null,
    startedAt: null,
    settledAt: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Folds one command's facts into the run a surface renders.
 *
 * Three rules, and each one is a review finding made structural:
 *  - a command with no `cleanup.accepted` fact has no run (a refused request
 *    never becomes history that looks like an attempt);
 *  - an item's FIRST settled fact wins, so nothing can relabel a completed
 *    removal — not a retry, not a reconcile, not a corrupted later write;
 *  - an item announced but never settled reads `executing`, which is a
 *    different statement from `pending` and is what the launch reconcile has to
 *    resolve against the world.
 */
export function foldCleanupRun(facts: readonly OrphanCleanupFact[]): OrphanCleanupRun | null {
  let run: OrphanCleanupRun | null = null;
  const byId = new Map<string, OrphanCleanupItem>();
  for (const fact of facts) {
    const payload = isRecord(fact.payload) ? fact.payload : {};
    switch (fact.kind) {
      case "cleanup.accepted": {
        const intent = payload["intent"];
        if (!isRecord(intent)) break;
        const items = Array.isArray(intent["items"]) ? intent["items"] : [];
        const projected = items
          .filter((item): item is OrphanCleanupPlanItem => isRecord(item))
          .map(planItemToProjection);
        run = {
          id: fact.commandId,
          source: intent["source"] === "startup" ? "startup" : "settings",
          scanRevision: typeof intent["scanRevision"] === "string" ? intent["scanRevision"] : "",
          startedAt: fact.createdAt,
          finishedAt: null,
          interruptedAt: null,
          preservation: Array.isArray(intent["preservation"])
            ? intent["preservation"].filter((rule): rule is string => typeof rule === "string")
            : [],
          retentionDays:
            typeof intent["retentionDays"] === "number" ? intent["retentionDays"] : 0,
          items: projected,
        };
        for (const item of projected) byId.set(item.id, item);
        break;
      }
      case "cleanup.item.started": {
        const item = byId.get(String(payload["itemId"]));
        // Never over a settled item: an outcome is final, and a stray start
        // fact after one must not reopen it.
        if (item === undefined || item.settledAt !== null) break;
        item.startedAt = fact.createdAt;
        item.state = "executing";
        break;
      }
      case "cleanup.item.settled": {
        const item = byId.get(String(payload["itemId"]));
        if (item === undefined || item.settledAt !== null) break;
        const state = payload["state"];
        item.state =
          state === "completed" || state === "skipped" || state === "failed"
            ? state
            : "indeterminate";
        item.detail = typeof payload["detail"] === "string" ? payload["detail"] : null;
        if (typeof payload["branch"] === "string") item.branch = payload["branch"];
        item.settledAt = fact.createdAt;
        break;
      }
      case "cleanup.run.finished":
        if (run !== null) run.finishedAt = fact.createdAt;
        break;
      case "cleanup.run.interrupted":
        if (run !== null) run.interruptedAt = fact.createdAt;
        break;
      default:
        break;
    }
  }
  return run;
}

/** The transport-neutral cleanup command core. */
export function createOrphanCleanupEngine(ports: OrphanCleanupEnginePorts): OrphanCleanupEngine {
  const fact = (
    commandId: string,
    kind: OrphanCleanupFactKind,
    payload: unknown,
    createdAt: number,
  ): OrphanCleanupFact => ({ id: ports.nextId(), commandId, kind, payload, createdAt });

  async function recordReceipt(
    tx: OrphanCleanupLedgerTransaction,
    receipt: OrphanCleanupReceipt,
  ): Promise<void> {
    await tx.appendReceipt(receipt);
    await tx.appendFact(
      fact(receipt.commandId, "command.receipt.recorded", { receipt }, receipt.recordedAt),
    );
  }

  async function foldFor(
    tx: OrphanCleanupLedgerTransaction,
    commandId: string,
  ): Promise<OrphanCleanupRun | null> {
    return foldCleanupRun(await tx.listFacts(commandId));
  }

  async function latestReceipt(
    tx: OrphanCleanupLedgerTransaction,
    commandId: string,
  ): Promise<OrphanCleanupReceipt | null> {
    const receipts = await tx.listReceipts(commandId);
    return receipts.at(-1) ?? null;
  }

  /** Appends one fact to an already-accepted command; a stray command id is a no-op. */
  async function append(
    commandId: string,
    kind: OrphanCleanupFactKind,
    payload: unknown,
  ): Promise<void> {
    await ports.ledger.transaction(async (tx) => {
      const command = await tx.getCommand(commandId);
      if (command === null) return;
      await tx.appendFact(fact(commandId, kind, payload, ports.now()));
    });
  }

  return {
    async accept(input) {
      const intent: OrphanCleanupIntent = {
        kind: "orphan.cleanup",
        source: input.source,
        scanRevision: input.scanRevision,
        retentionDays: input.retentionDays,
        preservation: [...input.preservation],
        items: [...input.items],
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await tx.getCommand(input.commandId);
        if (existing !== null) {
          const receipt = (await latestReceipt(tx, input.commandId)) ?? {
            id: ports.nextId(),
            commandId: input.commandId,
            status: "rejected" as const,
            code: "conflict" as const,
            detail: "This command has no receipt.",
            recordedAt: ports.now(),
          };
          const run = await foldFor(tx, input.commandId);
          if (!sameIntent(existing.intent, intent)) {
            return {
              ok: false as const,
              code: "conflict" as const,
              error: "This cleanup id was already used for a different request.",
              receipt,
              run,
            };
          }
          // Same id, same intent: the first run IS the answer. Nothing is
          // re-executed, which is what makes a retry safe after a lost reply.
          if (run === null) {
            return {
              ok: false as const,
              code: "conflict" as const,
              error: "This cleanup id was already refused.",
              receipt,
              run: null,
            };
          }
          return { ok: true as const, run, receipt, replayed: true };
        }
        const now = ports.now();
        const command: OrphanCleanupCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendFact(fact(command.id, "command.recorded", { command }, now));
        // BEFORE any change: the accepted plan is durable first, so an app that
        // dies inside the first removal still knows what it set out to do.
        await tx.appendFact(fact(command.id, "cleanup.accepted", { intent }, now));
        const receipt: OrphanCleanupReceipt = {
          id: ports.nextId(),
          commandId: command.id,
          status: "accepted",
          code: null,
          detail: null,
          recordedAt: now,
        };
        await recordReceipt(tx, receipt);
        const run = await foldFor(tx, command.id);
        if (run === null) throw new Error("Accepted cleanup produced no run");
        return { ok: true as const, run, receipt, replayed: false };
      });
    },

    async reject(input) {
      return ports.ledger.transaction(async (tx) => {
        const existing = await tx.getCommand(input.commandId);
        const now = ports.now();
        if (existing === null) {
          const intent: OrphanCleanupIntent = {
            kind: "orphan.cleanup",
            source: "settings",
            scanRevision: input.scanRevision,
            retentionDays: 0,
            preservation: [],
            items: [],
          };
          const command: OrphanCleanupCommand = { id: input.commandId, intent, createdAt: now };
          await tx.insertCommand(command);
          await tx.appendFact(fact(command.id, "command.recorded", { command }, now));
        }
        await tx.appendFact(
          fact(input.commandId, "cleanup.rejected", { code: input.code, error: input.error }, now),
        );
        const receipt: OrphanCleanupReceipt = {
          id: ports.nextId(),
          commandId: input.commandId,
          status: "rejected",
          code: input.code,
          detail: input.error,
          recordedAt: now,
        };
        await recordReceipt(tx, receipt);
        return receipt;
      });
    },

    async beginItem(input) {
      await append(input.commandId, "cleanup.item.started", { itemId: input.itemId });
    },

    async settleItem(input) {
      await append(input.commandId, "cleanup.item.settled", {
        itemId: input.itemId,
        state: input.state,
        detail: input.detail,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
      });
    },

    async finish(input) {
      return ports.ledger.transaction(async (tx) => {
        const command = await tx.getCommand(input.commandId);
        if (command === null) throw new Error(`Unknown cleanup command ${input.commandId}`);
        const now = ports.now();
        await tx.appendFact(fact(input.commandId, "cleanup.run.finished", {}, now));
        const receipt: OrphanCleanupReceipt = {
          id: ports.nextId(),
          commandId: input.commandId,
          status: "completed",
          code: null,
          detail: null,
          recordedAt: now,
        };
        await recordReceipt(tx, receipt);
        const run = await foldFor(tx, input.commandId);
        if (run === null) throw new Error(`Cleanup command ${input.commandId} has no run`);
        return { run, receipt };
      });
    },

    async markInterrupted(input) {
      return ports.ledger.transaction(async (tx) => {
        const run = await foldFor(tx, input.commandId);
        if (run === null || run.finishedAt !== null || run.interruptedAt !== null) return run;
        await tx.appendFact(fact(input.commandId, "cleanup.run.interrupted", {}, ports.now()));
        return foldFor(tx, input.commandId);
      });
    },

    async run(commandId) {
      return ports.ledger.transaction((tx) => foldFor(tx, commandId));
    },

    async recentRuns(limit = RECENT_CLEANUP_RUNS) {
      return ports.ledger.transaction(async (tx) => {
        const runs: OrphanCleanupRun[] = [];
        for (const commandId of await tx.recentCommandIds(limit)) {
          const run = await foldFor(tx, commandId);
          if (run !== null) runs.push(run);
        }
        return runs;
      });
    },

    async openRuns(limit = RECENT_CLEANUP_RUNS) {
      const runs = await this.recentRuns(limit);
      return runs.filter((run) => run.finishedAt === null && run.interruptedAt === null);
    },
  };
}
