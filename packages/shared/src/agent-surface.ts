/**
 * The agent socket's wire vocabulary: request and response shapes, the error
 * codes, the column tokens, and context resolution.
 *
 * The verbs it answers are NOT declared here. `AGENT_COMMANDS` and its
 * `AgentCommand` union are projections of the Verb Registry
 * (`verb-registry.ts`) — the one enumerable declaration of every agent-facing
 * verb, from which this socket surface, `volli help`, and the future Pi tool
 * array are all derived (VC-92 §5, built in VC-161). The standing discipline
 * that used to sit on the `AGENT_COMMANDS` declaration moved with it: the
 * dot-name is the verb's registry key and never changes, and adding a verb is
 * a tier decision made in the registry rather than retrofitted onto a bare
 * string.
 *
 * The import below is type-only, deliberately: the registry reads this module's
 * column vocabulary at load, so a value edge back would be a cycle.
 */

import type { TicketStatus } from "./ticket";
import type { AgentCommand } from "./verb-registry";

export const AGENT_ERROR_CODES = [
  "USAGE",
  "INVALID_REQUEST",
  "UNSUPPORTED_COMMAND",
  "WRONG_DOOR",
  // The verb exists on this surface and this caller may not run it (VC-163).
  // Distinct from WRONG_DOOR, which is about the SURFACE, and from every
  // not-found code, which is about the subject: this one is about the caller.
  "FORBIDDEN_ACTOR",
  "APP_UNREACHABLE",
  "DB_UNAVAILABLE",
  "PROJECT_REQUIRED",
  "PROJECT_NOT_FOUND",
  "AMBIGUOUS_PROJECT",
  "TICKET_NOT_FOUND",
  "AMBIGUOUS_TICKET",
  "SESSION_NOT_FOUND",
  "AMBIGUOUS_CONTEXT",
  "CONTEXT_REQUIRED",
  "CONTEXT_MISMATCH",
  "BODY_MATCH_FAILED",
  "INVALID_COLUMN",
  "INVALID_PRIORITY",
  "ARCHIVED_TICKET",
  "SESSION_ENDED",
  // `session start`'s model vocabulary: no configured default and no --model
  // override; and an override Model Access cannot honor (unknown model,
  // sign-in required, or an unsupported reasoning level).
  "MODEL_REQUIRED",
  "MODEL_UNAVAILABLE",
  "PREFIX_CONFLICT",
  "FILE_READ_FAILED",
  "MUTATION_FAILED",
  "SOCKET_PROTOCOL",
  "TIMEOUT",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentRequestContext {
  cwd: string;
  env: {
    session?: string;
    /**
     * `VOLLI_SESSION_TOKEN` — the per-attachment secret that turns `session`
     * from a claim into an authentication (VC-163).
     *
     * A separate field from `session` rather than a signed form of it, because
     * the two answer different questions and the door needs both: `session`
     * says which Session the caller means, and this says whether Volli issued
     * that name to this caller. A caller supplying one without the other is
     * the unauthenticated actor.
     */
    token?: string;
    ticket?: string;
    socket?: string;
  };
}

export interface AgentRequest {
  v: 1;
  cmd: AgentCommand;
  args: Record<string, unknown>;
  ctx: AgentRequestContext;
}

export interface AgentError {
  /** Stable automation vocabulary. */
  code: AgentErrorCode;
  /** Backward-compatible human message; `reason` may add missing-evidence detail. */
  message: string;
  /** What failed and why, without requiring an agent to parse `message`. */
  reason: string;
  /** One safe next action, or null when Volli lacks enough evidence to name one. */
  next: string | null;
}

export type AgentResponse =
  | { v: 1; ok: true; data: unknown }
  | { v: 1; ok: false; error: AgentError };

export const COLUMN_TOKENS = [
  "backlog",
  "todo",
  "doing",
  "needs-review",
  "review",
  "done",
] as const;

export type ColumnToken = (typeof COLUMN_TOKENS)[number];

/**
 * The single source of truth mapping each public column token to its domain
 * status. `review` is the friendly alias for `needs-review`. {@link COLUMN_TOKENS}
 * derives the accepted vocabulary from these keys, and {@link parseColumnToken}
 * reads its answer here — one vocabulary, no parallel list.
 */
const COLUMN_TOKEN_STATUS: Record<ColumnToken, TicketStatus> = {
  backlog: "backlog",
  todo: "todo",
  doing: "doing",
  "needs-review": "needs_review",
  review: "needs_review",
  done: "done",
};

/**
 * The accepted column vocabulary rendered for error/help text, with aliases of
 * the same status collapsed (`needs-review|review`). Derived from
 * {@link COLUMN_TOKENS} and {@link COLUMN_TOKEN_STATUS} so teaching errors can
 * never drift from what {@link parseColumnToken} accepts.
 */
export const COLUMN_VOCABULARY: string = (() => {
  const groups: string[] = [];
  const indexByStatus = new Map<TicketStatus, number>();
  for (const token of COLUMN_TOKENS) {
    const status = COLUMN_TOKEN_STATUS[token];
    const existing = indexByStatus.get(status);
    if (existing === undefined) {
      indexByStatus.set(status, groups.length);
      groups.push(token);
    } else {
      groups[existing] = `${groups[existing]}|${token}`;
    }
  }
  return groups.join(", ");
})();

export type ColumnTokenResult =
  | { ok: true; status: TicketStatus }
  | { ok: false; code: "INVALID_COLUMN"; message: string };

export function parseColumnToken(value: string): ColumnTokenResult {
  if ((COLUMN_TOKENS as readonly string[]).includes(value)) {
    return { ok: true, status: COLUMN_TOKEN_STATUS[value as ColumnToken] };
  }
  return {
    ok: false,
    code: "INVALID_COLUMN",
    message: `Unknown column ${JSON.stringify(value)} (valid: ${COLUMN_VOCABULARY})`,
  };
}

export interface AgentSurfaceProject {
  id: string;
  name: string;
  path: string;
  ticketPrefix: string;
  worktreePaths?: readonly string[];
}

export interface AgentSurfaceTicketRef {
  displayId: string;
  projectId: string;
}

export interface AgentSurfaceSessionRef {
  id: string;
  projectId: string;
  ticketDisplayId: string | null;
}

export interface AgentContextInput {
  explicit: { project?: string; ticket?: string; session?: string; socket?: string };
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  projects: readonly AgentSurfaceProject[];
  tickets: readonly AgentSurfaceTicketRef[];
  sessions: readonly AgentSurfaceSessionRef[];
}

export interface ResolvedAgentContext {
  projectId: string;
  ticketDisplayId: string | null;
  sessionId: string | null;
  socketPath: string | null;
  source: "flag" | "env" | "cwd";
}

export type AgentContextResolution =
  | { ok: true; context: ResolvedAgentContext }
  | { ok: false; code: string; message: string };

export type TicketBodyMutation =
  | { mode: "replace"; body: string }
  | { mode: "append"; text: string }
  | { mode: "edit"; oldText: string; newText: string };

export type TicketBodyMutationResult =
  | { ok: true; body: string }
  | { ok: false; code: "BODY_MATCH_FAILED"; message: string };

/** Applies edit-shaped ticket body updates without allowing a stale read to clobber new content. */
export function applyTicketBodyMutation(
  current: string,
  mutation: TicketBodyMutation,
): TicketBodyMutationResult {
  if (mutation.mode === "edit") {
    const first = mutation.oldText.length === 0 ? -1 : current.indexOf(mutation.oldText);
    const second =
      first === -1 ? -1 : current.indexOf(mutation.oldText, first + mutation.oldText.length);
    if (first === -1 || second !== -1) {
      return {
        ok: false,
        code: "BODY_MATCH_FAILED",
        message: `Body edit expected exactly one match for ${JSON.stringify(mutation.oldText)}.`,
      };
    }
    return {
      ok: true,
      body: `${current.slice(0, first)}${mutation.newText}${current.slice(first + mutation.oldText.length)}`,
    };
  }
  if (mutation.mode === "replace") return { ok: true, body: mutation.body };
  return { ok: true, body: `${current}${current.length === 0 ? "" : "\n\n"}${mutation.text}` };
}

/**
 * Whether `candidate` is `root` itself or sits underneath it.
 *
 * Exported because the context ladder is not the only thing that has to answer
 * "is this cwd inside that project": the socket's admission gate resolves a
 * policy project the same way, from the same roots (VC-163). It was copied
 * there first, and two copies of a containment rule are two chances to disagree
 * about a trailing slash — in one case about which project's policy governs a
 * write, which is not a difference anything should discover at runtime.
 *
 * Purely lexical: no `realpath`, no case folding, no symlink resolution. Every
 * caller compares roots this process already recorded against a cwd the caller
 * supplied, and neither side is normalized anywhere else either.
 */
export function pathContains(root: string, candidate: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

/** Resolves CLI context without guessing; explicit selectors are the highest-priority source. */
export function resolveAgentContext(input: AgentContextInput): AgentContextResolution {
  if (input.explicit.project !== undefined) {
    const selector = input.explicit.project;
    const pathMatch = input.projects.find(({ path }) => path === selector);
    const candidates = pathMatch
      ? [pathMatch]
      : input.projects.filter(
          ({ name, ticketPrefix }) => name === selector || ticketPrefix === selector,
        );
    if (candidates.length > 1) {
      const rendered = candidates
        .map(({ name, ticketPrefix, path }) => `${name} (${ticketPrefix}, ${path})`)
        .join("; ");
      return {
        ok: false,
        code: "AMBIGUOUS_PROJECT",
        message: `Project "${selector}" is ambiguous: ${rendered}. Use its path.`,
      };
    }
    const project = candidates[0];
    if (project === undefined) {
      return {
        ok: false,
        code: "PROJECT_NOT_FOUND",
        message: `No project matches ${selector}`,
      };
    }
    return {
      ok: true,
      context: {
        projectId: project.id,
        ticketDisplayId: null,
        sessionId: null,
        socketPath: input.explicit.socket ?? null,
        source: "flag",
      },
    };
  }

  const envSessionId = input.env["VOLLI_SESSION"];
  if (envSessionId !== undefined) {
    const session = input.sessions.find(({ id }) => id === envSessionId);
    if (session === undefined) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `No session matches ${envSessionId}`,
      };
    }
    return {
      ok: true,
      context: {
        projectId: session.projectId,
        ticketDisplayId: session.ticketDisplayId,
        sessionId: session.id,
        socketPath: input.env["VOLLI_SOCKET"] ?? null,
        source: "env",
      },
    };
  }

  const envTicketId = input.env["VOLLI_TICKET"];
  if (envTicketId !== undefined) {
    const matches = input.tickets.filter(({ displayId }) => displayId === envTicketId);
    if (matches.length > 1) {
      const candidates = matches
        .map(({ projectId }) => input.projects.find(({ id }) => id === projectId))
        .filter((project): project is AgentSurfaceProject => project !== undefined)
        .map(({ name, ticketPrefix, path }) => `${name} (${ticketPrefix}, ${path})`)
        .join("; ");
      return {
        ok: false,
        code: "AMBIGUOUS_TICKET",
        message: `Ticket ${envTicketId} is ambiguous: ${candidates}. Make project prefixes unique in Settings.`,
      };
    }
    const ticket = matches[0];
    if (ticket === undefined) {
      return {
        ok: false,
        code: "TICKET_NOT_FOUND",
        message: `No ticket matches ${envTicketId}`,
      };
    }
    return {
      ok: true,
      context: {
        projectId: ticket.projectId,
        ticketDisplayId: ticket.displayId,
        sessionId: null,
        socketPath: input.env["VOLLI_SOCKET"] ?? null,
        source: "env",
      },
    };
  }

  const cwdMatches = input.projects.filter((project) =>
    [project.path, ...(project.worktreePaths ?? [])].some((root) => pathContains(root, input.cwd)),
  );
  if (cwdMatches.length === 1) {
    return {
      ok: true,
      context: {
        projectId: cwdMatches[0]!.id,
        ticketDisplayId: null,
        sessionId: null,
        socketPath: input.env["VOLLI_SOCKET"] ?? null,
        source: "cwd",
      },
    };
  }
  if (cwdMatches.length > 1) {
    const candidates = cwdMatches
      .map(({ name, ticketPrefix, path }) => `${name} (${ticketPrefix}, ${path})`)
      .join("; ");
    return {
      ok: false,
      code: "AMBIGUOUS_CONTEXT",
      message: `Cwd ${input.cwd} matches multiple projects: ${candidates}`,
    };
  }

  return {
    ok: false,
    code: "CONTEXT_REQUIRED",
    message: "Provide a project flag, Volli environment, or a registered project cwd",
  };
}
