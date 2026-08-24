/**
 * Electron transport for Automations.
 *
 * This module deliberately owns only guard→service→envelope plumbing. The
 * Automation application service validates host facts, the transport-neutral
 * engine accepts commands into immutable events and receipts, and SQLite is a
 * private projection behind those layers. IPC neither queries nor mutates a
 * database, so another host can call the same service without inheriting an
 * Electron-shaped product API.
 */
import type {
  AutomationDeleteResult,
  AutomationIpcChannel,
  AutomationResult,
  AutomationRunInput,
  AutomationRunStartResult,
  AutomationRunsResult,
  AutomationsResult,
} from "../../ipc/contract";
import type { DbHandle } from "../data-ipc";
import { AUTOMATION_CHANNELS, AUTOMATION_IPC } from "../ipc-descriptors";
import type { IpcHandlerTable } from "../ipc-registry";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "../ipc-registry";
import type { AutomationRunner } from "./run";
import type { AutomationService } from "./service";

export interface AutomationIpcDeps {
  /** Command/event/projection application service; absent only during a degraded boot. */
  service: AutomationService | null;
  /** The Run host, absent when the Session runtime never came up this launch. */
  runner: AutomationRunner | null;
}

export function registerAutomationIpcHandlers(handle: DbHandle, deps: AutomationIpcDeps): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(AUTOMATION_CHANNELS, handle.error);
    return;
  }
  const service = deps.service;
  if (service === null) {
    registerDegradedIpcHandlers(
      AUTOMATION_CHANNELS,
      "The Automation service is not available this launch.",
    );
    return;
  }

  const handlers: IpcHandlerTable<AutomationIpcChannel> = {
    "volli:automation-list": (input): AutomationsResult => service.list(input.projectId),

    "volli:automation-create": async (input): Promise<AutomationResult> => service.create(input),

    "volli:automation-update": async (input): Promise<AutomationResult> => service.update(input),

    "volli:automation-delete": async (input): Promise<AutomationDeleteResult> =>
      service.delete(input),

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
      return outcome;
    },

    "volli:automation-runs-for-ticket": (input): AutomationRunsResult => ({
      ok: true,
      runs: service.runsForTicket(input.ticketId),
    }),
  };

  registerGuardedIpcHandlers(AUTOMATION_IPC, handlers);
}
