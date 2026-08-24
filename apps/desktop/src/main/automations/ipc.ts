/**
 * The Automations IPC surface (VC-126): CRUD over the record, plus the one
 * Run door. Registered through the shared guard→body→envelope registry
 * (issue #98): `AUTOMATION_IPC` supplies the validators, this module supplies
 * only the handler bodies, and a failed db open degrades every channel to a
 * typed `{ ok: false, error }` — same stance as theme-ipc.ts.
 *
 * Two validations live HERE rather than in the renderer, because main owns
 * the write: the draft rule (a name and Instructions are required — shared
 * `automationDraftProblem`, so the editor's disabled Save and this refusal
 * are one policy), and the Runtime pin rule (shared `automationPinProblem`
 * against a live Model Access snapshot — a pin is validated against that
 * model's own reasoning levels when it is SET, so an unspellable pair cannot
 * be stored; a pin that later goes stale fails at run through the Session
 * start's existing error path instead).
 */
import type { ModelAccessSnapshot } from "@volli/shared";
import { automationDraftProblem, automationPinProblem } from "@volli/shared";

import type {
  AutomationCreateInput,
  AutomationIdInput,
  AutomationIpcChannel,
  AutomationResult,
  AutomationRunInput,
  AutomationRunsResult,
  AutomationRunStartResult,
  AutomationsResult,
  AutomationUpdateInput,
  ProjectIdInput,
  Result,
  TicketIdInput,
} from "../../ipc/contract";
import type { AutomationRunner } from "./run";
import type { DbHandle } from "../data-ipc";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationsForProject,
  listRunsForTicket,
  updateAutomation,
} from "../db/automations-repo";
import { getProjectById } from "../db/projects-repo";
import { AUTOMATION_CHANNELS, AUTOMATION_IPC } from "../ipc-descriptors";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "../ipc-registry";
import type { IpcHandlerTable } from "../ipc-registry";

export interface AutomationIpcDeps {
  /**
   * The Run door, or `null` when the Session runtime never came up this
   * launch — the CRUD half still works then (the record is plain SQLite), and
   * only `run` answers with the runtime's absence.
   */
  runner: AutomationRunner | null;
  /**
   * Model Access, for save-time pin validation. Absent (runtime down) refuses
   * a WRITE that carries a pin rather than storing what nothing validated —
   * inherit-writes still land.
   */
  inspectModelAccess?: () => Promise<ModelAccessSnapshot>;
  /**
   * Fired after any committed mutation, with the best scope known — the
   * composition root broadcasts `volli:data-changed` from it so other windows
   * refresh their automations without a poll.
   */
  onMutation?: (change: { projectId?: string; ticketId?: string }) => void;
  now(): number;
}

/** The two write doors share one validation: the draft rule, then the pin rule. */
async function writeProblem(
  deps: AutomationIpcDeps,
  input: { name: string; instructions: string; runtime: AutomationCreateInput["runtime"] },
): Promise<string | null> {
  const draftProblem = automationDraftProblem(input);
  if (draftProblem !== null) return draftProblem;
  if (input.runtime === null) return null;
  if (deps.inspectModelAccess === undefined) {
    return "Model Access is unavailable, so a pinned model cannot be validated. Save without a pin, or retry after relaunch.";
  }
  const access = await deps.inspectModelAccess();
  return automationPinProblem(access, input.runtime);
}

export function registerAutomationIpcHandlers(handle: DbHandle, deps: AutomationIpcDeps): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(AUTOMATION_CHANNELS, handle.error);
    return;
  }
  const db = handle.db;

  const handlers: IpcHandlerTable<AutomationIpcChannel> = {
    "volli:automation-list": (input: ProjectIdInput): AutomationsResult => {
      if (getProjectById(db, input.projectId) === undefined) {
        return { ok: false, error: "Unknown project" };
      }
      return { ok: true, automations: listAutomationsForProject(db, input.projectId) };
    },

    "volli:automation-create": async (input: AutomationCreateInput): Promise<AutomationResult> => {
      if (input.projectId !== null && getProjectById(db, input.projectId) === undefined) {
        return { ok: false, error: "Unknown project" };
      }
      const problem = await writeProblem(deps, input);
      if (problem !== null) return { ok: false, error: problem };
      const automation = createAutomation(
        db,
        {
          projectId: input.projectId,
          name: input.name.trim(),
          instructions: input.instructions,
          runtime: input.runtime,
        },
        deps.now(),
      );
      deps.onMutation?.(automation.projectId === null ? {} : { projectId: automation.projectId });
      return { ok: true, automation };
    },

    "volli:automation-update": async (input: AutomationUpdateInput): Promise<AutomationResult> => {
      const problem = await writeProblem(deps, input);
      if (problem !== null) return { ok: false, error: problem };
      const automation = updateAutomation(
        db,
        input.automationId,
        { name: input.name.trim(), instructions: input.instructions, runtime: input.runtime },
        deps.now(),
      );
      if (automation === undefined) return { ok: false, error: "Unknown automation" };
      deps.onMutation?.(automation.projectId === null ? {} : { projectId: automation.projectId });
      return { ok: true, automation };
    },

    "volli:automation-delete": (input: AutomationIdInput): Result => {
      const existing = getAutomation(db, input.automationId);
      if (existing === undefined || !deleteAutomation(db, input.automationId)) {
        return { ok: false, error: "Unknown automation" };
      }
      deps.onMutation?.(existing.projectId === null ? {} : { projectId: existing.projectId });
      return { ok: true };
    },

    "volli:automation-run": async (
      input: AutomationRunInput,
    ): Promise<AutomationRunStartResult> => {
      if (deps.runner === null) {
        return {
          ok: false,
          code: "RUN_FAILED",
          error: "The Session runtime is not available this launch.",
        };
      }
      const outcome = await deps.runner.run(input);
      if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
      deps.onMutation?.({ projectId: outcome.projectId, ticketId: input.ticketId });
      return { ok: true, run: outcome.run, projectId: outcome.projectId };
    },

    "volli:automation-runs-for-ticket": (input: TicketIdInput): AutomationRunsResult => ({
      ok: true,
      runs: listRunsForTicket(db, input.ticketId),
    }),
  };

  registerGuardedIpcHandlers(AUTOMATION_IPC, handlers);
}
