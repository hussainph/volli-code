/**
 * The door {@link AgentObservability} speaks to Settings through.
 *
 * Thin, like `../web/ipc.ts`: two guarded requests in, a settings view out, and
 * no policy of its own. What an address may be, and whether export is running,
 * are decisions the owner makes — which is what keeps that owner testable
 * without Electron.
 *
 * Both channels answer with the whole view rather than an acknowledgement, so
 * there is no way for the page to hold a picture of a setting the write did not
 * produce. A refusal from the owner throws instead, and the registry's envelope
 * turns it into `{ ok: false, error }` carrying the owner's own sentence — the
 * one a person needs to read to fix the address they just typed.
 */

import { AGENT_OBSERVABILITY_CHANNELS, AGENT_OBSERVABILITY_IPC } from "../ipc-descriptors";
import type {
  AgentObservabilityIpcChannel,
  AgentObservabilityResult,
  AgentObservabilityView,
} from "../../ipc/contract";

import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import type { AgentObservability } from "./settings";

const answer = (settings: AgentObservabilityView): AgentObservabilityResult => ({
  ok: true,
  settings,
});

/**
 * Registers the surface, or the honest refusal.
 *
 * `observability` is null when the database never opened. The channels are still
 * claimed, because an unregistered `invoke` channel does not fail — it hangs,
 * and a Settings page that never answers is worse than one that says why.
 */
export function registerAgentObservabilityIpcHandlers(
  observability: AgentObservability | null,
  unavailableReason: string = "Agent telemetry settings are unavailable.",
): void {
  if (observability === null) {
    registerDegradedIpcHandlers(AGENT_OBSERVABILITY_CHANNELS, unavailableReason);
    return;
  }

  const handlers: IpcHandlerTable<AgentObservabilityIpcChannel> = {
    "volli:agent-observability-get": () => answer(observability.view()),
    "volli:agent-observability-set": (enabled, endpoint) =>
      answer(observability.configure({ enabled, endpoint })),
  };
  registerGuardedIpcHandlers(AGENT_OBSERVABILITY_IPC, handlers);
}
