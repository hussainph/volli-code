/** Staged agent-door construction, over the host's own delivery ports (VC-558). */
import { errorMessage } from "@volli/shared";
import { createAgentCommandService, type AgentCommandServiceOptions } from "./agent-commands";
import { createAgentToolDoor, type AgentToolDoorOptions } from "./agent-tool-door";
import { createAgentSocketLifecycle, startAgentSocket } from "./agent-socket";
import { createWatches, type WatchesPorts } from "./watches";
import { subscribeTicketWake } from "./ticket-wake";
import type { HostCorePorts } from "./index";

/** Composed before database boot so early startup still owns and drains its socket. */
export function createHostAgentSocket() {
  return createAgentSocketLifecycle({
    start: startAgentSocket,
    reportFailure: (error) => {
      console.error("[volli] failed to close agent socket:", errorMessage(error));
    },
  });
}

export function createHostAgentServices(ports: Pick<HostCorePorts, "events" | "attention">) {
  return {
    createCommands: (
      options: Omit<
        AgentCommandServiceOptions,
        "notify" | "onMutation" | "onSessionStarted" | "onHarnessEvent" | "onSessionHarness"
      >,
    ) =>
      createAgentCommandService({
        ...options,
        notify: (request) => ports.attention.deliver(request),
        onMutation: (change) => ports.events.publish("data-changed", change),
        onSessionStarted: (notice) => ports.events.publish("session-started", notice),
        onHarnessEvent: (notice) => ports.events.publish("harness-event", notice),
        onSessionHarness: (notice) => ports.events.publish("session-harness", notice),
      }),
    createToolDoor: (options: Omit<AgentToolDoorOptions, "onMutation" | "onSessionStarted">) =>
      createAgentToolDoor({
        ...options,
        onMutation: (change) => ports.events.publish("data-changed", change),
        onSessionStarted: (notice) => ports.events.publish("session-started", notice),
      }),
    createWatches: (options: Omit<WatchesPorts, "subscribeTicketWake">) =>
      createWatches({ ...options, subscribeTicketWake }),
  };
}

export type HostAgentServices = ReturnType<typeof createHostAgentServices>;
