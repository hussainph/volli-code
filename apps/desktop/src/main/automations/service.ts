import {
  automationDraftProblem,
  automationPinProblem,
  automationTriggersColumn,
  NO_AUTOMATION_TRIGGER,
  parseAutomationTrigger,
} from "@volli/shared";
import type {
  Automation,
  AutomationCommandReceipt,
  AutomationRun,
  AutomationTrigger,
  ColumnArming,
  ModelAccessSnapshot,
  ModelSelection,
  TicketStatus,
} from "@volli/shared";

import type { AutomationEngine } from "./engine";

export interface AutomationServiceDeps {
  engine: AutomationEngine;
  findProject(projectId: string): boolean;
  findAutomation(automationId: string): Automation | undefined;
  listAutomationsForProject(projectId: string): Automation[];
  runsForTicket(ticketId: string): AutomationRun[];
  /** Machine-local column arming (VC-128); outside the ledger on purpose. */
  listColumnArmings(projectId: string): ColumnArming[];
  setColumnArming(input: { projectId: string; status: TicketStatus; automationId: string }): void;
  clearColumnArming(input: { projectId: string; status: TicketStatus }): void;
  inspectModelAccess?: () => Promise<ModelAccessSnapshot>;
  onMutation?(change: { projectId?: string }): void;
}

export type AutomationReadOutcome =
  | { ok: true; automations: Automation[] }
  | { ok: false; error: string };

export type AutomationWriteOutcome =
  | { ok: true; automation: Automation; receipt: AutomationCommandReceipt }
  | { ok: false; error: string; receipt?: AutomationCommandReceipt };

export type AutomationDeleteOutcome =
  | { ok: true; receipt: AutomationCommandReceipt }
  | { ok: false; error: string; receipt?: AutomationCommandReceipt };

/** Every armed column in the project, after the write — the caller's whole new truth. */
export type AutomationArmingOutcome =
  | { ok: true; armings: ColumnArming[] }
  | { ok: false; error: string };

/**
 * The host-facing Automation application service. It owns validation against
 * live host facts (projects and Model Access), then delegates every durable
 * mutation to the command/event/projection core. It has no Electron IPC
 * knowledge; an IPC handler is only one caller of this service.
 */
/**
 * The Trigger a write actually stores.
 *
 * An omitted Trigger is "Nothing else" — the default for a new Automation and a
 * complete answer, not an unset field. Anything present goes through the shared
 * parser first, so the record is canonical the moment it is written: columns in
 * board order, duplicates and unknown names dropped, an empty list collapsed.
 * The IPC guard judges wire SHAPE only, which is why the vocabulary check has
 * to happen here rather than at the door — and why a create's own answer names
 * the same columns a later list will.
 */
function canonicalTrigger(trigger: AutomationTrigger | undefined): AutomationTrigger {
  return trigger === undefined ? NO_AUTOMATION_TRIGGER : parseAutomationTrigger(trigger);
}

export function createAutomationService(deps: AutomationServiceDeps) {
  async function writeProblem(input: {
    name: string;
    instructions: string;
    runtime: ModelSelection | null;
  }): Promise<string | null> {
    const draft = automationDraftProblem(input);
    if (draft !== null) return draft;
    if (input.runtime === null) return null;
    if (deps.inspectModelAccess === undefined) {
      return "Model Access is unavailable, so a pinned model cannot be validated. Save without a pin, or retry after relaunch.";
    }
    return automationPinProblem(await deps.inspectModelAccess(), input.runtime);
  }

  return {
    list(projectId: string): AutomationReadOutcome {
      if (!deps.findProject(projectId)) return { ok: false, error: "Unknown project" };
      return { ok: true, automations: deps.listAutomationsForProject(projectId) };
    },

    runsForTicket(ticketId: string) {
      return deps.runsForTicket(ticketId);
    },

    /** One project's armed columns — machine-local, never part of the record's list. */
    armings(projectId: string): AutomationArmingOutcome {
      if (!deps.findProject(projectId)) return { ok: false, error: "Unknown project" };
      return { ok: true, armings: deps.listColumnArmings(projectId) };
    },

    /**
     * Arms one column with one Automation, or disarms it (`automationId: null`).
     *
     * A column may only arm what it OFFERS — an Automation whose Trigger names
     * this column. Offering is the record's word and arming is the column's, and
     * this door keeps them in that order rather than quietly rewriting a Trigger
     * on a machine-local act: "fires here" is a stronger claim than "is offered
     * here", and the weaker one is a prerequisite, not a side effect.
     *
     * No command id, and no ledger entry. The write is an upsert keyed by the
     * column, so a repeat is the same end state rather than a second arming —
     * the retry identity a command id exists to provide has no work to do. More
     * importantly the ledger is the record that travels to an account one day,
     * and this choice belongs to one machine.
     */
    arm(input: {
      projectId: string;
      status: TicketStatus;
      automationId: string | null;
    }): AutomationArmingOutcome {
      if (!deps.findProject(input.projectId)) return { ok: false, error: "Unknown project" };
      if (input.automationId === null) {
        deps.clearColumnArming({ projectId: input.projectId, status: input.status });
        deps.onMutation?.({ projectId: input.projectId });
        return { ok: true, armings: deps.listColumnArmings(input.projectId) };
      }
      const automation = deps.findAutomation(input.automationId);
      if (automation === undefined) return { ok: false, error: "Unknown automation" };
      // Ownership is the listing axis: a column may only arm what its own
      // project lists — its own Automations plus the global ones.
      if (automation.projectId !== null && automation.projectId !== input.projectId) {
        return { ok: false, error: "That automation belongs to another project." };
      }
      if (!automationTriggersColumn(automation, input.status)) {
        return {
          ok: false,
          error: `"${automation.name}" is not offered in this column. Add the column to its Trigger first.`,
        };
      }
      deps.setColumnArming({
        projectId: input.projectId,
        status: input.status,
        automationId: automation.id,
      });
      deps.onMutation?.({ projectId: input.projectId });
      return { ok: true, armings: deps.listColumnArmings(input.projectId) };
    },

    async create(input: {
      commandId: string;
      projectId: string | null;
      name: string;
      instructions: string;
      trigger?: AutomationTrigger;
      runtime: ModelSelection | null;
    }): Promise<AutomationWriteOutcome> {
      // A retry must replay its receipt before consulting live facts. The
      // original accepted write remains the fact even if its project was later
      // deleted or its pinned model became unavailable.
      if (!(await deps.engine.hasCommand(input.commandId))) {
        if (input.projectId !== null && !deps.findProject(input.projectId)) {
          return { ok: false, error: "Unknown project" };
        }
        const problem = await writeProblem(input);
        if (problem !== null) return { ok: false, error: problem };
      }
      const outcome = await deps.engine.create({
        ...input,
        trigger: canonicalTrigger(input.trigger),
        name: input.name.trim(),
      });
      if (!outcome.ok) return { ok: false, error: outcome.error, receipt: outcome.receipt };
      if (!outcome.replayed) {
        deps.onMutation?.(
          outcome.value.projectId === null ? {} : { projectId: outcome.value.projectId },
        );
      }
      return { ok: true, automation: outcome.value, receipt: outcome.receipt };
    },

    async update(input: {
      commandId: string;
      automationId: string;
      name: string;
      instructions: string;
      trigger?: AutomationTrigger;
      runtime: ModelSelection | null;
    }): Promise<AutomationWriteOutcome> {
      // Same replay rule as create: validation guards a new command, never
      // hides an already-accepted receipt behind changed Model Access.
      if (!(await deps.engine.hasCommand(input.commandId))) {
        const problem = await writeProblem(input);
        if (problem !== null) return { ok: false, error: problem };
      }
      const outcome = await deps.engine.update({
        ...input,
        trigger: canonicalTrigger(input.trigger),
        name: input.name.trim(),
      });
      if (!outcome.ok) return { ok: false, error: outcome.error, receipt: outcome.receipt };
      if (!outcome.replayed) {
        deps.onMutation?.(
          outcome.value.projectId === null ? {} : { projectId: outcome.value.projectId },
        );
      }
      return { ok: true, automation: outcome.value, receipt: outcome.receipt };
    },

    async delete(input: {
      commandId: string;
      automationId: string;
    }): Promise<AutomationDeleteOutcome> {
      // Scope is read before the projection disappears. A retried delete uses
      // the command receipt and has no new mutation broadcast to manufacture.
      const existing = deps.findAutomation(input.automationId);
      const outcome = await deps.engine.delete(input);
      if (!outcome.ok) return { ok: false, error: outcome.error, receipt: outcome.receipt };
      if (!outcome.replayed) {
        deps.onMutation?.(
          existing?.projectId === null
            ? {}
            : existing === undefined
              ? {}
              : { projectId: existing.projectId },
        );
      }
      return { ok: true, receipt: outcome.receipt };
    },
  };
}

export type AutomationService = ReturnType<typeof createAutomationService>;
