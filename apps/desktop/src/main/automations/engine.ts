import type {
  Automation,
  AutomationCommandReceipt,
  AutomationRun,
  AutomationTrigger,
  ModelSelection,
  PromptResource,
  ResolvedAutomationModel,
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
  | { kind: "automation.run"; plan: AutomationRunPlan };

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
  ticketId: string;
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
  acceptRun(input: {
    commandId: string;
    automation: Pick<Automation, "id" | "name"> & { runtime: ModelSelection | null };
    projectId: string;
    ticketId: string;
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
    if (!sameJson(existing.intent, intent)) {
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
    const value = select(latest.result);
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
        if (pending.some((plan) => plan.ticketId === input.ticketId)) {
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
