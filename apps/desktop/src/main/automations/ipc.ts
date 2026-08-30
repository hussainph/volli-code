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
  AutomationArmingsResult,
  AutomationArmResult,
  AutomationColumnOrdersResult,
  AutomationDeleteResult,
  AutomationEnablementResult,
  AutomationIpcChannel,
  AutomationResult,
  AutomationRunForProjectInput,
  AutomationRunInput,
  AutomationRunStartResult,
  AutomationRunsResult,
  AutomationsResult,
  AutomationSetColumnOrderResult,
  AutomationSetEnabledResult,
  AutomationSkipsResult,
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
      // ATTENDED, and decided here rather than read off `input` (VC-133).
      //
      // Every surface behind this channel is one a person had to act on to
      // reach: the Ticket rail's split button, the board card's context menu,
      // the armed column's 3500ms drop window, the command palette. VC-112:
      // "a column move is attended because a person is right there."
      //
      // The renderer does not get to say so — `AutomationRunInput` carries no
      // attendance field and the guard would reject one. Being this handler is
      // the evidence, so the fact cannot be forged or forgotten upstream.
      const outcome = await deps.runner.run({ ...input, attendance: "attended" });
      return outcome;
    },

    "volli:automation-runs-for-ticket": (input): AutomationRunsResult => ({
      ok: true,
      runs: service.runsForTicket(input.ticketId),
    }),

    "volli:automation-arming-list": async (input): Promise<AutomationArmingsResult> =>
      service.armings(input.projectId),

    "volli:automation-arm": async (input): Promise<AutomationArmResult> => service.arm(input),

    "volli:automation-column-order-list": async (input): Promise<AutomationColumnOrdersResult> =>
      service.columnOrders(input.projectId),

    "volli:automation-set-column-order": async (input): Promise<AutomationSetColumnOrderResult> =>
      service.setColumnOrder(input),

    "volli:automation-runs-for-project": (input): AutomationRunsResult =>
      service.runsForProject(input.projectId),

    "volli:automation-enablement": async (): Promise<AutomationEnablementResult> => ({
      ok: true,
      enabledAutomationIds: await service.enabledAutomationIds(),
    }),

    "volli:automation-set-enabled": async (input): Promise<AutomationSetEnabledResult> =>
      service.setEnabled(input),

    "volli:automation-skips-for-project": (input): AutomationSkipsResult =>
      service.skipsForProject(input.projectId),

    // The Project-target Run door (VC-130). The same runner and the same
    // degraded answer as the Ticket one beside it — a Run needs the Session
    // facade whichever Target it names.
    "volli:automation-run-for-project": async (
      input: AutomationRunForProjectInput,
    ): Promise<AutomationRunStartResult> => {
      if (deps.runner === null) {
        return {
          ok: false,
          code: "RUN_FAILED",
          error: "The Session runtime is not available this launch.",
        };
      }
      // ATTENDED for the same reason as the Ticket door above: the only caller
      // of this CHANNEL is "Run now" on a Skipped occurrence, which is a person
      // recovering an evening the app was closed for. The schedule timer runs
      // the same Automation through the same runner method, but it does not
      // come through IPC — it is inside main, and it passes `unattended`.
      return deps.runner.runForProject({ ...input, attendance: "attended" });
    },
  };

  registerGuardedIpcHandlers(AUTOMATION_IPC, handlers);
}
