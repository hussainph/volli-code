/** Private recovery staging; public tools and watches require recovered services. */
import { isLiveHost, type HostCore } from "../index";
import type { Logger } from "../log/logger";
import type { HostEventBus } from "../ports/events";
import { getProjectAuthorityPolicy, listProjects } from "../db/projects-repo";
import { listAutomationsForProject } from "../db/automations-repo";
import { getComment } from "../db/comments-repo";
import { actorSessionTicketDisplay } from "../agent-dispatch/resolution";
import type { AgentToolDoor } from "../agent-tool-door";
import { createHostAgentToolDoor, createHostAgentWatches } from "../agent-services";
import type { Watches } from "../watches";
import { createDelegations, type Delegations } from "./delegate-session";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { RuntimeSessionFacade, RuntimeSessionServices } from "./facade";
import { readRecoveredSessionServices, type RecoveredSessionServices } from "./lifecycle";
import type { createRuntimeAutomations } from "./automations";
import type { McpSettingsService } from "../mcp/settings";

export interface RuntimeSessionAgentOptions {
  host: HostCore;
  facade: RuntimeSessionFacade;
  services: RuntimeSessionServices;
  delegation: TicketSessionDelegationStore | null;
  automations: ReturnType<typeof createRuntimeAutomations>;
  mcpSettings: McpSettingsService | null;
  events: HostEventBus;
  log: Pick<Logger, "error">;
}

export function createRuntimeSessionAgents(options: RuntimeSessionAgentOptions) {
  const {
    host: hostCore,
    delegation: sessionDelegation,
    automations: runtimeAutomations,
    mcpSettings,
  } = options;
  const liveHost = isLiveHost(hostCore) ? hostCore : undefined;
  const sessionEngine = liveHost?.sessionEngine ?? null;
  const sessionWakeBus = liveHost?.sessionWakeBus ?? null;
  const sessionDb = liveHost?.database.db ?? null;
  const {
    sessions,
    runtime: sessionRuntime,
    submitKickoffMessage,
    autoTitler,
    transcriptArtifacts,
  } = options.services;
  let delegations: Delegations | null = null;
  let unsubscribeDelegations: (() => void) | undefined;
  let stopped = false;
  const delegationsFor = (): Delegations | null => {
    if (stopped) return null;
    if (delegations !== null) return delegations;
    if (
      sessions === null ||
      sessionRuntime === null ||
      sessionEngine === null ||
      submitKickoffMessage === undefined
    ) {
      return null;
    }
    const created = createDelegations({
      sessions,
      submitSessionMessage: submitKickoffMessage,
      runtime: sessionRuntime,
      sessionEngine,
      readTranscriptArtifact: (reference) => transcriptArtifacts.read(reference),
      onMutation: (change) => options.events.publish("data-changed", change),
      now: () => Date.now(),
    });
    delegations = created;
    if (sessionWakeBus !== null && sessionDelegation !== null) {
      const store = sessionDelegation;
      unsubscribeDelegations = sessionWakeBus.subscribe((wake) => {
        const payload = wake.event.payload;
        if (payload.kind !== "turn.started" || created.watching(wake.event.sessionId)) return;
        const entry = store.subagentDelegation(wake.event.sessionId);
        if (entry === null) return;
        const work = created
          .rearm(entry, { turnId: payload.turnId, afterSequence: wake.event.sequence })
          .catch((error: unknown) => {
            options.log.error("could not re-arm the notice for a resumed subagent", {
              childSessionId: entry.childSessionId,
              error,
            });
          });
        liveHost?.detachedWork.track(work);
      });
    }
    return delegations;
  };
  let watches: Watches | null = null;
  const watchesFor = (): Watches | null => {
    if (stopped) return null;
    if (watches !== null) return watches;
    if (
      liveHost === undefined ||
      sessionWakeBus === null ||
      sessionRuntime === null ||
      sessionEngine === null
    ) {
      return null;
    }
    const db = liveHost.database.db;
    watches = createHostAgentWatches({
      detachedWork: liveHost.detachedWork,
      subscribeSessionWake: (listener) => sessionWakeBus.subscribe(listener),
      runtime: sessionRuntime,
      sessionEngine,
      readTranscriptArtifact: (reference) => transcriptArtifacts.read(reference),
      readComment: (commentId) => getComment(db, commentId)?.body ?? null,
      pendingSubagents: (sessionId) => delegations?.liveChildren(sessionId) ?? [],
    });
    return watches;
  };
  let agentToolDoor: AgentToolDoor | null | undefined;
  function toolDoor(ready: RecoveredSessionServices<RuntimeSessionFacade>): AgentToolDoor | null {
    if (readRecoveredSessionServices(ready) !== options.facade)
      throw new Error("The recovered facade belongs to a different runtime.");
    if (agentToolDoor !== undefined) return agentToolDoor;
    agentToolDoor =
      sessionDb === null || sessionDelegation === null
        ? null
        : createHostAgentToolDoor(
            { events: options.events },
            {
              db: sessionDb,
              projects: () => listProjects(sessionDb),
              sessions: () => sessions,
              delegation: sessionDelegation,
              automations: () => {
                if (runtimeAutomations.kind === "degraded") return null;
                const execution = runtimeAutomations.execution;
                return execution.kind !== "ready"
                  ? null
                  : {
                      list: (projectId) => listAutomationsForProject(sessionDb, projectId),
                      run: (input) => execution.runner.run(input),
                    };
              },
              authorityPolicy: (projectId) => getProjectAuthorityPolicy(sessionDb, projectId),
              watches: watchesFor,
              supervise: () =>
                sessionEngine !== null && sessionRuntime !== null
                  ? { sessionEngine, runtime: sessionRuntime }
                  : null,
              delegate: delegationsFor,
              mcp: () => mcpSettings,
              ...(submitKickoffMessage === undefined
                ? {}
                : { submitSessionMessage: submitKickoffMessage }),
              ...(autoTitler === null
                ? {}
                : { refineAutoTitle: (input) => void autoTitler.refine(input) }),
              actorTicketDisplay: (ticketId) =>
                actorSessionTicketDisplay(sessionDb, listProjects(sessionDb), ticketId),
              now: () => Date.now(),
            },
          );
    return agentToolDoor;
  }
  return {
    // Recovery may read children, but cannot expose the public delegate door.
    recoveryDelegationsFor: (): Pick<Delegations, "recover"> | null => {
      const host = delegationsFor();
      return host === null ? null : { recover: (unanswered) => host.recover(unanswered) };
    },
    toolDoor,
    stop() {
      if (stopped) return;
      stopped = true;
      watches?.dispose();
      unsubscribeDelegations?.();
    },
  };
}

export type RuntimeSessionAgents = ReturnType<typeof createRuntimeSessionAgents>;
