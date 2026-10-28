/**
 * The agent socket's own verbs as entries of the host's handler map (VC-923).
 *
 * Every socket verb that is neither a catalog command nor a ticket write
 * projected onto a board key is its own key on the map (`AgentHandlerKey`),
 * and {@link AGENT_VERB_HANDLERS} is what answers each one but the start
 * (the map's own command, shared with the Agent Tool Surface): the verb's handler,
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
 *
 * The socket's Session reads are served the same way ({@link sessionReadEntries},
 * VC-894), though they are catalog keys: a router reaches them too, with a
 * Workspace their roster is forced to (VC-663, D4). Their entry is the one
 * implementation behind both doors, so the socket's binding is a projection
 * of it like every other verb's, and a cloud launch's overlay has one entry
 * to take each read over at.
 */

import { SESSION_READ_VERBS } from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  SessionProjection,
  SessionReadVerb,
  SessionRecord,
} from "@volli/shared";
import type { SessionEngine } from "@volli/session-engine";

import { listProjects } from "../db/projects-repo";
import type {
  HostHandlers,
  SessionReadHandlerInput,
  SessionReadWorkspaceInput,
  SocketServedKey,
} from "../handlers/host-handlers";
import { terminalSessionRecord } from "../session-control";
import type { AgentVerbContext, AgentVerbHandler, AgentVerbInput } from "./context";
import { doctorVerb, modelListVerb, notifyVerb, promptBaselineVerb } from "./app-verbs";
import { conflictsVerb } from "./conflicts-verb";
import { costVerb } from "./cost-verb";
import { hookVerb, sessionHarnessVerb, sessionLinkVerb } from "./harness-verbs";
import { labelMergeVerb } from "./label-verbs";
import { agentCommandPreflight } from "./preview";
import { projectAddVerb } from "./project-verbs";
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
import {
  sessionAnswerVerb,
  sessionBlockedVerb,
  sessionDoneVerb,
  sessionListVerb,
  sessionPeekVerb,
  sessionShowVerb,
} from "./session-verbs";
import { ticketSignalVerb } from "./ticket-verbs";
import { worktreeDiffVerb, worktreeStatusVerb, worktreeSyncVerb } from "./worktree-verbs";

/**
 * Each of the socket's own verbs' handlers, in the Verb Registry's
 * declaration order. Total over the socket's served keys, so a socket verb
 * that gains no catalog key and no handler does not compile, and neither does
 * a handler for a key the map does not hold. `session.start` is not here: the
 * person's operator start and the named tool share the map's own start
 * command, which the table projects.
 */
const AGENT_VERB_HANDLERS: { readonly [Key in SocketServedKey]: AgentVerbHandler } = {
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
): Pick<HostHandlers, SocketServedKey> {
  const entries: Partial<Record<SocketServedKey, HostHandlers[SocketServedKey]>> = {};
  for (const key of Object.keys(AGENT_VERB_HANDLERS) as SocketServedKey[]) {
    const handle = AGENT_VERB_HANDLERS[key];
    entries[key] = async (input) => {
      const cloud = await state.options.cloudSessionVerbs?.socket({
        sessionId: input.authenticatedSessionId,
        request: input.request,
      });
      return cloud ?? handle(verbContext(state, input), input.request);
    };
  }
  return entries as Pick<HostHandlers, SocketServedKey>;
}

/**
 * The socket's Session reads' handlers (VC-79, VC-9, VC-663): the verbs the
 * socket used to bind as handlers of its own, unchanged, now behind the map's
 * one entry for each.
 */
const SESSION_READ_HANDLERS: { readonly [Key in SessionReadVerb]: AgentVerbHandler } = {
  "session.list": sessionListVerb,
  "session.show": sessionShowVerb,
  "session.peek": sessionPeekVerb,
  "session.answer": sessionAnswerVerb,
};

/**
 * The map's entries for the socket's Session reads (VC-894), over one
 * service's state. The socket asks one with the request it resolved, as it
 * asks its own verbs; a router asks with the Workspace the roster is forced
 * to ({@link workspaceReadInput}). Either way the same verb runs.
 */
export function sessionReadEntries(
  state: AgentVerbServiceState,
): Pick<HostHandlers, SessionReadVerb> {
  const entries: Partial<Record<SessionReadVerb, HostHandlers[SessionReadVerb]>> = {};
  for (const key of SESSION_READ_VERBS) {
    const handle = SESSION_READ_HANDLERS[key];
    entries[key] = async (input: SessionReadHandlerInput): Promise<AgentResponse> => {
      const resolved = "request" in input ? input : workspaceReadInput(state, key, input);
      if (!("request" in resolved)) return resolved;
      // Only a verified agent call can borrow its Session-scoped grant. The
      // frozen person's router has no Agent identity; cloud clients read Convex directly.
      const cloud =
        "request" in input
          ? await state.options.cloudSessionVerbs?.socket({
              sessionId: input.authenticatedSessionId,
              request: input.request,
            })
          : null;
      return cloud ?? handle(verbContext(state, resolved), resolved.request);
    };
  }
  return entries as Pick<HostHandlers, SessionReadVerb>;
}

/**
 * A router's read, as the socket would have resolved it (VC-663, D4): no
 * `VOLLI_SESSION`, no token, no cwd, because the router's actor was
 * authenticated by its own door and these reads need none of them; the
 * roster is that one project's, and the project is forced, never taken from
 * the caller: named by its path, the one selector no other project can
 * share. A Workspace this host does not have selects no project, so the
 * verb refuses it as it refuses any unknown project. The socket's preflight
 * runs first, as it did when this read went through the socket's pipeline.
 */
function workspaceReadInput(
  state: AgentVerbServiceState,
  verb: SessionReadVerb,
  { workspaceId, args }: SessionReadWorkspaceInput,
): AgentVerbInput | AgentResponse {
  const { db, appVersion } = state.options;
  const projects = (state.options.projects?.() ?? listProjects(db)).filter(
    (project) => project.id === workspaceId,
  );
  const request: AgentRequest = {
    v: 1,
    cmd: verb,
    args: { ...args, project: projects[0]?.path ?? workspaceId },
    ctx: { cwd: "/", env: {} },
  };
  const preflight = agentCommandPreflight(appVersion, request);
  if (preflight !== null) return preflight;
  return {
    request,
    projects,
    envSession: null,
    envSessionTerminal: null,
    authenticatedSessionId: null,
    actor: null,
  };
}

/** One verb's context: the service's state, and the request's facts as the door resolved them. */
function verbContext(state: AgentVerbServiceState, input: AgentVerbInput): AgentVerbContext {
  return {
    ...state,
    ...rosterLoaders(state.sessionEngine, input.projects),
    projects: input.projects,
    envSession: input.envSession,
    envSessionTerminal: input.envSessionTerminal,
    authenticatedSessionId: input.authenticatedSessionId,
    actor: input.actor,
  };
}
