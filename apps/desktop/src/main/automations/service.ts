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
  runsForProject(projectId: string): AutomationRun[];
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

/** Every armed column in the project — a read, with no command behind it. */
export type AutomationArmingReadOutcome =
  | { ok: true; armings: ColumnArming[] }
  | { ok: false; error: string };

/** The same set after a write, plus the receipt for the command that changed it. */
export type AutomationArmingOutcome =
  | { ok: true; armings: ColumnArming[]; receipt: AutomationCommandReceipt }
  | { ok: false; error: string; receipt?: AutomationCommandReceipt };

export type AutomationRunHistoryOutcome =
  | { ok: true; runs: AutomationRun[] }
  | { ok: false; error: string };

/** The whole machine-local set after the write, plus the receipt that changed it. */
export type AutomationEnablementOutcome =
  | { ok: true; enabledAutomationIds: string[]; receipt: AutomationCommandReceipt }
  | { ok: false; error: string; receipt?: AutomationCommandReceipt };

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

/**
 * The host-facing Automation application service. It owns validation against
 * live host facts (projects and Model Access), then delegates every durable
 * mutation to the command/event/projection core. It has no Electron IPC
 * knowledge; an IPC handler is only one caller of this service.
 */
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

    /**
     * One project's armed columns — machine-local, never part of the record's
     * list. Project-guarded like {@link list}: an unknown id is a refusal
     * rather than a convincing empty board.
     */
    async armings(projectId: string): Promise<AutomationArmingReadOutcome> {
      if (!deps.findProject(projectId)) return { ok: false, error: "Unknown project" };
      return { ok: true, armings: await deps.engine.columnArmings(projectId) };
    },

    /**
     * Arms one column with one Automation, or disarms it (`automationId: null`).
     *
     * A durable command like every other product write, and the same one the
     * switch uses (docs/BOUNDARIES.md rule 5): what is machine-local is where
     * the projection LANDS, not whether the intent is recorded. A retry repeats
     * this command id and replays its receipt instead of arming twice.
     *
     * A column may only arm what it OFFERS — an Automation whose Trigger names
     * this column. Offering is the record's word and arming is the column's, and
     * this door keeps them in that order rather than quietly rewriting a Trigger
     * on a machine-local act: "fires here" is a stronger claim than "is offered
     * here", and the weaker one is a prerequisite, not a side effect.
     *
     * Those live-fact checks guard a NEW command only, exactly as create and
     * update guard theirs: an already-accepted arming is a fact, and a Trigger
     * edited afterwards must not turn its retry into a refusal.
     *
     * No `onMutation` fan-out — nothing about the shared record moved, and
     * another window's list is unchanged by a choice belonging to this host.
     */
    async arm(input: {
      commandId: string;
      projectId: string;
      status: TicketStatus;
      automationId: string | null;
    }): Promise<AutomationArmingOutcome> {
      if (!(await deps.engine.hasCommand(input.commandId))) {
        if (!deps.findProject(input.projectId)) return { ok: false, error: "Unknown project" };
        if (input.automationId !== null) {
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
        }
      }
      const outcome = await deps.engine.setColumnArming(input);
      if (!outcome.ok) return { ok: false, error: outcome.error, receipt: outcome.receipt };
      return { ok: true, armings: outcome.value, receipt: outcome.receipt };
    },

    /**
     * The Automations page's Run history. Project-guarded like {@link list}
     * above and unlike `runsForTicket`: this reads a whole project's work,
     * so an unknown id is a refusal rather than a convincing empty list.
     */
    runsForProject(projectId: string): AutomationRunHistoryOutcome {
      if (!deps.findProject(projectId)) return { ok: false, error: "Unknown project" };
      return { ok: true, runs: deps.runsForProject(projectId) };
    },

    /**
     * Which Automations are switched on ON THIS MACHINE (VC-127).
     *
     * Absent means off: VC-112 rules that a machine fires nothing until
     * someone turns something on there, so "never asked here" and "said no
     * here" are deliberately one state — see `enablement.ts`.
     */
    enabledAutomationIds(): Promise<string[]> {
      return deps.engine.enabledAutomationIds();
    },

    /**
     * Flips one switch. A durable command like every other product write
     * (docs/BOUNDARIES.md rule 5): what is machine-local is where the
     * projection LANDS, not whether the intent is recorded. No `onMutation`
     * fan-out — nothing about the shared record moved, and another window's
     * list is unchanged by a switch belonging to this host.
     */
    async setEnabled(input: {
      commandId: string;
      automationId: string;
      enabled: boolean;
    }): Promise<AutomationEnablementOutcome> {
      const outcome = await deps.engine.setEnabled(input);
      if (!outcome.ok) return { ok: false, error: outcome.error, receipt: outcome.receipt };
      return { ok: true, enabledAutomationIds: outcome.value, receipt: outcome.receipt };
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
