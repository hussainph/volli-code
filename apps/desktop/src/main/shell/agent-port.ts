/**
 * The desktop's answer to {@link RuntimeShellPort} (VC-270): one Session's
 * background shell capability over the one {@link BackgroundShellHost},
 * scoped before the model ever speaks — the shell half of
 * `browser/agent-port.ts`.
 *
 * Scope is the whole of the ownership policy: a shell belongs to the Session
 * that started it, and nothing another Session started is visible here, a
 * subagent's parent included. The host judges every read and kill against
 * the Session; this port only states who is asking, from the attachment the
 * adapter resolved and never from anything the model said.
 *
 * Two things the port decides that the host cannot:
 *
 * - **Where a shell runs.** `cwd` defaults to the Session workspace and must
 *   stay inside it, by the same containment rule the authority pack's
 *   `path.outside-workspace` uses (`containsPath`, exported for exactly this
 *   caller). Refused as `shell.cwd` before anything is spawned.
 *
 * - **What a shell is handed.** The environment is
 *   {@link sessionCommandEnvironment}'s record over the identity the host
 *   built ONCE for this attachment and hands to the `execute` tool as well —
 *   so the `VOLLI_SESSION_TOKEN` a background shell exports is the token the
 *   socket door accepts, not a second mint that would have retired it.
 *
 * Everything here throws {@link ShellRefusal} for judged outcomes and plain
 * errors for broken plumbing; the runtime's tools translate the former into
 * readable text and let the latter fail the call, exactly as the browser and
 * web ports do.
 */

import { isAbsolute, resolve } from "node:path";

import {
  sessionCommandEnvironment,
  ShellRefusal,
  type PiSessionEnvIdentity,
} from "@volli/agent-runtime";
import { containsPath, type RuntimeShellPort } from "@volli/shared";

import type { BackgroundShellHost, BackgroundShellOwner } from "./background-shell-host";

/** The port as the desktop builds it: the runtime's, with `dispose` always present. */
export interface AgentShellPort extends RuntimeShellPort {
  dispose(): void;
}

export interface AgentShellPortOptions {
  host: Pick<BackgroundShellHost, "start" | "read" | "kill" | "list" | "disposeSession">;
  /** The Session's product scope, fixed at attachment and never the model's to name. */
  scope: { projectId: string; ticketId: string | null };
  /** Who this port serves: the Session and the attachment it runs under. */
  session: { sessionId: string; attachmentId: string };
  /** The directory the Session Engine prepared; every shell runs inside it. */
  workspacePath: string;
  /**
   * The attachment's identity, built once by main and shared with the
   * `execute` tool's environment. Handed in, never minted here — see the
   * module comment for why a second mint would break the first.
   */
  identity: PiSessionEnvIdentity;
  /** The PATH prefixes the `execute` tool's environment gets; the same list. */
  pathPrefixes: readonly string[];
  /**
   * This Session's concurrency budget (VC-339), asked for at each start rather
   * than captured here: a background shell is the long-running heavy thing on
   * the machine — a test run, a watch build — so the number it self-limits by
   * should be the one that was true when it started, not when the Session
   * attached. Omitted by a caller that has no budget to state, which leaves
   * every toolchain on its own default.
   */
  concurrencyEnv?: () => Promise<Record<string, string>>;
}

export function createAgentShellPort(options: AgentShellPortOptions): AgentShellPort {
  const owner: BackgroundShellOwner = {
    sessionId: options.session.sessionId,
    attachmentId: options.session.attachmentId,
    projectId: options.scope.projectId,
    ticketId: options.scope.ticketId,
  };
  const workspace = resolve(options.workspacePath);

  /** The directory a start runs in: the workspace, or a place inside it. */
  const cwdOf = (requested: string | undefined): string => {
    if (requested === undefined) return workspace;
    const candidate = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
    if (!containsPath(workspace, candidate)) {
      throw new ShellRefusal(
        "shell.cwd",
        `A background shell runs inside the Session workspace (${workspace}); ${JSON.stringify(requested)} is outside it. Omit cwd, or name a directory under the workspace.`,
      );
    }
    return candidate;
  };

  const shells = () => options.host.list(owner.sessionId);

  return {
    start: async (input) => {
      input.signal.throwIfAborted();
      const cwd = cwdOf(input.cwd);
      // Built at the spawn, as `exec` builds its own at every call, so a
      // PATH adopted after attach reaches the next shell the way it reaches
      // the next execute.
      const env = sessionCommandEnvironment(process.env, {
        identity: options.identity,
        pathPrefixes: options.pathPrefixes,
        environment: (await options.concurrencyEnv?.()) ?? {},
      });
      const started = await options.host.start(owner, {
        command: input.command,
        cwd,
        title: input.title ?? null,
        env,
      });
      return { ...started, shells: shells() };
    },
    output: async (input) => {
      input.signal.throwIfAborted();
      const read = options.host.read(owner, input.shellId, input.tail);
      return { ...read, shells: shells() };
    },
    kill: async (input) => {
      input.signal.throwIfAborted();
      const killed = await options.host.kill(owner, input.shellId);
      return { ...killed, shells: shells() };
    },
    dispose: () => {
      options.host.disposeSession(owner.sessionId);
    },
  };
}
