import { parseAutomationTrigger, sameAutomationRunRequestIdentity } from "@volli/shared";
import type {
  Automation,
  AutomationCommandReceipt,
  AutomationRun,
  AutomationRunRequestIdentity,
  AutomationSkippedOccurrence,
  AutomationSkipReason,
  AutomationTrigger,
  ColumnArming,
  ColumnAutomationOrder,
  ModelSelection,
  PromptResource,
  ResolvedAutomationModel,
  TicketStatus,
} from "@volli/shared";

/** A value a durable host may answer synchronously today or asynchronously later. */
type Awaitable<T> = T | Promise<T>;

export interface AutomationCommand {
  id: string;
  intent: AutomationCommandIntent;
  createdAt: number;
}

export type AutomationCommandIntent =
  | {
      kind: "automation.create";
      projectId: string | null;
      name: string;
      instructions: string;
      trigger: AutomationTrigger;
      runtime: ModelSelection | null;
    }
  | {
      kind: "automation.update";
      automationId: string;
      name: string;
      instructions: string;
      trigger: AutomationTrigger;
      runtime: ModelSelection | null;
    }
  | { kind: "automation.delete"; automationId: string }
  /**
   * Switching one Automation on or off ON THIS MACHINE.
   *
   * A durable command like every other product write (docs/BOUNDARIES.md rule
   * 5): it is user intent that changes whether an Automation fires, so it is
   * recorded, evented and receipted rather than poked into storage through a
   * raw channel. What is machine-local is the PROJECTION it writes — see
   * `enablement.ts`. This event names a host rather than the Automation, so a
   * future account-side record inherits the record's history and not this.
   */
  | { kind: "automation.set-enabled"; automationId: string; enabled: boolean }
  /**
   * Arming one column with one Automation, or disarming it (`automationId:
   * null`) — ON THIS MACHINE.
   *
   * The same shape as the switch above it, and for the same reason: this is
   * user intent that decides whether work starts without a person, so it is
   * recorded, evented and receipted rather than written straight into a table
   * behind a raw channel (docs/BOUNDARIES.md rule 5). What is machine-local is
   * the PROJECTION it writes — `automation_column_arming`, which never travels
   * with a project and is not part of the record that will one day move to an
   * account. One pattern, two switches: enablement says WHETHER an Automation
   * may fire on this machine, arming says WHICH column fires it.
   */
  | {
      kind: "automation.set-arming";
      projectId: string;
      status: TicketStatus;
      automationId: string | null;
    }
  /**
   * Arranging one column's Offered list — which Automation reads as digit `1`
   * when a card is dragged over it (VC-132), ON THIS MACHINE.
   *
   * The third switch under one pattern, and it is a command for the same reason
   * the two above it are (docs/BOUNDARIES.md rule 5): the rank decides which
   * Automation a *plain-looking* release aims at, so it is user intent about
   * what starts work, recorded, evented and receipted rather than poked into a
   * table. What is machine-local is the PROJECTION — `automation_column_order`,
   * which never travels with a project, because the digit it prints is pinned
   * by an arming that never travels either.
   */
  | {
      kind: "automation.set-column-order";
      projectId: string;
      status: TicketStatus;
      rankedAutomationIds: readonly string[];
    }
  /**
   * Recording a due time that passed without a Run (VC-130).
   *
   * A durable command like every other product write (docs/BOUNDARIES.md rule
   * 5), and it earns that shape twice over. It is a fact a surface lists, names
   * and acts on — "Run now" from the Run history — rather than the scheduler's
   * private bookkeeping; and its command id is DERIVED from the occurrence
   * (`<automationId>:skip:<dueAt>`), so a host that crashes between noticing a
   * gap and committing it records the same skip once on the next launch rather
   * than a second row for the same missed evening.
   *
   * What stays out of the ledger is the cursor that says how far this machine
   * has evaluated (`schedule-cursor.ts`): that is host-local operating state,
   * not a fact about the record.
   */
  | { kind: "automation.record-skip"; skip: AutomationSkipIntent }
  | { kind: "automation.run"; plan: AutomationRunPlan };

/** Everything a skip needs but its own id, which the core mints. */
export interface AutomationSkipIntent {
  automationId: string;
  automationName: string;
  projectId: string;
  /** The LATEST due time this gap covered. */
  dueAt: number;
  missedCount: number;
  reason: AutomationSkipReason;
}

/**
 * Every fact the Automation core writes. The SQLite adapter gives this an
 * immutable append-only home; nothing in the core knows which transport caused
 * the command.
 */
export interface AutomationEvent {
  id: string;
  commandId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
}

export interface StoredAutomationReceipt extends AutomationCommandReceipt {
  result: AutomationReceiptResult;
}

export type AutomationReceiptResult =
  | { kind: "automation.created"; automation: Automation }
  | { kind: "automation.updated"; automation: Automation }
  | { kind: "automation.deleted"; automationId: string }
  /** The whole new machine-local set, so a caller never reconstructs what it believes. */
  | {
      kind: "automation.enablement.set";
      automationId: string;
      enabled: boolean;
      enabledAutomationIds: string[];
    }
  /** The project's whole new arming set, whole for the reason the set above is. */
  | {
      kind: "automation.arming.set";
      projectId: string;
      status: TicketStatus;
      automationId: string | null;
      armings: ColumnArming[];
    }
  /** The project's whole new order set, whole for the reason the two above are. */
  | {
      kind: "automation.column-order.set";
      projectId: string;
      status: TicketStatus;
      rankedAutomationIds: string[];
      orders: ColumnAutomationOrder[];
    }
  | { kind: "automation.skip.recorded"; skip: AutomationSkippedOccurrence }
  | { kind: "automation.not-found"; automationId: string }
  | { kind: "automation.run.accepted"; plan: AutomationRunPlan }
  | { kind: "automation.run.completed"; run: AutomationRun }
  | { kind: "automation.run.rejected"; code: string; error: string };

/** The persisted work left after a Run command is accepted but before delivery. */
export interface AutomationRunPlan {
  /** Caller UUID that owns this accepted command and every recovery replay. */
  commandId: string;
  /** UUID minted with the accepted Run command. */
  runId: string;
  /**
   * The Automation this Run came from, or `null` for an Unbound Run — one that
   * carries its own Instructions and names no record (VC-112, "One-time work").
   * A plan written before VC-129 always names one, and reads unchanged: this is
   * a widened union, not a changed field.
   */
  automationId: string | null;
  /** That Automation's name at launch; `null` for the same reason as above. */
  automationName: string | null;
  projectId: string;
  /**
   * The Ticket this Run was requested on, or `null` when it named none.
   *
   * The Target, in the only spelling the Session layer has: `ticketId !== null`
   * IS the Role a Session is born under. A column Trigger and every by-hand Run
   * name a Ticket; a schedule names the Project (VC-112), so its plan carries
   * `null` and mints a Project Session. Widened rather than replaced by a
   * `target` union on purpose — this shape is stored in an append-only ledger,
   * and every plan written before VC-130 already spells its Ticket here.
   */
  ticketId: string | null;
  /**
   * The whole pin this Run starts under, or inherit — captured when the Run was
   * requested. It is the Automation's own Runtime unless the invocation
   * overrode it (VC-112's per-invocation override), and the plan deliberately
   * does not record which of the two it was: what a Run owes the future is the
   * model it RESOLVED, and that lands on the Run itself.
   */
  runtime: ModelSelection | null;
  /**
   * What the CALLER asked for, beside what this plan resolved (VC-129): an
   * Unbound Run's own Instructions, and this invocation's model override.
   *
   * The durable half of the retry identity. Neither is recoverable from the
   * fields around it — every Unbound Run has `automationId: null`, and
   * `runtime` is the RESOLVED pin, which an override and a record's own
   * Runtime can produce alike. Without it a second request under one command
   * id could carry different Instructions or a different model and still read
   * as a retry of the first.
   *
   * A plan written before VC-129 has no such field, and is read as the request
   * it was: a bound Run with no override (see {@link readRunPlan}).
   */
  request: AutomationRunRequestIdentity;
  /** The composer's expansion at request time, never re-expanded on recovery. */
  text: string;
  resources: readonly PromptResource[];
  /** Stable Session-create operation; replay mints the same fresh Session. */
  sessionOperationId: string;
  /** Stable Session message command and UI-message identities for replay. */
  messageCommandId: string;
  messageId: string;
}

/** A prior command's plan plus the Run projection when it already completed. */
export interface AutomationRunReplay {
  plan: AutomationRunPlan;
  run: AutomationRun | null;
}

/** The first-message intent, materialized with its Run before success returns. */
export interface AutomationRunDelivery {
  runId: string;
  sessionId: string;
  automationCommandId: string;
  messageCommandId: string;
  messageId: string;
  text: string;
  resources: readonly PromptResource[];
  createdAt: number;
  deliveredAt: number | null;
}

/** The storage port. It is intentionally free of Electron and SQLite types. */
export interface AutomationLedgerTransaction {
  getCommand(commandId: string): Awaitable<AutomationCommand | null>;
  insertCommand(command: AutomationCommand): Awaitable<void>;
  appendEvent(event: AutomationEvent): Awaitable<void>;
  listReceipts(commandId: string): Awaitable<readonly StoredAutomationReceipt[]>;
  appendReceipt(receipt: StoredAutomationReceipt): Awaitable<void>;

  getAutomation(automationId: string): Awaitable<Automation | null>;
  insertAutomation(automation: Automation): Awaitable<void>;
  updateAutomation(automation: Automation): Awaitable<void>;
  deleteAutomation(automationId: string): Awaitable<boolean>;

  /** The machine-local projection of "switched on here" — `enablement.ts` owns its storage. */
  enabledAutomationIds(): Awaitable<readonly string[]>;
  /** Replaces that set whole, inside the same transaction as the event that decided it. */
  putEnabledAutomationIds(ids: readonly string[], recordedAt: number): Awaitable<readonly string[]>;

  /** The other machine-local projection: which Automation each of a project's columns arms. */
  columnArmings(projectId: string): Awaitable<readonly ColumnArming[]>;
  /** And the third: the rank each of a project's columns gives its Offered list. */
  columnOrders(projectId: string): Awaitable<readonly ColumnAutomationOrder[]>;
  /**
   * Writes one column's rank and answers with the project's whole new set,
   * inside the same transaction as the event that decided it. An empty list is
   * "never arranged" and clears the row — see the repo's writer.
   */
  putColumnOrder(
    input: { projectId: string; status: TicketStatus; rankedAutomationIds: readonly string[] },
    recordedAt: number,
  ): Awaitable<readonly ColumnAutomationOrder[]>;
  /**
   * Arms one column, or disarms it with `automationId: null`, and answers with
   * the project's whole new set. Called inside the same transaction as the
   * event that decided it, so the row and the history of the row move together.
   */
  putColumnArming(
    input: { projectId: string; status: TicketStatus; automationId: string | null },
    recordedAt: number,
  ): Awaitable<readonly ColumnArming[]>;

  /** Records one Skipped occurrence, inside the transaction that evented it. */
  insertSkippedOccurrence(skip: AutomationSkippedOccurrence): Awaitable<void>;

  getRun(runId: string): Awaitable<AutomationRun | null>;
  insertRun(run: AutomationRun): Awaitable<void>;
  getDelivery(runId: string): Awaitable<AutomationRunDelivery | null>;
  insertDelivery(delivery: AutomationRunDelivery): Awaitable<void>;
  markDeliveryDelivered(runId: string, deliveredAt: number): Awaitable<void>;

  /** Every accepted Run not yet terminal, used to resume a crash window. */
  listRecoverableRunPlans(): Awaitable<readonly AutomationRunPlan[]>;
  /** Durable first-message intents not yet acknowledged by the Session runtime. */
  listPendingDeliveriesForSession(sessionId: string): Awaitable<readonly AutomationRunDelivery[]>;
  /** All pending first-message intents, used by process-start recovery. */
  listPendingDeliveries(): Awaitable<readonly AutomationRunDelivery[]>;
}

export interface AutomationLedger {
  transaction<T>(work: (transaction: AutomationLedgerTransaction) => Awaitable<T>): Promise<T>;
}

export interface AutomationEnginePorts {
  ledger: AutomationLedger;
  now(): number;
  /** Every persisted id this core mints is a UUID in the desktop composition. */
  nextId(): string;
}

export class AutomationEngineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationEngineConflictError";
  }
}

export type AutomationCommandOutcome<T> =
  | { ok: true; value: T; receipt: AutomationCommandReceipt; replayed?: true }
  | {
      ok: false;
      error: string;
      /** A Run's existing Session-start refusal, when this is a replay. */
      code?: string;
      receipt: AutomationCommandReceipt;
      replayed?: true;
    };

export interface AutomationEngine {
  create(input: {
    commandId: string;
    projectId: string | null;
    name: string;
    instructions: string;
    trigger: AutomationTrigger;
    runtime: ModelSelection | null;
  }): Promise<AutomationCommandOutcome<Automation>>;
  update(input: {
    commandId: string;
    automationId: string;
    name: string;
    instructions: string;
    trigger: AutomationTrigger;
    runtime: ModelSelection | null;
  }): Promise<AutomationCommandOutcome<Automation>>;
  delete(input: {
    commandId: string;
    automationId: string;
  }): Promise<AutomationCommandOutcome<void>>;
  /** Switches one Automation on or off on this machine; answers with the whole set. */
  setEnabled(input: {
    commandId: string;
    automationId: string;
    enabled: boolean;
  }): Promise<AutomationCommandOutcome<string[]>>;
  /** That set, read back — the machine-local projection, never a record field. */
  enabledAutomationIds(): Promise<string[]>;
  /** Arms one column with one Automation, or disarms it; answers with the project's whole set. */
  setColumnArming(input: {
    commandId: string;
    projectId: string;
    status: TicketStatus;
    automationId: string | null;
  }): Promise<AutomationCommandOutcome<ColumnArming[]>>;
  /** Every armed column in one project — the machine-local projection, read back. */
  columnArmings(projectId: string): Promise<ColumnArming[]>;
  /** Arranges one column's Offered list; answers with the project's whole set. */
  setColumnOrder(input: {
    commandId: string;
    projectId: string;
    status: TicketStatus;
    rankedAutomationIds: readonly string[];
  }): Promise<AutomationCommandOutcome<ColumnAutomationOrder[]>>;
  /** Every arranged column in one project — the machine-local projection, read back. */
  columnOrders(projectId: string): Promise<ColumnAutomationOrder[]>;
  /**
   * Records a due time that passed without a Run (VC-130). Idempotent on the
   * caller's command id, which the scheduler derives from the occurrence — so
   * the same missed evening cannot be recorded twice.
   */
  recordSkip(input: {
    commandId: string;
    skip: AutomationSkipIntent;
  }): Promise<AutomationCommandOutcome<AutomationSkippedOccurrence>>;
  acceptRun(input: {
    commandId: string;
    /** The Automation being run, or `null` for an Unbound Run. */
    automation: Pick<Automation, "id" | "name"> | null;
    /** The resolved Runtime for this invocation — an override, a pin, or inherit. */
    runtime: ModelSelection | null;
    /** What the caller asked for, which is what a retry is compared against. */
    request: AutomationRunRequestIdentity;
    projectId: string;
    /** `null` targets the Project, which is what a schedule Run does. */
    ticketId: string | null;
    text: string;
    resources: readonly PromptResource[];
  }): Promise<AutomationCommandOutcome<AutomationRunPlan>>;
  completeRun(input: {
    commandId: string;
    sessionId: string;
    model: ResolvedAutomationModel;
  }): Promise<AutomationCommandOutcome<AutomationRun>>;
  rejectRun(input: {
    commandId: string;
    code: string;
    error: string;
  }): Promise<AutomationCommandOutcome<void>>;
  /** Whether any durable command already owns this retry identity. */
  hasCommand(commandId: string): Promise<boolean>;
  /** Existing run intent, so a retry bypasses a live-Run guard and replays safely. */
  runPlan(commandId: string): Promise<AutomationRunPlan | null>;
  /** The accepted/completed/rejected receipt for a prior Run command, if any. */
  replayRun(commandId: string): Promise<AutomationCommandOutcome<AutomationRunReplay> | null>;
  recoverableRunPlans(): Promise<readonly AutomationRunPlan[]>;
  pendingDeliveriesForSession(sessionId: string): Promise<readonly AutomationRunDelivery[]>;
  pendingDeliveries(): Promise<readonly AutomationRunDelivery[]>;
  markDeliveryDelivered(input: { runId: string }): Promise<void>;
}

/**
 * The transport-neutral Automation command/event/projection core.
 *
 * It deliberately does not create Sessions or talk to a renderer. A host first
 * accepts a Run plan here, then performs the external Session mint, and finally
 * completes the Run here. If it crashes between those steps the persisted plan
 * has stable operation/message ids, so recovery can repeat every edge without
 * duplicating a Session or losing the first message.
 */
export function createAutomationEngine(ports: AutomationEnginePorts): AutomationEngine {
  const event = (
    commandId: string,
    kind: string,
    payload: unknown,
    createdAt: number,
  ): AutomationEvent => ({
    id: ports.nextId(),
    commandId,
    kind,
    payload,
    createdAt,
  });
  const receipt = (
    commandId: string,
    status: AutomationCommandReceipt["status"],
    result: AutomationReceiptResult,
    recordedAt: number,
  ): StoredAutomationReceipt => ({
    id: ports.nextId(),
    commandId,
    status,
    result,
    recordedAt,
  });
  async function recordReceipt(
    tx: AutomationLedgerTransaction,
    stored: StoredAutomationReceipt,
  ): Promise<void> {
    await tx.appendReceipt(stored);
    await tx.appendEvent(
      event(stored.commandId, "command.receipt.recorded", { receipt: stored }, stored.recordedAt),
    );
  }

  async function existingCommand(
    tx: AutomationLedgerTransaction,
    commandId: string,
    intent: AutomationCommandIntent,
  ): Promise<AutomationCommand | null> {
    const existing = await tx.getCommand(commandId);
    if (existing === null) return null;
    if (!sameJson(readIntent(existing.intent), readIntent(intent))) {
      throw new AutomationEngineConflictError(
        `Automation command ${commandId} was already accepted with different intent`,
      );
    }
    return existing;
  }

  async function replay<T>(
    tx: AutomationLedgerTransaction,
    commandId: string,
    expected: AutomationReceiptResult["kind"],
    select: (result: AutomationReceiptResult) => T | null,
  ): Promise<AutomationCommandOutcome<T>> {
    const receipts = await tx.listReceipts(commandId);
    const latest = receipts.at(-1);
    if (latest === undefined) {
      throw new AutomationEngineConflictError(
        `Automation command ${commandId} has no durable receipt`,
      );
    }
    const value = select(readResult(latest.result));
    if (value !== null) return { ok: true, value, receipt: publicReceipt(latest), replayed: true };
    if (latest.result.kind === "automation.not-found") {
      return {
        ok: false,
        error: "Unknown automation",
        receipt: publicReceipt(latest),
        replayed: true,
      };
    }
    if (latest.result.kind === "automation.run.rejected") {
      return {
        ok: false,
        code: latest.result.code,
        error: latest.result.error,
        receipt: publicReceipt(latest),
        replayed: true,
      };
    }
    throw new AutomationEngineConflictError(
      `Automation command ${commandId} has ${latest.result.kind}, expected ${expected}`,
    );
  }

  return {
    async create(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.create",
        projectId: input.projectId,
        name: input.name,
        instructions: input.instructions,
        trigger: input.trigger,
        runtime: input.runtime,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.created", (result) =>
            result.kind === "automation.created" ? result.automation : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        const automation: Automation = {
          id: ports.nextId(),
          projectId: input.projectId,
          name: input.name,
          instructions: input.instructions,
          trigger: input.trigger,
          runtime: input.runtime,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        await tx.appendEvent(event(command.id, "automation.created", { automation }, now));
        await tx.insertAutomation(automation);
        const completed = receipt(
          command.id,
          "completed",
          { kind: "automation.created", automation },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: automation, receipt: publicReceipt(completed) };
      });
    },

    async update(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.update",
        automationId: input.automationId,
        name: input.name,
        instructions: input.instructions,
        trigger: input.trigger,
        runtime: input.runtime,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.updated", (result) =>
            result.kind === "automation.updated" ? result.automation : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        const prior = await tx.getAutomation(input.automationId);
        if (prior === null) {
          const rejected = receipt(
            command.id,
            "rejected",
            { kind: "automation.not-found", automationId: input.automationId },
            now,
          );
          await recordReceipt(tx, rejected);
          return { ok: false, error: "Unknown automation", receipt: publicReceipt(rejected) };
        }
        const automation: Automation = {
          ...prior,
          name: input.name,
          instructions: input.instructions,
          trigger: input.trigger,
          runtime: input.runtime,
          updatedAt: now,
        };
        await tx.appendEvent(event(command.id, "automation.updated", { automation }, now));
        await tx.updateAutomation(automation);
        const completed = receipt(
          command.id,
          "completed",
          { kind: "automation.updated", automation },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: automation, receipt: publicReceipt(completed) };
      });
    },

    async delete(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.delete",
        automationId: input.automationId,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.deleted", (result) =>
            result.kind === "automation.deleted" ? undefined : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        const prior = await tx.getAutomation(input.automationId);
        if (prior === null) {
          const rejected = receipt(
            command.id,
            "rejected",
            { kind: "automation.not-found", automationId: input.automationId },
            now,
          );
          await recordReceipt(tx, rejected);
          return { ok: false, error: "Unknown automation", receipt: publicReceipt(rejected) };
        }
        await tx.appendEvent(
          event(command.id, "automation.deleted", { automationId: input.automationId }, now),
        );
        const deleted = await tx.deleteAutomation(input.automationId);
        if (!deleted) {
          throw new AutomationEngineConflictError(
            `Automation ${input.automationId} disappeared while deleting`,
          );
        }
        const completed = receipt(
          command.id,
          "completed",
          { kind: "automation.deleted", automationId: input.automationId },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: undefined, receipt: publicReceipt(completed) };
      });
    },

    async setEnabled(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.set-enabled",
        automationId: input.automationId,
        enabled: input.enabled,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.enablement.set", (result) =>
            result.kind === "automation.enablement.set" ? result.enabledAutomationIds : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        // The switch names a record, so a record that is gone cannot hold one:
        // the same refusal update and delete give, with the same receipt to
        // replay. It also keeps the stored set from collecting ids for
        // Automations nothing lists.
        const target = await tx.getAutomation(input.automationId);
        if (target === null) {
          const rejected = receipt(
            command.id,
            "rejected",
            { kind: "automation.not-found", automationId: input.automationId },
            now,
          );
          await recordReceipt(tx, rejected);
          return { ok: false, error: "Unknown automation", receipt: publicReceipt(rejected) };
        }
        const current = new Set(await tx.enabledAutomationIds());
        if (input.enabled) current.add(input.automationId);
        else current.delete(input.automationId);
        const enabledAutomationIds = [...current].toSorted();
        await tx.appendEvent(
          event(
            command.id,
            "automation.enablement.changed",
            { automationId: input.automationId, enabled: input.enabled, enabledAutomationIds },
            now,
          ),
        );
        await tx.putEnabledAutomationIds(enabledAutomationIds, now);
        const completed = receipt(
          command.id,
          "completed",
          {
            kind: "automation.enablement.set",
            automationId: input.automationId,
            enabled: input.enabled,
            enabledAutomationIds,
          },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: enabledAutomationIds, receipt: publicReceipt(completed) };
      });
    },

    async enabledAutomationIds() {
      return ports.ledger.transaction(async (tx) => [...(await tx.enabledAutomationIds())]);
    },

    async setColumnArming(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.set-arming",
        projectId: input.projectId,
        status: input.status,
        automationId: input.automationId,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.arming.set", (result) =>
            result.kind === "automation.arming.set" ? result.armings : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        // Arming names a record, so a record that is gone cannot be armed: the
        // same refusal and the same replayable receipt the switch gives. A
        // disarm names none and therefore skips this — emptying a column is
        // valid however little is left to point at.
        if (input.automationId !== null) {
          const target = await tx.getAutomation(input.automationId);
          if (target === null) {
            const rejected = receipt(
              command.id,
              "rejected",
              { kind: "automation.not-found", automationId: input.automationId },
              now,
            );
            await recordReceipt(tx, rejected);
            return { ok: false, error: "Unknown automation", receipt: publicReceipt(rejected) };
          }
        }
        // The projection's own answer is what both the event and the receipt
        // quote. Writing it first inside this transaction (rather than deriving
        // the new set in memory and evented it ahead of the row) means the
        // history and the row can never disagree about what a column arms: they
        // are the same value, and one COMMIT decides whether both happened.
        const armings = [
          ...(await tx.putColumnArming(
            {
              projectId: input.projectId,
              status: input.status,
              automationId: input.automationId,
            },
            now,
          )),
        ];
        await tx.appendEvent(
          event(
            command.id,
            "automation.arming.changed",
            {
              projectId: input.projectId,
              status: input.status,
              automationId: input.automationId,
              armings,
            },
            now,
          ),
        );
        const completed = receipt(
          command.id,
          "completed",
          {
            kind: "automation.arming.set",
            projectId: input.projectId,
            status: input.status,
            automationId: input.automationId,
            armings,
          },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: armings, receipt: publicReceipt(completed) };
      });
    },

    async columnArmings(projectId) {
      return ports.ledger.transaction(async (tx) => [...(await tx.columnArmings(projectId))]);
    },

    async setColumnOrder(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.set-column-order",
        projectId: input.projectId,
        status: input.status,
        rankedAutomationIds: input.rankedAutomationIds,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.column-order.set", (result) =>
            result.kind === "automation.column-order.set" ? result.orders : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        // No record guard, unlike arming: a rank is a LIST and it is
        // stale-tolerant by construction — an id naming an Automation this
        // column no longer offers is filtered out on every read
        // (`offeredAutomationsForColumn`). Refusing the whole arrangement
        // because one id in it went stale would make a lane un-arrangeable
        // until someone found the row that had moved.
        const orders = [
          ...(await tx.putColumnOrder(
            {
              projectId: input.projectId,
              status: input.status,
              rankedAutomationIds: input.rankedAutomationIds,
            },
            now,
          )),
        ];
        const rankedAutomationIds = [...input.rankedAutomationIds];
        // The projection's own answer is what both the event and the receipt
        // quote, exactly as the arming's does: one COMMIT decides whether the
        // row and the history of the row both happened.
        await tx.appendEvent(
          event(
            command.id,
            "automation.column-order.changed",
            {
              projectId: input.projectId,
              status: input.status,
              rankedAutomationIds,
              orders,
            },
            now,
          ),
        );
        const completed = receipt(
          command.id,
          "completed",
          {
            kind: "automation.column-order.set",
            projectId: input.projectId,
            status: input.status,
            rankedAutomationIds,
            orders,
          },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: orders, receipt: publicReceipt(completed) };
      });
    },

    async columnOrders(projectId) {
      return ports.ledger.transaction(async (tx) => [...(await tx.columnOrders(projectId))]);
    },

    async recordSkip(input) {
      const intent: AutomationCommandIntent = {
        kind: "automation.record-skip",
        skip: input.skip,
      };
      return ports.ledger.transaction(async (tx) => {
        const existing = await existingCommand(tx, input.commandId, intent);
        if (existing !== null) {
          return replay(tx, input.commandId, "automation.skip.recorded", (result) =>
            result.kind === "automation.skip.recorded" ? result.skip : null,
          );
        }
        const now = ports.now();
        const command: AutomationCommand = { id: input.commandId, intent, createdAt: now };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        // A skip names a record, so a record that is gone cannot have missed
        // anything: the same refusal and the same replayable receipt every other
        // write gives. It also keeps the projection's foreign key satisfiable —
        // a skip offers "Run now", and there would be nothing left to run.
        const target = await tx.getAutomation(input.skip.automationId);
        if (target === null) {
          const rejected = receipt(
            command.id,
            "rejected",
            { kind: "automation.not-found", automationId: input.skip.automationId },
            now,
          );
          await recordReceipt(tx, rejected);
          return { ok: false, error: "Unknown automation", receipt: publicReceipt(rejected) };
        }
        const skip: AutomationSkippedOccurrence = {
          id: ports.nextId(),
          automationId: input.skip.automationId,
          automationName: input.skip.automationName,
          projectId: input.skip.projectId,
          dueAt: input.skip.dueAt,
          missedCount: input.skip.missedCount,
          reason: input.skip.reason,
          recordedAt: now,
        };
        await tx.appendEvent(event(command.id, "automation.skip.recorded", { skip }, now));
        await tx.insertSkippedOccurrence(skip);
        const completed = receipt(
          command.id,
          "completed",
          { kind: "automation.skip.recorded", skip },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: skip, receipt: publicReceipt(completed) };
      });
    },

    async acceptRun(input) {
      // One spelling of the plan for both the in-flight rejection below and the
      // accepted path under it: two constructions of the same durable record is
      // how a field added to one of them quietly goes missing from the other.
      const draftPlan = (): AutomationRunPlan => ({
        commandId: input.commandId,
        runId: ports.nextId(),
        automationId: input.automation?.id ?? null,
        automationName: input.automation?.name ?? null,
        projectId: input.projectId,
        ticketId: input.ticketId,
        runtime: input.runtime,
        request: input.request,
        text: input.text,
        resources: input.resources,
        sessionOperationId: ports.nextId(),
        messageCommandId: ports.nextId(),
        messageId: ports.nextId(),
      });
      return ports.ledger.transaction(async (tx) => {
        // First find a replay by command id. It must outrank the Ticket guard:
        // a network retry of the accepted Run is the same Run, not a second
        // contender that happens to see itself in flight.
        const existing = await tx.getCommand(input.commandId);
        if (existing !== null) {
          if (existing.intent.kind !== "automation.run") {
            throw new AutomationEngineConflictError(
              `Automation command ${input.commandId} was already used for ${existing.intent.kind}`,
            );
          }
          const plan = readRunPlan(existing.intent.plan);
          if (
            plan.automationId !== (input.automation?.id ?? null) ||
            plan.automationName !== (input.automation?.name ?? null) ||
            plan.projectId !== input.projectId ||
            plan.ticketId !== input.ticketId ||
            !sameJson(plan.runtime, input.runtime) ||
            !sameAutomationRunRequestIdentity(plan.request, input.request) ||
            plan.text !== input.text ||
            !sameJson(plan.resources, input.resources)
          ) {
            throw new AutomationEngineConflictError(
              `Automation command ${input.commandId} was already accepted with different intent`,
            );
          }
          const latest = (await tx.listReceipts(input.commandId)).at(-1);
          if (latest === undefined) {
            throw new AutomationEngineConflictError(
              `Automation Run command ${input.commandId} has no durable receipt`,
            );
          }
          if (latest.result.kind === "automation.run.rejected") {
            return {
              ok: false,
              code: latest.result.code,
              error: latest.result.error,
              receipt: publicReceipt(latest),
              replayed: true,
            };
          }
          if (
            latest.result.kind !== "automation.run.accepted" &&
            latest.result.kind !== "automation.run.completed"
          ) {
            throw new AutomationEngineConflictError(
              `Automation Run command ${input.commandId} has ${latest.result.kind}`,
            );
          }
          return { ok: true, value: plan, receipt: publicReceipt(latest), replayed: true };
        }
        const pending = await tx.listRecoverableRunPlans();
        if (pending.some((plan) => sameRunTarget(plan, input))) {
          const now = ports.now();
          const plan = draftPlan();
          const command: AutomationCommand = {
            id: input.commandId,
            intent: { kind: "automation.run", plan },
            createdAt: now,
          };
          await tx.insertCommand(command);
          await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
          const rejected = receipt(
            command.id,
            "rejected",
            {
              kind: "automation.run.rejected",
              code: "RUN_IN_FLIGHT",
              error: "A Run is already starting on this Ticket.",
            },
            now,
          );
          await recordReceipt(tx, rejected);
          return {
            ok: false,
            code: "RUN_IN_FLIGHT",
            error: "A Run is already starting on this Ticket.",
            receipt: publicReceipt(rejected),
          };
        }

        const now = ports.now();
        const plan = draftPlan();
        const command: AutomationCommand = {
          id: input.commandId,
          intent: { kind: "automation.run", plan },
          createdAt: now,
        };
        await tx.insertCommand(command);
        await tx.appendEvent(event(command.id, "command.recorded", { command }, now));
        await tx.appendEvent(event(command.id, "automation.run.accepted", { plan }, now));
        const accepted = receipt(
          command.id,
          "accepted",
          { kind: "automation.run.accepted", plan },
          now,
        );
        await recordReceipt(tx, accepted);
        return { ok: true, value: plan, receipt: publicReceipt(accepted) };
      });
    },

    async completeRun(input) {
      return ports.ledger.transaction(async (tx) => {
        const command = await tx.getCommand(input.commandId);
        if (command === null || command.intent.kind !== "automation.run") {
          throw new AutomationEngineConflictError(
            `Automation Run command ${input.commandId} was not accepted`,
          );
        }
        const plan = readRunPlan(command.intent.plan);
        const existing = await tx.getRun(plan.runId);
        if (existing !== null) {
          if (
            existing.sessionId !== input.sessionId ||
            existing.model.providerId !== input.model.providerId ||
            existing.model.modelId !== input.model.modelId ||
            existing.model.reasoningLevel !== input.model.reasoningLevel
          ) {
            throw new AutomationEngineConflictError(
              `Automation Run ${plan.runId} was already completed with different Session evidence`,
            );
          }
          const replayed = await replay(tx, command.id, "automation.run.completed", (result) =>
            result.kind === "automation.run.completed" ? result.run : null,
          );
          return replayed;
        }
        const receipts = await tx.listReceipts(command.id);
        const terminal = terminalReceipt(receipts);
        if (terminal?.result.kind === "automation.run.rejected") {
          return {
            ok: false,
            code: terminal.result.code,
            error: terminal.result.error,
            receipt: publicReceipt(terminal),
          };
        }
        const now = ports.now();
        const run: AutomationRun = {
          id: plan.runId,
          automationId: plan.automationId,
          automationName: plan.automationName,
          ticketId: plan.ticketId,
          sessionId: input.sessionId,
          model: input.model,
          createdAt: now,
        };
        const delivery: AutomationRunDelivery = {
          runId: run.id,
          sessionId: run.sessionId,
          automationCommandId: command.id,
          messageCommandId: plan.messageCommandId,
          messageId: plan.messageId,
          text: plan.text,
          resources: plan.resources,
          createdAt: now,
          deliveredAt: null,
        };
        await tx.appendEvent(event(command.id, "automation.run.completed", { run, delivery }, now));
        await tx.insertRun(run);
        await tx.insertDelivery(delivery);
        const completed = receipt(
          command.id,
          "completed",
          { kind: "automation.run.completed", run },
          now,
        );
        await recordReceipt(tx, completed);
        return { ok: true, value: run, receipt: publicReceipt(completed) };
      });
    },

    async rejectRun(input) {
      return ports.ledger.transaction(async (tx) => {
        const command = await tx.getCommand(input.commandId);
        if (command === null || command.intent.kind !== "automation.run") {
          throw new AutomationEngineConflictError(
            `Automation Run command ${input.commandId} was not accepted`,
          );
        }
        const receipts = await tx.listReceipts(command.id);
        const terminal = terminalReceipt(receipts);
        if (terminal !== null) {
          if (terminal.result.kind === "automation.run.rejected") {
            if (terminal.result.code !== input.code || terminal.result.error !== input.error) {
              throw new AutomationEngineConflictError(
                `Automation Run ${command.id} was already rejected differently`,
              );
            }
            return {
              ok: false,
              code: terminal.result.code,
              error: terminal.result.error,
              receipt: publicReceipt(terminal),
              replayed: true,
            };
          }
          throw new AutomationEngineConflictError(
            `Automation Run ${command.id} is already completed`,
          );
        }
        const now = ports.now();
        await tx.appendEvent(
          event(
            command.id,
            "automation.run.rejected",
            { code: input.code, error: input.error },
            now,
          ),
        );
        const rejected = receipt(
          command.id,
          "rejected",
          { kind: "automation.run.rejected", code: input.code, error: input.error },
          now,
        );
        await recordReceipt(tx, rejected);
        return {
          ok: false,
          code: input.code,
          error: input.error,
          receipt: publicReceipt(rejected),
        };
      });
    },

    async hasCommand(commandId) {
      return ports.ledger.transaction(async (tx) => (await tx.getCommand(commandId)) !== null);
    },

    async runPlan(commandId) {
      return ports.ledger.transaction(async (tx) => {
        const command = await tx.getCommand(commandId);
        if (command === null) return null;
        if (command.intent.kind !== "automation.run") {
          throw new AutomationEngineConflictError(
            `Automation command ${commandId} was already used for ${command.intent.kind}`,
          );
        }
        return readRunPlan(command.intent.plan);
      });
    },

    async replayRun(commandId) {
      return ports.ledger.transaction(async (tx) => {
        const command = await tx.getCommand(commandId);
        if (command === null) return null;
        if (command.intent.kind !== "automation.run") {
          throw new AutomationEngineConflictError(
            `Automation command ${commandId} was already used for ${command.intent.kind}`,
          );
        }
        const latest = (await tx.listReceipts(command.id)).at(-1);
        if (latest === undefined) {
          throw new AutomationEngineConflictError(
            `Automation Run command ${command.id} has no durable receipt`,
          );
        }
        switch (latest.result.kind) {
          case "automation.run.accepted":
            return {
              ok: true,
              value: { plan: readRunPlan(command.intent.plan), run: null },
              receipt: publicReceipt(latest),
              replayed: true,
            };
          case "automation.run.completed":
            return {
              ok: true,
              value: { plan: readRunPlan(command.intent.plan), run: latest.result.run },
              receipt: publicReceipt(latest),
              replayed: true,
            };
          case "automation.run.rejected":
            return {
              ok: false,
              code: latest.result.code,
              error: latest.result.error,
              receipt: publicReceipt(latest),
              replayed: true,
            };
          default:
            throw new AutomationEngineConflictError(
              `Automation Run command ${command.id} has ${latest.result.kind}`,
            );
        }
      });
    },

    async recoverableRunPlans() {
      return ports.ledger.transaction(async (tx) =>
        (await tx.listRecoverableRunPlans()).map(readRunPlan),
      );
    },

    async pendingDeliveriesForSession(sessionId) {
      return ports.ledger.transaction((tx) => tx.listPendingDeliveriesForSession(sessionId));
    },

    async pendingDeliveries() {
      return ports.ledger.transaction((tx) => tx.listPendingDeliveries());
    },

    async markDeliveryDelivered(input) {
      await ports.ledger.transaction(async (tx) => {
        const delivery = await tx.getDelivery(input.runId);
        if (delivery === null || delivery.deliveredAt !== null) return;
        const now = ports.now();
        await tx.appendEvent(
          event(
            delivery.automationCommandId,
            "automation.run.instructions-delivered",
            { runId: input.runId, sessionId: delivery.sessionId },
            now,
          ),
        );
        await tx.markDeliveryDelivered(input.runId, now);
      });
    },
  };
}

/**
 * Whether an accepted plan and a new request are Runs at the SAME target — the
 * question behind `RUN_IN_FLIGHT`.
 *
 * A Ticket answers it by itself: VC-112 rules that a Ticket has at most one Run
 * in flight, whichever Automation started it. A Run that names no Ticket has no
 * such subject, so it asks the nearest true question instead — the same
 * schedule, in the same project — which keeps one daily sweep from stacking on
 * itself while leaving two different schedules free to fire in the same minute.
 * Written as one predicate because the alternative is two guards that drift.
 */
function sameRunTarget(
  plan: Pick<AutomationRunPlan, "ticketId" | "projectId" | "automationId">,
  next: {
    ticketId: string | null;
    projectId: string;
    /** `null` for an Unbound Run (VC-129), which always names a Ticket. */
    automation: Pick<Automation, "id"> | null;
  },
): boolean {
  if (next.ticketId !== null) return plan.ticketId === next.ticketId;
  // A Run with no Ticket competes with itself in one project (VC-130): the
  // schedule is the subject, so the record it names is part of the identity.
  return (
    plan.ticketId === null &&
    plan.projectId === next.projectId &&
    plan.automationId === (next.automation?.id ?? null)
  );
}

function publicReceipt(stored: StoredAutomationReceipt): AutomationCommandReceipt {
  return {
    id: stored.id,
    commandId: stored.commandId,
    status: stored.status,
    recordedAt: stored.recordedAt,
  };
}

function terminalReceipt(
  receipts: readonly StoredAutomationReceipt[],
): StoredAutomationReceipt | null {
  return receipts.toReversed().find((receipt) => receipt.status !== "accepted") ?? null;
}

/**
 * A stored intent, read in TODAY's vocabulary.
 *
 * The ledger is append-only and older than the Trigger (VC-128): a create or
 * update written before it carries no `trigger` field at all. Two things go
 * wrong if such a row is read literally, and both are upgrade-day bugs rather
 * than theory — the first retry after the upgrade is what hits them.
 *
 *  - **The retry conflicts instead of replaying.** {@link existingCommand}
 *    compares intents exactly, so `{name, instructions, runtime}` and
 *    `{name, instructions, trigger: none, runtime}` read as two different
 *    intents and the caller is told its own command was already accepted with
 *    a different one. Normalizing on READ makes the comparison about what the
 *    intent MEANT: an absent Trigger meant "Nothing else", which is exactly
 *    what {@link parseAutomationTrigger} answers for it.
 *  - **Both sides go through it**, because the point is meaning, not spelling:
 *    a caller re-sending a non-canonical Trigger (unsorted columns, a
 *    duplicate) is re-sending the same intent, and the record already stored
 *    the canonical form of it.
 *
 * Every other intent kind is returned untouched — none of them has ever had a
 * field added, and a normalizer that guessed at future ones would be inventing
 * history rather than reading it.
 */
function readIntent(intent: AutomationCommandIntent): AutomationCommandIntent {
  if (intent.kind === "automation.run") return { ...intent, plan: readRunPlan(intent.plan) };
  if (intent.kind !== "automation.create" && intent.kind !== "automation.update") return intent;
  return { ...intent, trigger: parseAutomationTrigger(intent.trigger) };
}

/**
 * A stored Run plan, read in TODAY's vocabulary — the same rule
 * {@link readIntent} states for the Trigger, applied to the field VC-129 added.
 *
 * The ledger is append-only and older than the Unbound Run: a plan written
 * before VC-129 carries no `request` at all. Every plan of that age was a bound
 * Run started from a record, with no per-invocation override to spend — that is
 * not a guess, it is the only Run the code of the time could accept — so it is
 * read as the request it was. Reading it literally would instead compare a
 * retry against `undefined` and refuse the caller's own command as a different
 * one, which is exactly the upgrade-day bug the Trigger normalizer exists to
 * avoid.
 *
 * A plan is never written back through this: normalization is about how an old
 * row is UNDERSTOOD, and the row itself stays whatever it was recorded as.
 */
function readRunPlan(plan: AutomationRunPlan): AutomationRunPlan {
  const request: AutomationRunRequestIdentity | undefined = plan.request;
  if (request !== undefined) return plan;
  return { ...plan, request: { instructions: null, modelOverride: null } };
}

/**
 * A stored receipt result, read in the same vocabulary as {@link readIntent}.
 *
 * A successful create/update receipt carries the whole {@link Automation} it
 * wrote, so a receipt older than the Trigger holds a record with no `trigger`
 * field. Replaying it verbatim would answer a caller with an Automation that
 * is missing a required part of the type — a shape no live write can produce
 * and no reader is prepared for. The degrade direction is the shared parser's,
 * stated once in `automation.ts`: an unreadable or absent Trigger becomes
 * "Nothing else", which only ever stops something from starting on its own.
 *
 * The projection tables are already read this way (`automations-repo.ts`), so
 * this is the receipt half of one rule, not a second policy.
 */
function readResult(result: AutomationReceiptResult): AutomationReceiptResult {
  if (result.kind !== "automation.created" && result.kind !== "automation.updated") return result;
  return {
    ...result,
    automation: {
      ...result.automation,
      trigger: parseAutomationTrigger(result.automation.trigger),
    },
  };
}

/** Stable structural comparison for an idempotency key's immutable intent. */
function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
