import type { TicketStatus } from "./ticket";

export const AGENT_COMMANDS = [
  "identify",
  "board",
  "ticket.list",
  "ticket.show",
  "ticket.events",
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.archive",
  "ticket.brief",
  "project.list",
  "label.list",
  "session.list",
  "session.peek",
  "session.done",
  "session.blocked",
  "notify",
] as const;

export type AgentCommand = (typeof AGENT_COMMANDS)[number];

/**
 * The subset of {@link AGENT_COMMANDS} whose socket execution mutates persisted
 * state and must broadcast `volli:data-changed` so the renderer refreshes live.
 * `session.done`/`session.blocked` belong here because they record a ticket
 * event (a Needs Review signal on the ticket the session drives).
 */
export const MUTATING_AGENT_COMMANDS: readonly AgentCommand[] = [
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.archive",
  "session.done",
  "session.blocked",
];

export const AGENT_ERROR_CODES = [
  "USAGE",
  "INVALID_REQUEST",
  "UNSUPPORTED_COMMAND",
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
  code: AgentErrorCode;
  message: string;
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
    message: `Unknown column ${JSON.stringify(value)}`,
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

function pathContains(root: string, candidate: string): boolean {
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
