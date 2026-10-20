/**
 * The agent doors' typed construction modules, over the host's own delivery ports
 * (VC-558, VC-627).
 *
 * Two modules, not one staged bag. Hosts build the verb door once their recovered
 * Session ports exist (`createHostAgentCommands`); the Session runtime builds the
 * tool door and watches lazily behind recovery (`createHostAgentToolDoor`,
 * `createHostAgentWatches`, called from `session-runtime/agents.ts`). Each captures
 * the event and attention wiring here, so no caller can route a verb's mutation
 * or notification anywhere else. The verb and tool doors hold no timer, bus
 * subscription or process, so neither has a stop; the socket's drain is
 * `createHostAgentSocket`'s. Watches subscribe to both wake buses when they are
 * constructed, which the Session runtime defers to the first tool call that
 * reads them, and expose `dispose`.
 */
import {
  createAgentCommandService,
  type AgentCommandService,
  type AgentCommandServiceOptions,
} from "./agent-commands";
import {
  createAgentToolDoor,
  type AgentToolDoor,
  type AgentToolDoorOptions,
} from "./agent-tool-door";
import { createAgentSocketLifecycle, startAgentSocket } from "./agent-socket";
import { createWatches, type Watches, type WatchesPorts } from "./watches";
import { subscribeTicketWake } from "./ticket-wake";
import type { HostCorePorts } from "./index";
import { hostLogger } from "./log/root";

const log = hostLogger("agent-socket");

/** Composed before database boot so early startup still owns and drains its socket. */
export function createHostAgentSocket() {
  return createAgentSocketLifecycle({
    start: startAgentSocket,
    reportFailure: (error) => {
      log.error("failed to close agent socket", { error });
    },
  });
}

/** What the host routes for the caller; supplying any of it would bypass the ports. */
export type HostAgentCommandOptions = Omit<
  AgentCommandServiceOptions,
  "notify" | "onMutation" | "onSessionStarted" | "onHarnessEvent" | "onSessionHarness"
>;

/** The verb door the agent socket serves, for desktop and hostd composition. */
export function createHostAgentCommands(
  ports: Pick<HostCorePorts, "events" | "attention">,
  options: HostAgentCommandOptions,
): AgentCommandService {
  return createAgentCommandService({
    ...options,
    notify: (request) => ports.attention.deliver(request),
    onMutation: (change) => ports.events.publish("data-changed", change),
    onSessionStarted: (notice) => ports.events.publish("session-started", notice),
    onHarnessEvent: (notice) => ports.events.publish("harness-event", notice),
    onSessionHarness: (notice) => ports.events.publish("session-harness", notice),
  });
}

export type HostAgentToolDoorOptions = Omit<
  AgentToolDoorOptions,
  "onMutation" | "onSessionStarted"
>;

/** The structured runtime's verb tools; its mutations reach the same event bus. */
export function createHostAgentToolDoor(
  ports: Pick<HostCorePorts, "events">,
  options: HostAgentToolDoorOptions,
): AgentToolDoor {
  return createAgentToolDoor({
    ...options,
    onMutation: (change) => ports.events.publish("data-changed", change),
    onSessionStarted: (notice) => ports.events.publish("session-started", notice),
  });
}

export type HostAgentWatchesOptions = Omit<WatchesPorts, "subscribeTicketWake">;

/** The watch registry over the process's one ticket-wake bus. */
export function createHostAgentWatches(options: HostAgentWatchesOptions): Watches {
  return createWatches({ ...options, subscribeTicketWake });
}
