/**
 * The agent socket's own verbs as entries of the host's handler map (VC-923).
 *
 * Every socket verb that is neither a catalog command nor a ticket write
 * projected onto a board key is its own key on the map (`AgentHandlerKey`),
 * and {@link AGENT_VERB_HANDLERS} is what answers each one: the verb's handler,
 * unchanged, run against a context built from the agent command service's
 * state and the request the door resolved. The socket's `AGENT_VERB_TABLE`
 * binds every one of them only as a projection of `handlers[key]`
 * (`./table.ts`), so the socket, the catalog's routers and any later door
 * share one table of keys, reached one way: {@link invokeHandler}, under the
 * door's policy.
 *
 * The entries are served rather than sealed: their ports are the agent command
 * service's composition (the Session Engine, the attachments, the host's
 * environment facts), which the composition roots build after the map. The
 * service serves {@link agentVerbEntries} into the map it was handed, once, on
 * construction (`createAgentCommandService`), and until then they answer
 * unavailable.
 */

import type { AgentHandlerKey, SessionProjection, SessionRecord } from "@volli/shared";
import type { SessionEngine } from "@volli/session-engine";

import type { HostHandlers } from "../handlers/host-handlers";
import { terminalSessionRecord } from "../session-control";
import type { AgentVerbContext, AgentVerbHandler, AgentVerbInput } from "./context";
import { doctorVerb, modelListVerb, notifyVerb, promptBaselineVerb } from "./app-verbs";
import { conflictsVerb } from "./conflicts-verb";
import { costVerb } from "./cost-verb";
import { hookVerb, sessionHarnessVerb, sessionLinkVerb } from "./harness-verbs";
import { labelMergeVerb } from "./label-verbs";
import { projectAddVerb } from "./project-verbs";
import { sessionStartVerb } from "./operator-session-start";
import {
  boardVerb,
  identifyVerb,
  labelListVerb,
  projectListVerb,
  ticketBriefVerb,
  ticketEventsVerb,
  ticketListVerb,
  ticketShowVerb,
} from "./read-verbs";
import { sessionBlockedVerb, sessionDoneVerb } from "./session-verbs";
import { ticketSignalVerb } from "./ticket-verbs";
import { worktreeDiffVerb, worktreeStatusVerb, worktreeSyncVerb } from "./worktree-verbs";

/**
 * Each agent key's handler, in the Verb Registry's declaration order. Total
 * over `AgentHandlerKey`, so a socket verb that gains no catalog key and no
 * handler does not compile, and neither does a handler for a key the map
 * does not hold.
 */
export const AGENT_VERB_HANDLERS: { readonly [Key in AgentHandlerKey]: AgentVerbHandler } = {
  identify: identifyVerb,
  board: boardVerb,
  "ticket.list": ticketListVerb,
  "ticket.show": ticketShowVerb,
  "ticket.events": ticketEventsVerb,
  "ticket.signal": ticketSignalVerb,
  "ticket.brief": ticketBriefVerb,
  "worktree.status": worktreeStatusVerb,
  "worktree.diff": worktreeDiffVerb,
  "worktree.sync": worktreeSyncVerb,
  conflicts: conflictsVerb,
  "project.list": projectListVerb,
  "project.add": projectAddVerb,
  "label.list": labelListVerb,
  "label.merge": labelMergeVerb,
  "model.list": modelListVerb,
  cost: costVerb,
  "session.start": sessionStartVerb,
  "session.done": sessionDoneVerb,
  "session.blocked": sessionBlockedVerb,
  "session.link": sessionLinkVerb,
  "session.harness": sessionHarnessVerb,
  notify: notifyVerb,
  hook: hookVerb,
  doctor: doctorVerb,
  "prompt.baseline": promptBaselineVerb,
};

/** What a verb's context holds for the service's lifetime: everything but the request's facts. */
export type AgentVerbServiceState = Omit<
  AgentVerbContext,
  keyof Omit<AgentVerbInput, "request"> | "loadProjections" | "loadSessions"
>;

/**
 * Every project's Sessions, lazy and memoized (VC-403): nothing is folded
 * until a handler calls `loadProjections()` or `loadSessions()`, and calling
 * either twice (or both: `loadSessions` is built on `loadProjections`) still
 * folds once. A verb that never calls either pays nothing.
 */
export function rosterLoaders(
  sessionEngine: SessionEngine,
  projects: readonly { readonly id: string }[],
): Pick<AgentVerbContext, "loadProjections" | "loadSessions"> {
  let projectionsPromise: Promise<readonly SessionProjection[]> | null = null;
  const loadProjections = (): Promise<readonly SessionProjection[]> => {
    projectionsPromise ??= (async () =>
      (
        await Promise.all(
          projects.map((project) =>
            sessionEngine.listSessions({ projectId: project.id, scope: "all" }),
          ),
        )
      ).flat())();
    return projectionsPromise;
  };
  let sessionsPromise: Promise<readonly SessionRecord[]> | null = null;
  // The terminal half of `loadProjections`'s answer: the verbs that need a
  // PTY (resume, rename, the terminal half of list) have nothing a
  // structured-only Session can answer, and dropping it there is correct,
  // not a compatibility gap.
  const loadSessions = (): Promise<readonly SessionRecord[]> => {
    sessionsPromise ??= loadProjections().then((projections) =>
      projections.flatMap((projection) => terminalSessionRecord(projection) ?? []),
    );
    return sessionsPromise;
  };
  return { loadProjections, loadSessions };
}

/**
 * The map's entries for every agent key, over one service's state: each
 * builds its verb's context from that state and the request the door
 * resolved, then runs the verb. What the agent command service serves.
 */
export function agentVerbEntries(
  state: AgentVerbServiceState,
): Pick<HostHandlers, AgentHandlerKey> {
  const entries: Partial<Record<AgentHandlerKey, HostHandlers[AgentHandlerKey]>> = {};
  for (const key of Object.keys(AGENT_VERB_HANDLERS) as AgentHandlerKey[]) {
    const handle = AGENT_VERB_HANDLERS[key];
    entries[key] = (input) =>
      handle(
        {
          ...state,
          ...rosterLoaders(state.sessionEngine, input.projects),
          projects: input.projects,
          envSession: input.envSession,
          envSessionTerminal: input.envSessionTerminal,
          authenticatedSessionId: input.authenticatedSessionId,
          actor: input.actor,
        },
        input.request,
      );
  }
  return entries as Pick<HostHandlers, AgentHandlerKey>;
}
