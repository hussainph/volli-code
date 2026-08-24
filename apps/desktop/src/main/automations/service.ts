import { automationDraftProblem, automationPinProblem } from "@volli/shared";
import type {
  Automation,
  AutomationCommandReceipt,
  AutomationRun,
  ModelAccessSnapshot,
  ModelSelection,
} from "@volli/shared";

import type { AutomationEngine } from "./engine";

export interface AutomationServiceDeps {
  engine: AutomationEngine;
  findProject(projectId: string): boolean;
  findAutomation(automationId: string): Automation | undefined;
  listAutomationsForProject(projectId: string): Automation[];
  runsForTicket(ticketId: string): AutomationRun[];
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

    async create(input: {
      commandId: string;
      projectId: string | null;
      name: string;
      instructions: string;
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
      runtime: ModelSelection | null;
    }): Promise<AutomationWriteOutcome> {
      // Same replay rule as create: validation guards a new command, never
      // hides an already-accepted receipt behind changed Model Access.
      if (!(await deps.engine.hasCommand(input.commandId))) {
        const problem = await writeProblem(input);
        if (problem !== null) return { ok: false, error: problem };
      }
      const outcome = await deps.engine.update({ ...input, name: input.name.trim() });
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
