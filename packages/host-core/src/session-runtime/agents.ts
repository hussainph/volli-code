/** Private recovery staging; public tools and watches require recovered services. */
import { isLiveHost, type HostCore } from "../index";
import type { Logger } from "../log/logger";
import type { HostEventBus } from "../ports/events";
import { getProjectAuthorityPolicy, listProjects } from "../db/projects-repo";
import { DEFAULT_AUTHORITY_POLICY, type Project } from "@volli/shared";
import { listAutomationsForProject } from "../db/automations-repo";
import { getComment } from "../db/comments-repo";
import type { AgentToolDoor } from "../agent-tool-door";
import type { HostHandlerMap } from "../handlers/handler-map";
import { createHostAgentToolDoor, createHostAgentWatches } from "../agent-services";
import type { Watches } from "../watches";
import { commandOriginOf, createDelegations, type Delegations } from "./delegate-session";
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
  /**
   * The host's handler map for these recovered services (VC-923), which the
   * tool door projects and serves its own verbs into: the root's one map,
   * built on first ask, so a tool call never waits on another door to build it.
   */
  handlers: (ready: RecoveredSessionServices<RuntimeSessionFacade>) => HostHandlerMap;
  projects?(): readonly Project[];
  /** Cloud watches are backend jobs, never an additional in-process delivery. */
  inProcessWatches?: boolean;
  /**
   * Whether this launch has Automations at all (VC-952). A cloud launch passes
   * `false`, so the tool door refuses a frozen `automation.run` before any
   * project or Ticket resolution; absent keeps a local launch's answer.
   */
  automationsAvailable?: boolean;
  cloudSessionVerbs?: import("../cloud-agent/session-verbs").CloudSessionVerbs;
}

export function createRuntimeSessionAgents(options: RuntimeSessionAgentOptions) {
  const {
    host: hostCore,
    delegation: sessionDelegation,
    automations: runtimeAutomations,
    mcpSettings,
  } = options;
  const liveHost = isLiveHost(hostCore) ? hostCore : undefined;
  const sessionEngine = options.services.sessionEngine;
  const sessionWakeBus = liveHost?.sessionWakeBus ?? null;
  const sessionDb = liveHost?.database.db ?? null;
  const {
    sessions,
    runtime: sessionRuntime,
    submitKickoffMessage,
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
        // A turn's start re-arms a settled child; so does a message steered
        // into a turn already running (VC-809), which that start never saw.
        const joined =
          payload.kind === "command.recorded" && payload.command.intent.kind === "message.submit";
        if (payload.kind !== "turn.started" && !joined) return;
        if (created.watching(wake.event.sessionId)) return;
        const entry = store.subagentDelegation(wake.event.sessionId);
        if (entry === null) return;
        const work = (
          payload.kind === "turn.started"
            ? created.rearm(entry, { turnId: payload.turnId, afterSequence: wake.event.sequence })
            : created.rearmJoined(entry, {
                origin: commandOriginOf(wake.event),
                afterSequence: wake.event.sequence,
              })
        ).catch((error: unknown) => {
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
    if (stopped || options.inProcessWatches === false) return null;
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
    if (sessionDb === null || sessionDelegation === null) {
      agentToolDoor = null;
      return agentToolDoor;
    }
    agentToolDoor = createHostAgentToolDoor({
      db: sessionDb,
      projects: options.projects ?? (() => listProjects(sessionDb)),
      handlers: options.handlers(ready),
      ...(options.cloudSessionVerbs === undefined
        ? {}
        : { cloudSessionVerbs: options.cloudSessionVerbs }),
      ...(options.automationsAvailable === undefined
        ? {}
        : { automationsAvailable: options.automationsAvailable }),
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
      authorityPolicy: (projectId) =>
        options.cloudSessionVerbs === undefined
          ? getProjectAuthorityPolicy(sessionDb, projectId)
          : DEFAULT_AUTHORITY_POLICY,
      watches: watchesFor,
      supervise: () =>
        sessionEngine !== null && sessionRuntime !== null
          ? { sessionEngine, runtime: sessionRuntime }
          : null,
      delegate: delegationsFor,
      mcp: () => mcpSettings,
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
    stop() {
      if (stopped) return;
      stopped = true;
      watches?.dispose();
      unsubscribeDelegations?.();
    },
  };
}

export type RuntimeSessionAgents = ReturnType<typeof createRuntimeSessionAgents>;
