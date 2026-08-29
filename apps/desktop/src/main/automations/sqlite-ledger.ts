import type Database from "better-sqlite3";
import { isAutomationRuntimePin } from "@volli/shared";
import type { Automation, AutomationRun, PromptResource } from "@volli/shared";

import { getAutomation, getAutomationRun, triggerColumnValue } from "../db/automations-repo";
import { prepared } from "../db/prepared";
import type {
  AutomationCommand,
  AutomationEvent,
  AutomationLedger,
  AutomationLedgerTransaction,
  AutomationReceiptResult,
  AutomationRunDelivery,
  AutomationRunPlan,
  StoredAutomationReceipt,
} from "./engine";

interface CommandRow {
  id: string;
  intent: string;
  created_at: number;
}

interface ReceiptRow {
  id: string;
  command_id: string;
  status: StoredAutomationReceipt["status"];
  result: string;
  recorded_at: number;
}

interface DeliveryRow {
  run_id: string;
  session_id: string;
  automation_command_id: string;
  message_command_id: string;
  message_id: string;
  text: string;
  resources: string;
  created_at: number;
  delivered_at: number | null;
}

/**
 * SQLite's private Automation ledger materialization. The command engine knows
 * only the interface in `engine.ts`; this is the one place table names and SQL
 * exist, so IPC stays a dumb transport and a future host can supply another
 * ledger without importing Electron or this database.
 */
export class SqliteAutomationLedger implements AutomationLedger {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly db: Database.Database) {}

  async transaction<T>(
    work: (transaction: AutomationLedgerTransaction) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = await work(new SqliteAutomationLedgerTransaction(this.db));
      this.db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      // A failed BEGIN must not strand every later command behind this queue.
      release();
    }
  }
}

class SqliteAutomationLedgerTransaction implements AutomationLedgerTransaction {
  constructor(private readonly db: Database.Database) {}

  getCommand(commandId: string): AutomationCommand | null {
    const row = prepared<[string], CommandRow>(
      this.db,
      "SELECT id, intent, created_at FROM automation_commands WHERE id = ?",
    ).get(commandId);
    if (row === undefined) return null;
    return {
      id: row.id,
      intent: parseJson(
        row.intent,
        `Automation command ${row.id} intent`,
      ) as AutomationCommand["intent"],
      createdAt: row.created_at,
    };
  }

  insertCommand(command: AutomationCommand): void {
    prepared(
      this.db,
      "INSERT INTO automation_commands (id, intent, created_at) VALUES (?, ?, ?)",
    ).run(command.id, JSON.stringify(command.intent), command.createdAt);
  }

  appendEvent(event: AutomationEvent): void {
    prepared(
      this.db,
      `INSERT INTO automation_events (id, command_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(event.id, event.commandId, event.kind, JSON.stringify(event.payload), event.createdAt);
  }

  listReceipts(commandId: string): readonly StoredAutomationReceipt[] {
    const rows = prepared<[string], ReceiptRow>(
      this.db,
      `SELECT id, command_id, status, result, recorded_at
         FROM automation_command_receipts
        WHERE command_id = ?
        ORDER BY rowid ASC`,
    ).all(commandId);
    return rows.map((row) => ({
      id: row.id,
      commandId: row.command_id,
      status: row.status,
      result: parseJson(
        row.result,
        `Automation receipt ${row.id} result`,
      ) as AutomationReceiptResult,
      recordedAt: row.recorded_at,
    }));
  }

  appendReceipt(receipt: StoredAutomationReceipt): void {
    prepared(
      this.db,
      `INSERT INTO automation_command_receipts (id, command_id, status, result, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      receipt.id,
      receipt.commandId,
      receipt.status,
      JSON.stringify(receipt.result),
      receipt.recordedAt,
    );
  }

  getAutomation(automationId: string): Automation | null {
    return getAutomation(this.db, automationId) ?? null;
  }

  insertAutomation(automation: Automation): void {
    if (!isAutomationRuntimePin(automation.runtime) && automation.runtime !== null) {
      throw new Error(`Automation ${automation.id} has an invalid Runtime and cannot be projected`);
    }
    prepared(
      this.db,
      `INSERT INTO automations
        (id, project_id, name, instructions, trigger_spec, runtime, row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      automation.id,
      automation.projectId,
      automation.name,
      automation.instructions,
      triggerColumnValue(automation.trigger),
      automation.runtime === null ? null : JSON.stringify(automation.runtime),
      automation.createdAt,
      automation.updatedAt,
    );
  }

  updateAutomation(automation: Automation): void {
    if (!isAutomationRuntimePin(automation.runtime) && automation.runtime !== null) {
      throw new Error(`Automation ${automation.id} has an invalid Runtime and cannot be projected`);
    }
    const changed = prepared(
      this.db,
      `UPDATE automations
          SET name = ?, instructions = ?, trigger_spec = ?, runtime = ?,
              row_version = row_version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      automation.name,
      automation.instructions,
      triggerColumnValue(automation.trigger),
      automation.runtime === null ? null : JSON.stringify(automation.runtime),
      automation.updatedAt,
      automation.id,
    );
    if (changed.changes !== 1)
      throw new Error(`Automation ${automation.id} disappeared while updating`);
  }

  deleteAutomation(automationId: string): boolean {
    return (
      prepared(this.db, "DELETE FROM automations WHERE id = ?").run(automationId).changes === 1
    );
  }

  getRun(runId: string): AutomationRun | null {
    return getAutomationRun(this.db, runId) ?? null;
  }

  insertRun(run: AutomationRun): void {
    prepared(
      this.db,
      `INSERT INTO automation_runs
        (id, automation_id, automation_name, ticket_id, session_id, provider_id, model_id, reasoning_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.automationId,
      run.automationName,
      run.ticketId,
      run.sessionId,
      run.model.providerId,
      run.model.modelId,
      run.model.reasoningLevel,
      run.createdAt,
    );
  }

  getDelivery(runId: string): AutomationRunDelivery | null {
    const row = prepared<[string], DeliveryRow>(
      this.db,
      `SELECT run_id, session_id, automation_command_id, message_command_id, message_id,
              text, resources, created_at, delivered_at
         FROM automation_run_deliveries
        WHERE run_id = ?`,
    ).get(runId);
    return row === undefined ? null : mapDelivery(row);
  }

  insertDelivery(delivery: AutomationRunDelivery): void {
    prepared(
      this.db,
      `INSERT INTO automation_run_deliveries
        (run_id, session_id, automation_command_id, message_command_id, message_id, text, resources, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      delivery.runId,
      delivery.sessionId,
      delivery.automationCommandId,
      delivery.messageCommandId,
      delivery.messageId,
      delivery.text,
      JSON.stringify(delivery.resources),
      delivery.createdAt,
      delivery.deliveredAt,
    );
  }

  markDeliveryDelivered(runId: string, deliveredAt: number): void {
    const changed = prepared(
      this.db,
      `UPDATE automation_run_deliveries
          SET delivered_at = ?
        WHERE run_id = ? AND delivered_at IS NULL`,
    ).run(deliveredAt, runId);
    if (changed.changes > 1)
      throw new Error(`Automation Run ${runId} has duplicate delivery intents`);
  }

  listRecoverableRunPlans(): readonly AutomationRunPlan[] {
    const commands = prepared<[], CommandRow>(
      this.db,
      `SELECT id, intent, created_at
         FROM automation_commands
        ORDER BY rowid ASC`,
    ).all();
    const plans: AutomationRunPlan[] = [];
    for (const row of commands) {
      const command = this.getCommand(row.id);
      if (command === null || command.intent.kind !== "automation.run") continue;
      const receipts = this.listReceipts(command.id);
      if (
        receipts.some((receipt) => receipt.status === "completed" || receipt.status === "rejected")
      ) {
        continue;
      }
      plans.push(command.intent.plan);
    }
    return plans;
  }

  listPendingDeliveriesForSession(sessionId: string): readonly AutomationRunDelivery[] {
    const rows = prepared<[string], DeliveryRow>(
      this.db,
      `SELECT run_id, session_id, automation_command_id, message_command_id, message_id,
              text, resources, created_at, delivered_at
         FROM automation_run_deliveries
        WHERE session_id = ? AND delivered_at IS NULL
        ORDER BY created_at ASC, run_id ASC`,
    ).all(sessionId);
    return rows.map(mapDelivery);
  }

  listPendingDeliveries(): readonly AutomationRunDelivery[] {
    const rows = prepared<[], DeliveryRow>(
      this.db,
      `SELECT run_id, session_id, automation_command_id, message_command_id, message_id,
              text, resources, created_at, delivered_at
         FROM automation_run_deliveries
        WHERE delivered_at IS NULL
        ORDER BY created_at ASC, run_id ASC`,
    ).all();
    return rows.map(mapDelivery);
  }
}

function mapDelivery(row: DeliveryRow): AutomationRunDelivery {
  const resources = parseJson(row.resources, `Automation Run ${row.run_id} delivery resources`);
  if (!Array.isArray(resources)) {
    throw new Error(`Automation Run ${row.run_id} delivery resources are not an array`);
  }
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    automationCommandId: row.automation_command_id,
    messageCommandId: row.message_command_id,
    messageId: row.message_id,
    text: row.text,
    resources: resources as PromptResource[],
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `${context} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
