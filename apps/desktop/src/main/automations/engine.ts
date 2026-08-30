import { parseAutomationTrigger } from "@volli/shared";
import type {
  Automation,
  AutomationCommandReceipt,
  AutomationRun,
  AutomationSkippedOccurrence,
  AutomationSkipReason,
  AutomationTrigger,
  ColumnArming,
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
  automationId: string;
  automationName: string;
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
  /** A whole pin or inherit, captured when the Run was requested. */
  runtime: ModelSelection | null;
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
    automation: Pick<Automation, "id" | "name"> & { runtime: ModelSelection | null };
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
          const plan = existing.intent.plan;
          if (
            plan.automationId !== input.automation.id ||
            plan.automationName !== input.automation.name ||
            plan.projectId !== input.projectId ||
            plan.ticketId !== input.ticketId ||
            !sameJson(plan.runtime, input.automation.runtime) ||
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
          const plan: AutomationRunPlan = {
            commandId: input.commandId,
            runId: ports.nextId(),
            automationId: input.automation.id,
            automationName: input.automation.name,
            projectId: input.projectId,
            ticketId: input.ticketId,
            runtime: input.automation.runtime,
            text: input.text,
            resources: input.resources,
            sessionOperationId: ports.nextId(),
            messageCommandId: ports.nextId(),
            messageId: ports.nextId(),
          };
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
        const plan: AutomationRunPlan = {
          commandId: input.commandId,
          runId: ports.nextId(),
          automationId: input.automation.id,
          automationName: input.automation.name,
          projectId: input.projectId,
          ticketId: input.ticketId,
          runtime: input.automation.runtime,
          text: input.text,
          resources: input.resources,
          sessionOperationId: ports.nextId(),
          messageCommandId: ports.nextId(),
          messageId: ports.nextId(),
        };
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
        const { plan } = command.intent;
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
        return command.intent.plan;
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
              value: { plan: command.intent.plan, run: null },
              receipt: publicReceipt(latest),
              replayed: true,
            };
          case "automation.run.completed":
            return {
              ok: true,
              value: { plan: command.intent.plan, run: latest.result.run },
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
      return ports.ledger.transaction((tx) => tx.listRecoverableRunPlans());
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
  next: { ticketId: string | null; projectId: string; automation: Pick<Automation, "id"> },
): boolean {
  if (next.ticketId !== null) return plan.ticketId === next.ticketId;
  return (
    plan.ticketId === null &&
    plan.projectId === next.projectId &&
    plan.automationId === next.automation.id
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
  if (intent.kind !== "automation.create" && intent.kind !== "automation.update") return intent;
  return { ...intent, trigger: parseAutomationTrigger(intent.trigger) };
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
