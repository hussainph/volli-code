/**
 * The agent socket's command service: what answers a `volli` request.
 *
 * This file used to BE the dispatch — one `execute` closure holding a
 * sequential `if (request.cmd === …)` chain over local state every branch
 * could reach. VC-167 decomposed it: one named handler per verb, in the domain
 * modules under `agent-dispatch/`, resolved through a table keyed by the Verb
 * Registry's own handler binding. What is left here is the part that is the
 * same for every verb — list the projects, resolve what this verb's table
 * entry asks for, call it — plus the seams the composition root injects.
 * "Call it" is the map's (VC-923): every verb's handler is an entry of the
 * host's handler map, and this service serves its own verbs' entries, and the
 * Session reads' (VC-894), into the map it is handed (`agent-dispatch/verbs.ts`).
 *
 * It remains the door's one public face. `index.ts` and the tests import from
 * here, and the two Brief compositions are re-exported rather than moved,
 * because the Pi Agent Runtime is handed the same strings the verbs are and a
 * second import path would be a second place to look for one answer.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import {
  AGENT_COMMAND_BINDINGS,
  SERVED_AGENT_HANDLER_KEYS,
  verbEntry,
  makeAgentError,
} from "@volli/shared";
import type { AgentRequest, AgentResponse, SessionRecord, TicketEventActor } from "@volli/shared";

import { doorCallActor, projectedHandlerKey } from "./agent-dispatch/projection";
import { AGENT_VERB_TABLE } from "./agent-dispatch/table";
import { cloudBoardVerbOf } from "./cloud-agent/board-verbs";
import { coordinationRefusal, socketHandlerPolicy } from "./agent-dispatch/admission";
import { isHostHandlerMap, serveHostHandlers } from "./handlers/handler-map";
import { agentVerbEntries, rosterLoaders, sessionReadEntries } from "./agent-dispatch/verbs";
import type {
  AgentCommandContext,
  EnvSessionIdentity,
  PendingHarnessLaunch,
} from "./agent-dispatch/context";
import { agentCommandPreflight } from "./agent-dispatch/preview";
import { doorActor, requestActor } from "./agent-dispatch/resolution";
import type { DoorActor } from "./agent-dispatch/resolution";
import { getProjectAuthorityPolicy, listProjects } from "./db/projects-repo";
import { terminalSessionRecord } from "./session-control";
import { runGitCapturingAsync } from "./worktree";
import { createWorktreeReadService } from "./worktree-reads";

export {
  composeProjectBrief,
  composeSubagentBrief,
  composeTicketBrief,
} from "./agent-dispatch/briefs";
export { CHAT_PEEK_ENTRIES } from "./agent-dispatch/session-verbs";
export type { AgentCommandService, AgentCommandServiceOptions } from "./agent-dispatch/context";

import type { AgentCommandService, AgentCommandServiceOptions } from "./agent-dispatch/context";

/** The agent doors' own verbs: keys no door but the one serving them reaches. */
const SERVED_AGENT_KEYS: ReadonlySet<string> = new Set(SERVED_AGENT_HANDLER_KEYS);

export function createAgentCommandService(
  options: AgentCommandServiceOptions,
): AgentCommandService {
  // JS callers must fail closed too: without the map there is no move, and
  // a socket that answered one some other way would be a second handler.
  if (!isHostHandlerMap(options.handlers)) {
    throw new Error("The host's handler map is required.");
  }
  const now = options.now ?? Date.now;
  /**
   * The newest fire-time main has ingested per session — the same watermark the
   * renderer keeps on its own `SessionHarnessState`, kept here too because main
   * does two things the renderer never sees: it writes the resume seed, and it
   * fires the one claim that cannot be taken back once it has interrupted a
   * human. Neither may act on a delivery a newer one has already answered.
   *
   * In memory rather than in the db, deliberately. A watermark is worth
   * something only while a session is live and firing; it is worth nothing after
   * a restart, when a surviving row would order today's events against a process
   * that no longer exists; and it is not worth a write per hook on the hottest
   * involuntary path in the app. Losing one degrades that session to arrival
   * order for one event, which is what every event got before this existed.
   */
  const watermarks = new Map<string, number>();
  // node:crypto's randomUUID is a standalone function (safe to reference
  // detached); the global `crypto.randomUUID` would lose its Crypto `this` when
  // called via this alias and throw "Value of 'this' must be of type Crypto".
  const newId = options.newId ?? randomUUID;
  // Keep the default physically asynchronous: every worktree verb this door
  // serves runs on it, and there is no synchronous runner to fall back to.
  const gitAsync = options.gitAsync ?? runGitCapturingAsync;
  const worktreeExists = options.worktreeExists ?? existsSync;
  const worktreeReads =
    options.worktreeReads ??
    createWorktreeReadService({
      deps: () => ({
        db: options.db,
        gitAsync,
        worktreeExists,
        machinePaths: options.cloudWorktreeTickets?.machinePaths,
      }),
    });
  const sessionEngine = options.sessionEngine;
  const terminalUpdateLocks = new Map<string, Promise<void>>();
  /**
   * The launch each Session's wrapper minted an id for that has not yet proved
   * itself (VC-807). In memory, like the watermarks: a pending launch is worth
   * something for the second or so between a wrapper's mint and the harness's
   * own startup hook, and a restart in between costs that one launch its
   * promotion — its hooks still write the seed they report.
   */
  const pendingLaunches = new Map<string, PendingHarnessLaunch>();
  /**
   * How this door decides whether `VOLLI_SESSION` is a claim or an
   * authentication (VC-163).
   *
   * Injected, because the registry's minting half lives with the attachments —
   * the PTY manager and the Pi adapter — and only the composition root sees
   * both. Absent (tests, and any launch that wired no attachments) means no
   * token can verify, so every socket caller is the unauthenticated actor and
   * may read but not write. That is the fail-closed default, and it is the
   * right one: a door that cannot check credentials must not assume good ones.
   */
  const verifyToken = options.verifySessionToken ?? (() => null);
  /**
   * Where the admission gate reads a project's authority policy (VC-163).
   *
   * Defaulted from this service's own database rather than required, because
   * the store is this host's private materialization and every caller already
   * hands one in. The seam exists so `admission.ts` holds no store at all: the
   * same judgement has to run in whatever host serves the External Agent
   * Surface, and that host's policy will not live in this SQLite file.
   */
  const readPolicy =
    options.readAuthorityPolicy ??
    ((projectId: string) => getProjectAuthorityPolicy(options.db, projectId));

  // The socket's own verbs are entries of the map (VC-923), and so are its
  // Session reads (VC-894), over this service's state: served once, now, so
  // every door that projects the map (this socket, and a router's
  // Workspace-scoped reads) reaches them through it, under that door's policy.
  const verbState = {
    options,
    now,
    newId,
    gitAsync,
    worktreeExists,
    worktreeReads,
    sessionEngine,
    watermarks,
    terminalUpdateLocks,
    pendingLaunches,
  };
  serveHostHandlers(options.handlers, {
    ...agentVerbEntries(verbState),
    ...sessionReadEntries(verbState),
  });

  const service = {
    /** One request, through the one pipeline. */
    async execute(request: AgentRequest): Promise<AgentResponse> {
      // Both answers below precede every read: a preview must be refused before
      // the work that would perform it, and a capability probe must not be able
      // to fail for a reason that has nothing to do with the capability.
      const preflight = agentCommandPreflight(options.appVersion, request);
      if (preflight !== null) return preflight;
      // The registry's declaration DRIVING the dispatch, rather than being
      // checked against it: the wire name resolves to the binding id its entry
      // declares, and that id resolves to the one handler bound to it. There is
      // no `UNSUPPORTED_COMMAND` arm left to reach — the table is total over
      // every id the socket projects, and the socket refuses a command outside
      // that vocabulary before `execute` is ever called.
      const binding = AGENT_VERB_TABLE[AGENT_COMMAND_BINDINGS[request.cmd]];
      // Identity first, and it costs a map lookup: no database, no Session
      // Engine. That is what lets the `hook` hot path be judged without paying
      // for the identity resolution its table entry deliberately skips.
      const door = doorActor(request, verifyToken, options.verifyOperatorToken);
      if (verbEntry(request.cmd)?.operatorCli === true && door.kind !== "operator") {
        return {
          v: 1,
          ok: false,
          error: makeAgentError(
            "WRONG_DOOR",
            "Agents start Sessions through the named session_start tool. This CLI door requires a verified hostd operator token.",
          ),
        };
      }
      // Machine identity only: a cloud launch's store names its owner's
      // projects, whose shadow identities this host's own list leaves out.
      const projects = options.projects?.() ?? listProjects(options.db);
      // Every Session of every project — lazy and memoized (VC-403). Nothing
      // is folded until a handler calls `context.loadProjections()` or
      // `context.loadSessions()`. This replaced an eager fold gated by a
      // per-verb table policy: laziness now makes the opt-out automatic for
      // any verb that never calls either loader, which is most of them.
      // Identity questions — who is `VOLLI_SESSION` — are answered by
      // `envSession` below instead, off its own single-Session lookup rather
      // than this fold.
      const { loadProjections, loadSessions } = rosterLoaders(sessionEngine, projects);
      // The `VOLLI_SESSION` identity rung, resolved against the Session Engine
      // rather than the fleet fold above: a structured (chat) Session exports
      // `VOLLI_SESSION` too (VC-51), and it has no terminal attachment for
      // `terminalSessionRecord` to answer with.
      // The token's own Session when the caller sent one, falling back to the
      // bare `VOLLI_SESSION` claim otherwise (VC-163). Token first because it
      // is the stronger statement: it NAMES the Session rather than asserting
      // one, so a caller that presents a token and no claim is fully resolved
      // rather than left half-authenticated.
      const envSessionId = door.kind === "session" ? door.sessionId : request.ctx.env.session;
      let envSession: EnvSessionIdentity | null = null;
      // `identify` needs only this one Session's terminal facts (VC-403): its
      // `cwd`, resolved from the SAME `getSession` call below rather than a
      // fold of the whole fleet just to find one row in it.
      let envSessionTerminal: SessionRecord | null = null;
      if (envSessionId !== undefined && binding.envSession === "resolve") {
        const projection = await sessionEngine.getSession({ sessionId: envSessionId });
        if (projection !== null) {
          envSession = {
            id: projection.session.id,
            projectId: projection.session.projectId,
            ticketId: projection.session.ticketId,
            role: projection.session.role,
          };
          envSessionTerminal = terminalSessionRecord(projection);
        }
      }
      // Admission, before any handler runs (VC-163). This used to live inside
      // the verbs, which meant a verb could forget it. Here nothing can: every
      // request passes through this line, and the gate reads the verb's own
      // registry declaration, so a verb added later is judged by what it
      // declares rather than by whether someone remembered to list it.
      const refusal = coordinationRefusal(readPolicy, projects, envSession, request, door);
      if (refusal !== null) return auditOperatorWrite(door, request, refusal);
      // A cloud launch's board (VC-894): the backend answers, acting for the
      // Session this door verified, never for a claim it could not.
      const cloudVerb = cloudBoardVerbOf(
        options.cloudBoardVerbs,
        AGENT_COMMAND_BINDINGS[request.cmd],
      );
      if (cloudVerb !== null) {
        return auditOperatorWrite(
          door,
          request,
          await cloudVerb({ sessionId: door.kind === "session" ? door.sessionId : null, request }),
        );
      }
      // Attribution is resolved only for a verb that will WRITE attributed
      // history — a coordination verb whose table entry also resolved the
      // identity. Both halves of that condition are load-bearing:
      //
      // - A READ verb must not be refused for attribution it never uses. Its
      //   caller may be anonymous by design, so failing one because a token's
      //   Session has since ended would refuse a read that an unauthenticated
      //   caller would have been served.
      // - The three verbs that skip identity resolution (`hook`,
      //   `session.link`, `session.harness`) resolve their own terminal record
      //   and write no ticket history, so they need no attribution either.
      let actor: TicketEventActor | null = null;
      const writer = verbEntry(request.cmd)?.actor;
      if (binding.envSession === "resolve" && (writer === "session" || writer === "user")) {
        const resolved = requestActor(door, envSession);
        if (!resolved.ok) return resolved.response;
        actor = resolved.actor;
      }
      const projected = projectedHandlerKey(binding);
      const context: AgentCommandContext = {
        options,
        now,
        newId,
        gitAsync,
        worktreeExists,
        worktreeReads,
        sessionEngine,
        watermarks,
        terminalUpdateLocks,
        pendingLaunches,
        projects,
        loadProjections,
        loadSessions,
        envSession,
        envSessionTerminal,
        authenticatedSessionId: door.kind === "session" ? door.sessionId : null,
        actor,
        doorActor: doorCallActor(door, envSession),
        handlerPolicy: socketHandlerPolicy(
          request,
          projected,
          // A key other doors also reach (a catalog or board command) is judged
          // again at the map. One of this socket's own verbs is reachable
          // through no other door (the catalog's policies refuse it), and its
          // map call follows this line with no await between, over a
          // synchronous store: the verdict above is the map's, so the hot path
          // (`hook`) reads its project's policy once, as it always has.
          projected !== undefined && SERVED_AGENT_KEYS.has(projected)
            ? () => null
            : () => coordinationRefusal(readPolicy, projects, envSession, request, door),
        ),
      };
      return auditOperatorWrite(door, request, await binding.handle(context, request));
    },
  };
  return service;

  /**
   * Reports an operator's write to the host's audit line (VC-623), and hands
   * the response back untouched. A read is not reported: the audit is of what
   * the person CHANGED, and a busy operator's `ticket list` is not that.
   */
  function auditOperatorWrite(
    door: DoorActor,
    request: AgentRequest,
    response: AgentResponse,
  ): AgentResponse {
    if (door.kind === "operator" && verbEntry(request.cmd)?.actor !== "any") {
      options.onOperatorWrite?.({
        login: door.login,
        cmd: request.cmd,
        ok: response.ok,
        code: response.ok ? null : response.error.code,
      });
    }
    return response;
  }
}
