/**
 * The door {@link HostDecisions} speaks to Settings through (VC-478).
 *
 * Thin on purpose, like `../web/ipc.ts`: three guarded requests in, the whole
 * view out, and no policy of its own. Nothing here carries a secret — a cloud
 * model's key is entered through Model Access sign-in — so unlike that door
 * this one has nothing it must not log; it still logs nothing, because it has
 * nothing to say that the answer does not.
 */

import { DECISION_MODEL_CHANNELS, DECISION_MODEL_IPC } from "../ipc-descriptors";
import type { DecisionModelIpcChannel } from "../../ipc/contract";
import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import type { HostDecisions } from "@volli/host-core/session-runtime";

/**
 * Registers the surface, or the honest refusal: `decisions` is null when the
 * database or the agent runtime never came up. The channels are claimed either
 * way, because an unregistered `invoke` channel hangs rather than failing.
 */
export function registerDecisionModelIpcHandlers(
  decisions: HostDecisions | null,
  unavailableReason: string = "Decision models are unavailable.",
): void {
  if (decisions === null) {
    registerDegradedIpcHandlers(DECISION_MODEL_CHANNELS, unavailableReason);
    return;
  }
  const handlers: IpcHandlerTable<DecisionModelIpcChannel> = {
    "volli:decision-model-get": async (projectId) => ({
      ok: true,
      settings: await decisions.view(projectId),
    }),
    "volli:decision-model-set": async (scope, setting) => ({
      ok: true,
      ...(await decisions.set(scope, setting)),
    }),
    "volli:decision-model-test": async (setting) => ({
      ok: true,
      test: await decisions.test(setting),
    }),
  };
  registerGuardedIpcHandlers(DECISION_MODEL_IPC, handlers);
}
