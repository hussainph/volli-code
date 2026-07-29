/**
 * `volli hook <harness> <event>` — the involuntary channel's client half.
 *
 * Fired by a hook the launch wrapper configured, never typed by an agent, and
 * so deliberately absent from `volli help`: a reference entry would invite an
 * agent to report an event that did not happen.
 *
 * Two properties matter more than anything it reports. It costs a harness
 * running OUTSIDE Volli nothing — no socket, no stdin, no work at all — and it
 * can never break the agent it fired from: every failure, timeout, unreachable
 * socket and malformed payload exits 0 in silence. Exit codes carry meaning to
 * a harness (Claude Code reads 2 as "block this action"), so leaking a nonzero
 * one by accident would let a dead Volli wedge a live agent.
 *
 * Main is the authority on the canonical event vocabulary; this forwards what
 * it was given and lets that one door refuse. A second refusal here would be a
 * second copy of the union to drift from.
 */
import { harnessAdapters } from "@volli/shared";
import type { AgentRequest, AgentResponse } from "@volli/shared";

/**
 * The shortest timeout any adapter declares for a hook binding, read off the
 * adapters themselves. A copied number would drift the moment a harness bound
 * an event on a tighter one, and the drift is invisible: the hook keeps working
 * everywhere except against the harness that shortened it.
 *
 * The built-ins are what is visible from here. A registered manifest that
 * declares something tighter is its author's own budget to keep — reading
 * manifests on the hook path would spend more of it than the number could save.
 */
export const SHORTEST_DECLARED_HOOK_TIMEOUT_MS = Math.min(
  ...harnessAdapters.flatMap((adapter) => adapter.events.map((binding) => binding.timeoutMs)),
);

/**
 * What one invocation may spend in total, from the moment the process started.
 *
 * Half the declared floor, because everything here is charged against the same
 * clock the harness is watching and most of it is not ours to shorten: an
 * `ELECTRON_RUN_AS_NODE` boot before the first line runs, then a stdin read,
 * then the socket. Budgeting only the socket call is how three "fast enough"
 * steps add up to a hook the harness kills — which the user sees as a timeout
 * error from their agent instead of nothing at all.
 */
const HOOK_BUDGET_MS = Math.floor(SHORTEST_DECLARED_HOOK_TIMEOUT_MS / 2);

/**
 * The share of the remaining budget stdin may take. A payload is worth only the
 * session id correlation it might carry, so it never spends so much that the
 * report it would enrich can no longer be sent.
 */
const STDIN_BUDGET_SHARE = 0.4;

/**
 * The key spellings a harness gives its own session id, observed in live
 * payloads rather than taken from documentation. Matched by name instead of by
 * harness identity, so a registered harness whose payload speaks any of these
 * correlates for free.
 */
const SESSION_ID_KEYS = [
  "session_id",
  "sessionId",
  "sessionID",
  "thread-id",
  "thread_id",
  "threadId",
  "conversation_id",
] as const;

interface HookInvocation {
  harness: string;
  event: string;
  /** From `--socket`; `null` falls back to the session's `VOLLI_SOCKET`. */
  socketPath: string | null;
  /**
   * The payload as a trailing argument — codex's legacy `notify` key appends
   * its JSON to argv rather than writing stdin. `null` means read stdin.
   */
  payload: string | null;
}

/**
 * `<harness> <event> [--socket <path>] [<payload>]`. Returns `null` when the
 * two positionals aren't both there, which the caller treats as nothing to
 * report rather than as an error worth telling anyone about.
 */
function parseHookArgs(rest: readonly string[]): HookInvocation | null {
  const positional: string[] = [];
  let socketPath: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--socket") {
      const value = rest[index + 1];
      if (value === undefined) return null;
      socketPath = value;
      index += 1;
      continue;
    }
    // An unrecognized flag is skipped, not refused: a harness may add its own,
    // and a hook that stopped reporting over one would be a silent regression.
    if (token.startsWith("--")) continue;
    positional.push(token);
  }
  const [harness, event, payload] = positional;
  if (harness === undefined || event === undefined) return null;
  return { harness, event, socketPath, payload: payload ?? null };
}

/** The harness's own session id, if the payload names it under any known spelling. */
function harnessSessionIdFrom(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  for (const key of SESSION_ID_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export interface HookDependencies {
  env: Readonly<Record<string, string | undefined>>;
  /**
   * The directory the hook fired in. A function rather than a value, because
   * resolving it can throw: a session's worktree is deletable under a live PTY,
   * and `process.cwd()` then fails with ENOENT. Evaluated inside the report,
   * where every other failure already lands.
   */
  cwd(): string;
  /** Milliseconds since this process started — boot included, since the harness counts it. */
  elapsedMs(): number;
  /** The hook payload, for the harnesses that deliver it on stdin. Bounded by `timeoutMs`. */
  readStdin(timeoutMs: number): Promise<string>;
  request(
    socketPath: string,
    request: AgentRequest,
    options?: { timeoutMs?: number },
  ): Promise<AgentResponse>;
}

/**
 * Where the hook fired, or `""` when that directory no longer exists. The
 * session id is the addressing — main resolves the event off `VOLLI_SESSION`
 * and never reads this — so a deleted worktree costs the report a field nobody
 * consults, and must not cost it the report.
 */
function currentDirectory(deps: HookDependencies): string {
  try {
    return deps.cwd();
  } catch {
    return "";
  }
}

/**
 * Runs one hook invocation. Always resolves 0 — the return type says so,
 * because "this can only succeed" is the contract, not an implementation
 * detail.
 */
export async function runHook(rest: readonly string[], deps: HookDependencies): Promise<0> {
  // The fast no-op, and it comes first: a harness invoked from a normal
  // terminal has no VOLLI_SESSION, and must not pay for a socket it will never
  // reach or a stdin nobody wrote.
  const session = deps.env["VOLLI_SESSION"];
  if (session === undefined || session.length === 0) return 0;
  try {
    const invocation = parseHookArgs(rest);
    if (invocation === null) return 0;
    const socketPath = invocation.socketPath ?? deps.env["VOLLI_SOCKET"];
    if (socketPath === undefined || socketPath.length === 0) return 0;
    const remainingMs = (): number => HOOK_BUDGET_MS - deps.elapsedMs();
    // Boot alone can outlast the budget on a cold machine. Reporting then would
    // land after the harness had given up, so it is not reported at all.
    if (remainingMs() <= 0) return 0;
    const payload =
      invocation.payload ?? (await deps.readStdin(Math.floor(remainingMs() * STDIN_BUDGET_SHARE)));
    const harnessSessionId = harnessSessionIdFrom(payload);
    const requestMs = remainingMs();
    if (requestMs <= 0) return 0;
    await deps.request(
      socketPath,
      {
        v: 1,
        cmd: "hook",
        args: {
          harness: invocation.harness,
          event: invocation.event,
          ...(harnessSessionId === null ? {} : { harnessSessionId }),
        },
        ctx: { cwd: currentDirectory(deps), env: { socket: socketPath, session } },
      },
      { timeoutMs: requestMs },
    );
  } catch {
    // Deliberately silent, on stdout and stderr alike. A dead Volli, a broken
    // socket, or a payload we could not read must be indistinguishable to the
    // harness from a hook that had nothing to say.
  }
  return 0;
}
