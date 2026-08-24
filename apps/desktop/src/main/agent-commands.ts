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
 *
 * It remains the door's one public face. `index.ts` and the tests import from
 * here, and the two Brief compositions are re-exported rather than moved,
 * because the Pi Agent Runtime is handed the same strings the verbs are and a
 * second import path would be a second place to look for one answer.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { AGENT_COMMAND_BINDINGS } from "@volli/shared";
import type { AgentResponse } from "@volli/shared";

import { AGENT_VERB_TABLE } from "./agent-dispatch/table";
import type { AgentCommandContext, EnvSessionIdentity } from "./agent-dispatch/context";
import { agentCommandPreflight } from "./agent-dispatch/preview";
import { listProjects } from "./db/projects-repo";
import { terminalSessionRecord } from "./session-control";
import { runGitCapturing } from "./worktree";

export { composeProjectBrief, composeTicketBrief } from "./agent-dispatch/briefs";
export { CHAT_PEEK_ENTRIES } from "./agent-dispatch/session-verbs";
export type { AgentCommandService, AgentCommandServiceOptions } from "./agent-dispatch/context";

import type { AgentCommandService, AgentCommandServiceOptions } from "./agent-dispatch/context";

export function createAgentCommandService(
  options: AgentCommandServiceOptions,
): AgentCommandService {
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
  const git = options.git ?? runGitCapturing;
  const worktreeExists = options.worktreeExists ?? existsSync;
  const sessionEngine = options.sessionEngine;
  const terminalUpdateLocks = new Map<string, Promise<void>>();

  return {
    async execute(request): Promise<AgentResponse> {
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
      const projects = listProjects(options.db);
      // Every Session of every project, folded once — unless this verb's entry
      // declares it takes no snapshot. `sessions` narrows it to the terminal
      // rows: the verbs that need a PTY (resume, rename, the terminal half of
      // list) have nothing a structured-only Session can answer, and dropping
      // it there is correct, not a compatibility gap. Identity questions — who
      // is `VOLLI_SESSION` — are answered by `envSession` below instead.
      const projections =
        binding.projections === "skip"
          ? []
          : (
              await Promise.all(
                projects.map((project) =>
                  sessionEngine.listSessions({ projectId: project.id, scope: "all" }),
                ),
              )
            ).flat();
      const sessions = projections.flatMap((projection) => terminalSessionRecord(projection) ?? []);
      // The `VOLLI_SESSION` identity rung, resolved against the Session Engine
      // rather than the terminal-only snapshot above: a structured (chat)
      // Session exports `VOLLI_SESSION` too (VC-51), and it has no terminal
      // attachment for `terminalSessionRecord` to answer with.
      const envSessionId = request.ctx.env.session;
      let envSession: EnvSessionIdentity | null = null;
      if (envSessionId !== undefined && binding.envSession === "resolve") {
        const projection = await sessionEngine.getSession({ sessionId: envSessionId });
        if (projection !== null) {
          envSession = {
            id: projection.session.id,
            projectId: projection.session.projectId,
            ticketId: projection.session.ticketId,
          };
        }
      }
      const context: AgentCommandContext = {
        options,
        now,
        newId,
        git,
        worktreeExists,
        sessionEngine,
        watermarks,
        terminalUpdateLocks,
        projects,
        projections,
        sessions,
        envSession,
      };
      return binding.handle(context, request);
    },
  };
}
