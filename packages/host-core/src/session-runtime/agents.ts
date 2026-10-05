/** Private recovery staging; public tools and watches require recovered services. */
import { errorMessage } from "@volli/shared";
import type { HostCore } from "../index";
import type { HostEventBus } from "../ports/events";
import { getProjectAuthorityPolicy, listProjects } from "../db/projects-repo";
import { listAutomationsForProject } from "../db/automations-repo";
import { getComment } from "../db/comments-repo";
import { actorSessionTicketDisplay } from "../agent-dispatch/resolution";
import type { AgentToolDoor } from "../agent-tool-door";
import type { Watches } from "../watches";
import { createDelegations, type Delegations } from "./delegate-session";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { RuntimeSessionFacade, RuntimeSessionServices } from "./facade";
import type { RecoveredSessionServices } from "./lifecycle";
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
  log: Pick<Console, "error">;
}

export function createRuntimeSessionAgents(options: RuntimeSessionAgentOptions) {
  const {
    host: hostCore,
    delegation: sessionDelegation,
    automations: runtimeAutomations,
    mcpSettings,
  } = options;
  const { sessionEngine, sessionWakeBus } = hostCore;
  const sessionDb = hostCore.database.ok ? hostCore.database.db : null;
  const {
    sessions,
    runtime: sessionRuntime,
    submitKickoffMessage,
    autoTitler,
    transcriptArtifacts,
  } = options.services;
  let delegations: Delegations | null = null;
  const delegationsFor = (): Delegations | null => {
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
      sessionWakeBus.subscribe((wake) => {
        const payload = wake.event.payload;
        if (payload.kind !== "turn.started" || created.watching(wake.event.sessionId)) return;
        const entry = store.subagentDelegation(wake.event.sessionId);
        if (entry === null) return;
        void created
          .rearm(entry, { turnId: payload.turnId, afterSequence: wake.event.sequence })
          .catch((error: unknown) => {
            options.log.error(
              `[volli] could not re-arm the notice for resumed subagent ${entry.childSessionId}:`,
              errorMessage(error),
            );
          });
      });
    }
    return delegations;
  };
  let watches: Watches | null = null;
  const watchesFor = (): Watches | null => {
    if (watches !== null) return watches;
    if (
      sessionWakeBus === null ||
      sessionRuntime === null ||
      sessionEngine === null ||
      sessionDb === null
    ) {
      return null;
    }
    const db = sessionDb;
    watches = hostCore.agentServices.createWatches({
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
    if (ready.services !== options.facade)
      throw new Error("The recovered facade belongs to a different runtime.");
    if (agentToolDoor !== undefined) return agentToolDoor;
    agentToolDoor =
      sessionDb === null || sessionDelegation === null
        ? null
        : hostCore.agentServices.createToolDoor({
            db: sessionDb,
            projects: () => listProjects(sessionDb),
            sessions: () => sessions,
            delegation: sessionDelegation,
            automations: () =>
              runtimeAutomations.runner === null
                ? null
                : {
                    list: (projectId) => listAutomationsForProject(sessionDb, projectId),
                    run: (input) => runtimeAutomations.runner!.run(input),
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
          });
    return agentToolDoor;
  }
  return {
    // Recovery may read children, but cannot expose the public delegate door.
    recoveryDelegationsFor: (): Pick<Delegations, "recover"> | null => {
      const host = delegationsFor();
      return host === null ? null : { recover: (unanswered) => host.recover(unanswered) };
    },
    toolDoor,
  };
}

export type RuntimeSessionAgents = ReturnType<typeof createRuntimeSessionAgents>;
