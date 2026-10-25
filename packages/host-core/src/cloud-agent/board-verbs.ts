/**
 * The board verbs in a cloud launch: what answers each `cloud-board` key of
 * {@link CLOUD_AGENT_ROUTES} when the board lives in Volli Cloud (VC-894).
 *
 * Each verb takes the socket request the local verb takes (the same
 * arguments, the same dry-run preview) and answers in the local verb's wire
 * shape (`agent-dispatch/wire.ts`), so the CLI renders both alike. The write
 * itself, its receipt and its side effects are the backend's board functions,
 * called through {@link AgentBackend} under the Session's Agent token: the
 * agent acts for its Session's owner, and the board records the `agent`
 * Actor. The runner mints every `commandId` and created id before the first
 * attempt (originators mint ids), so a retried write is the same write.
 *
 * Where a cloud answer differs from a local one, it is because the board no
 * longer holds the fact:
 * - list and board rows carry no `body` (the backend's roster never sends
 *   bodies; `ticket show` reads one), as `--no-body` rows do;
 * - `worktreePath` and a project's `path` are this machine's, not the
 *   board's: they come from {@link CloudBoardVerbsOptions.place} when the
 *   runner knows them, else `null`; `--project` takes a name or a prefix,
 *   never a path;
 * - a project's `id` in `project list` is its Volli Cloud id;
 * - events and comments name the cloud Actor's kind in the local vocabulary
 *   (`user`, `session`, `automation`); an event's payload is the cloud board
 *   event's, with internal ids left out and Session ids shortened to handles;
 * - `ticket brief` lists no attachments (they are not in Volli Cloud yet).
 *
 * Board verbs never wait for a connection, and each answers within
 * {@link CLOUD_VERB_BUDGET_MS}, inside the CLI's own bound:
 * - when no request reached the backend (offline, or a read that got no
 *   answer), `OFFLINE` (exit 75), saying that Session updates are kept and
 *   sent later: nothing was written, so the same command is safe again;
 * - when a write got no answer, so it may have landed, `TIMEOUT`: inspect
 *   before retrying (the CLI mints no `commandId` a retry could reuse);
 * - a write that landed answers `ok` even if reading the result back fails,
 *   from what the write itself answered.
 *
 * A caller with no Session evidence gets `SIGN_IN_REQUIRED`: the board acts
 * for a Session's owner, and the CLI holds no sign-in of its own.
 */
import { randomUUID } from "node:crypto";

import {
  applyTicketBodyMutation,
  type AgentCommandBindingId,
  displayTicketId,
  FIRST_CLASS_HARNESS_IDS,
  isTicketPriority,
  isTicketSignalKind,
  isTicketSignalVerdict,
  isTicketStatus,
  isValidBranchName,
  parseHarnessId,
  shortSessionId,
  TICKET_SIGNAL_KINDS,
  TICKET_SIGNAL_VERDICTS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type AgentErrorCode,
  type AgentRequest,
  type AgentResponse,
  type TicketBodyMutation,
  type TicketStatus,
} from "@volli/shared";
import { isUuid, labelNamesOf } from "@volli/shared/cloud";

import { composeTicketBrief } from "../agent-dispatch/briefs";
import { failure } from "../agent-dispatch/context";
import { dryRunResponse } from "../agent-dispatch/preview";
import { countOr, positiveIntOr } from "../agent-dispatch/resolution";
import { NotYetSyncedError, type AgentBackend } from "./agent-backend";
import { CloudFunctionError, CloudOfflineError } from "./functions-client";
import { agentDoorKeyOf, CLOUD_AGENT_ROUTES, type CloudBoardKey } from "./routes";

/** One call of a cloud verb: the authenticated Session (or `null`: no Session evidence) and the request. */
export interface CloudVerbCall {
  readonly sessionId: string | null;
  readonly request: AgentRequest;
}

export type CloudVerb = (call: CloudVerbCall) => Promise<AgentResponse>;

/** Every `cloud-board` key's verb: total, so a key routed to the backend has an answer. */
export type CloudBoardVerbs = { readonly [Key in CloudBoardKey]: CloudVerb };

/** Where this machine holds a project and a ticket's worktree, when it does. */
export interface CloudPlace {
  projectPath(projectId: string): string | null;
  worktreePath(ticketId: string): string | null;
}

export interface CloudBoardVerbsOptions {
  backend: AgentBackend;
  /** This runner's name, for the offline sentence. */
  runnerName?: string;
  place?: CloudPlace;
  newId?(): string;
  now?(): number;
}

// ── backend rows, as this runner reads them ──────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  ticketPrefix: string;
  archivedAt: number | null;
}

interface TicketRow {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: TicketStatus;
  priority: string;
  position: string;
  labelIds: string[];
  checkoutMode: "worktree" | "main_checkout";
  preferredHarnessId: string;
  branch: string | null;
  baseBranch: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface LabelRow {
  id: string;
  name: string;
  mergedIntoId: string | null;
}

interface ActorRow {
  kind: string;
  sessionId?: string;
  ticketId?: string | null;
  was?: string;
}

interface BoardEventRow {
  seq: number;
  ticketId: string | null;
  kind: string;
  actor: ActorRow;
  occurredAt: number;
  payload: Record<string, unknown>;
}

interface CommentRow {
  body: string;
  author: ActorRow;
  sessionId: string | null;
  createdAt: number;
  editedAt: number | null;
}

interface SignalRow {
  kind: string;
  verdict: string;
  detail: string | null;
  sessionId: string | null;
  createdAt: number;
}

interface ResolvedTicket extends TicketRead {
  ticketId: string;
  project: ProjectRow;
  key: string;
}

/** A refusal already shaped for the socket, carried out of a verb's body. */
class VerbRefusal extends Error {
  constructor(readonly response: AgentResponse) {
    super("refused");
  }
}

function refuse(code: AgentErrorCode, reason: string, next?: string | null): never {
  throw new VerbRefusal(failure(code, reason, next));
}

/** A cloud Actor in the local event vocabulary (`TicketEventActorKind`). */
function actorToken(actor: ActorRow): string {
  switch (actor.kind) {
    case "person":
      return "user";
    case "agent":
      return "session";
    case "legacy":
      return typeof actor.was === "string" ? actor.was : "automation";
    default:
      // An Automation run, Volli's own machinery, or an arm a newer build wrote.
      return "automation";
  }
}

/** A backend refusal in the socket's vocabulary. */
function refusalOf(error: CloudFunctionError): AgentResponse {
  switch (error.code) {
    case "not_found":
      return failure("TICKET_NOT_FOUND", error.message);
    case "ambiguous_key": {
      const candidates = Array.isArray(error.data["candidates"])
        ? (error.data["candidates"] as { qualifiedKey?: unknown; ticketId?: unknown }[])
            .filter((candidate) => typeof candidate.ticketId === "string")
            .map((candidate) =>
              typeof candidate.qualifiedKey === "string"
                ? `${candidate.qualifiedKey} (${String(candidate.ticketId)})`
                : String(candidate.ticketId),
            )
        : [];
      return failure(
        "AMBIGUOUS_TICKET",
        error.message,
        candidates.length > 0
          ? `Retry with one of these keys, or the ticket id in brackets: ${candidates.join(", ")}.`
          : null,
      );
    }
    case "archived":
      return failure("ARCHIVED_TICKET", error.message);
    case "body_match_failed":
      return failure("BODY_MATCH_FAILED", error.message);
    case "invalid_argument":
    case "invalid_id":
    case "invalid_position":
    case "wrong_project":
    case "checkout_mode_locked":
    case "project_archived":
    case "command_conflict":
      return failure("INVALID_REQUEST", error.message);
    case "not_a_member":
    case "forbidden":
    case "fenced":
    case "revoked":
    case "not_claimed":
    case "unauthenticated":
      return failure(
        "FORBIDDEN_ACTOR",
        error.message,
        "This Session can no longer act for its owner in Volli Cloud from this runner.",
      );
    default:
      return failure("MUTATION_FAILED", error.message);
  }
}

/** A write that got no answer: it may have landed. */
class WriteOutcomeUnknown extends Error {
  constructor(readonly path: string) {
    super(`Volli Cloud did not confirm ${path}.`);
  }
}

/** How long one cloud board verb may take: under the CLI's 10-second bound for board verbs. */
export const CLOUD_VERB_BUDGET_MS = 8_000;

/** Payload fields that are internal ids, never shown at the socket. */
const INTERNAL_PAYLOAD_IDS: ReadonlySet<string> = new Set([
  "commentId",
  "labelId",
  "intoLabelId",
  "runnerId",
  "workingCopyId",
  "projectRepoId",
  "fromWorkspaceId",
  "toWorkspaceId",
  "toTicketId",
]);

const shortHandle = (id: string) => (isUuid(id) ? shortSessionId(id) : id);

/**
 * A cloud board event's payload as the socket shows it: internal ids left
 * out, a Session as its short handle (`session`), an attachment by its first
 * eight characters, and a Session origin shortened the same way.
 */
function publicPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(payload)) {
    if (INTERNAL_PAYLOAD_IDS.has(field)) continue;
    if (field === "sessionId" && typeof value === "string") {
      out["session"] = shortHandle(value);
    } else if (field === "attachmentId" && typeof value === "string") {
      out["attachment"] = value.slice(0, 8);
    } else if (
      field === "origin" &&
      typeof value === "object" &&
      value !== null &&
      (value as { kind?: unknown }).kind === "session" &&
      typeof (value as { sessionId?: unknown }).sessionId === "string"
    ) {
      out["origin"] = {
        kind: "session",
        sessionId: shortHandle((value as { sessionId: string }).sessionId),
      };
    } else {
      out[field] = value;
    }
  }
  return out;
}

function wireSignal(signal: SignalRow, key: string) {
  return {
    ticket: key,
    kind: signal.kind,
    verdict: signal.verdict,
    detail: signal.detail,
    session: signal.sessionId === null ? null : shortSessionId(signal.sessionId),
    createdAt: signal.createdAt,
  };
}

function wireComment(comment: CommentRow, key: string) {
  return {
    ticket: key,
    body: comment.body,
    actor: actorToken(comment.author),
    session: comment.sessionId === null ? null : shortSessionId(comment.sessionId),
    createdAt: comment.createdAt,
    updatedAt: comment.editedAt ?? comment.createdAt,
  };
}

const ticketTarget = (ticket: ResolvedTicket) =>
  ({ kind: "ticket", id: ticket.key, label: ticket.key }) as const;

interface MergeAnswer {
  from: string;
  into: string;
  ticketCount: number;
  tickets: { key: string; title: string; archived: boolean }[];
}

function wireMerge(answer: MergeAnswer, applied: boolean) {
  return {
    applied,
    from: answer.from,
    into: answer.into,
    // The listing is bounded; the count is the whole blast radius.
    ticketCount: answer.ticketCount,
    tickets: answer.tickets.map(({ key, title, archived }) => ({ id: key, title, archived })),
  };
}

/** What a verb body calls the backend through: one Session, one deadline, reads memoized. */
interface VerbIo {
  readonly sessionId: string;
  query<T>(path: string, args: Record<string, unknown>): Promise<T>;
  /** A write. No answer (it may have landed) becomes {@link WriteOutcomeUnknown}. */
  mutation<T>(path: string, args: Record<string, unknown>): Promise<T>;
  /** The caller's projects and its Session's project, read once per verb. */
  projects(): Promise<{ projects: ProjectRow[]; current: string | null }>;
}

interface TicketRead {
  ticket: TicketRow;
  body: string;
  labels: string[];
}

/**
 * After a write that landed, reads the result back for the answer; if the
 * read fails, the write still succeeded, so the answer is `fallback`.
 */
async function afterWrite(
  read: () => Promise<Record<string, unknown>>,
  fallback: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CloudOfflineError || error instanceof CloudFunctionError) {
      return fallback;
    }
    throw error;
  }
}

/** How many archived tickets a project has, read a page at a time. */
async function archivedCount(io: VerbIo, projectId: string): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { page: unknown[]; isDone: boolean; continueCursor: string } = await io.query(
      "board:archivedTickets",
      { projectId, paginationOpts: { numItems: 500, cursor } },
    );
    count += page.page.length;
    if (page.isDone) return count;
    cursor = page.continueCursor;
  }
}

export function createCloudBoardVerbs(options: CloudBoardVerbsOptions): CloudBoardVerbs {
  const { backend } = options;
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? Date.now;
  const runner = options.runnerName ?? "This runner";

  const offline = () =>
    failure(
      "OFFLINE",
      `${runner} can't reach Volli Cloud. Board changes need a connection; Session updates are kept and sent when it's back.`,
    );

  function ioFor(sessionId: string): VerbIo {
    const deadline = now() + CLOUD_VERB_BUDGET_MS;
    let projects: Promise<{ projects: ProjectRow[]; current: string | null }> | null = null;
    const io: VerbIo = {
      sessionId,
      query: <T>(path: string, args: Record<string, unknown>) =>
        backend.query(sessionId, path, args, { deadline }) as Promise<T>,
      async mutation<T>(path: string, args: Record<string, unknown>) {
        try {
          return (await backend.mutation(sessionId, path, args, { deadline })) as T;
        } catch (error) {
          if (error instanceof CloudOfflineError && error.delivery === "unknown") {
            throw new WriteOutcomeUnknown(path);
          }
          throw error;
        }
      },
      projects: () => (projects ??= io.query("projects:listForActor", {})),
    };
    return io;
  }

  /** Runs a verb body for an authenticated Session, mapping every failure to the socket's words. */
  function verb(body: (io: VerbIo, request: AgentRequest) => Promise<AgentResponse>): CloudVerb {
    return async ({ sessionId, request }) => {
      if (sessionId === null) {
        return failure(
          "SIGN_IN_REQUIRED",
          `${request.cmd} acts on the Volli Cloud board for a Session's owner, and this caller is not a Volli Session.`,
        );
      }
      try {
        return await body(ioFor(sessionId), request);
      } catch (error) {
        if (error instanceof VerbRefusal) return error.response;
        if (error instanceof WriteOutcomeUnknown) {
          return failure(
            "TIMEOUT",
            `${runner} sent this change to Volli Cloud but got no answer, so it may have been written.`,
          );
        }
        if (error instanceof CloudOfflineError) return offline();
        if (error instanceof NotYetSyncedError) {
          return failure("NOT_YET_SYNCED", error.message);
        }
        if (error instanceof CloudFunctionError) return refusalOf(error);
        throw error;
      }
    };
  }

  // ── reads the verbs share ──────────────────────────────────────────────────

  async function projectFor(io: VerbIo, request: AgentRequest): Promise<ProjectRow> {
    const { projects, current } = await io.projects();
    const selector = request.args["project"];
    if (typeof selector === "string") {
      const wanted = selector.trim().toLowerCase();
      const matches = projects.filter(
        (project) =>
          project.name.toLowerCase() === wanted || project.ticketPrefix.toLowerCase() === wanted,
      );
      if (matches.length > 1) {
        refuse("AMBIGUOUS_PROJECT", `More than one project matches ${selector}.`);
      }
      if (matches.length === 0) refuse("PROJECT_NOT_FOUND", `No project matches ${selector}.`);
      return matches[0]!;
    }
    const project = projects.find(({ id }) => id === current);
    if (project === undefined) {
      return refuse("PROJECT_REQUIRED", "This Session's project is not on the board.");
    }
    return project;
  }

  async function ticketFor(io: VerbIo, raw: unknown): Promise<ResolvedTicket> {
    if (typeof raw !== "string" || raw.trim() === "") {
      return refuse("INVALID_REQUEST", "A ticket display id is required.");
    }
    const key = raw.trim();
    const ticketId = isUuid(key)
      ? key
      : (await io.query<{ ticketId: string }>("board:resolveTicketKey", { key })).ticketId;
    const read = await io.query<TicketRead>("board:getTicket", { ticketId });
    const project = await io.query<ProjectRow>("projects:get", {
      projectId: read.ticket.projectId,
    });
    return {
      ...read,
      ticketId,
      project,
      key: displayTicketId(project.ticketPrefix, read.ticket.number),
    };
  }

  function wireTicket(
    ticket: TicketRow,
    project: ProjectRow,
    labels: readonly string[],
    body: string | undefined,
  ): Record<string, unknown> {
    return {
      id: displayTicketId(project.ticketPrefix, ticket.number),
      project: project.name,
      title: ticket.title,
      ...(body === undefined ? {} : { body }),
      status: ticket.status,
      priority: ticket.priority,
      labels,
      usesWorktree: ticket.checkoutMode === "worktree",
      harness: ticket.preferredHarnessId,
      worktreePath: options.place?.worktreePath(ticket.id) ?? null,
      branch: ticket.branch,
      baseBranch: ticket.baseBranch,
      badge: null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }

  const wireRead = (read: TicketRead, project: ProjectRow) =>
    wireTicket(read.ticket, project, read.labels, read.body);

  async function showTicket(io: VerbIo, ticketId: string, project: ProjectRow) {
    return wireRead(await io.query<TicketRead>("board:getTicket", { ticketId }), project);
  }

  async function roster(io: VerbIo, project: ProjectRow) {
    const { tickets, labels } = await io.query<{ tickets: TicketRow[]; labels: LabelRow[] }>(
      "board:roster",
      { projectId: project.id },
    );
    const rows = tickets
      .toSorted((a, b) =>
        a.status === b.status
          ? a.position < b.position
            ? -1
            : a.position > b.position
              ? 1
              : 0
          : TICKET_STATUSES.indexOf(a.status) - TICKET_STATUSES.indexOf(b.status),
      )
      .map((ticket) => ({
        row: ticket,
        wire: wireTicket(ticket, project, labelNamesOf(ticket.labelIds, labels), undefined),
      }));
    return { rows, labels };
  }

  async function events(io: VerbIo, ticket: ResolvedTicket, limit: number) {
    if (limit === 0) return [];
    const rows = (
      await io.query<BoardEventRow[]>("board:ticketEvents", { ticketId: ticket.ticketId })
    ).slice(-limit);
    // The ticket an acting Session worked on, as its key (`null` when it cannot be read).
    const keys = new Map<string, Promise<string | null>>([
      [ticket.ticketId, Promise.resolve(ticket.key)],
    ]);
    const keyOf = (ticketId: string) => {
      let key = keys.get(ticketId);
      if (key === undefined) {
        key = (async () => {
          try {
            const read = await io.query<TicketRead>("board:getTicket", { ticketId });
            const project = await io.query<ProjectRow>("projects:get", {
              projectId: read.ticket.projectId,
            });
            return displayTicketId(project.ticketPrefix, read.ticket.number);
          } catch (error) {
            if (error instanceof CloudFunctionError) return null;
            throw error;
          }
        })();
        keys.set(ticketId, key);
      }
      return key;
    };
    return Promise.all(
      rows.map(async (event) => {
        const { actor } = event;
        const acting =
          actor.kind === "agent" && typeof actor.sessionId === "string"
            ? {
                session: shortSessionId(actor.sessionId),
                ticket: typeof actor.ticketId === "string" ? await keyOf(actor.ticketId) : null,
              }
            : null;
        return {
          actor: actorToken(actor),
          actorContext: acting,
          payload: publicPayload(event.payload),
          createdAt: event.occurredAt,
        };
      }),
    );
  }

  // ── the verbs ──────────────────────────────────────────────────────────────

  return {
    board: verb(async (io, request) => {
      const project = await projectFor(io, request);
      const { rows } = await roster(io, project);
      return {
        v: 1,
        ok: true,
        data: {
          project: {
            name: project.name,
            prefix: project.ticketPrefix,
            path: options.place?.projectPath(project.id) ?? null,
          },
          columns: Object.fromEntries(
            TICKET_STATUSES.map((status) => [
              status,
              rows.filter(({ row }) => row.status === status).map(({ wire }) => wire),
            ]),
          ),
        },
      };
    }),

    "ticket.list": verb(async (io, request) => {
      const project = await projectFor(io, request);
      const { status, priority, label, limit, body } = request.args;
      if (
        (body !== undefined && typeof body !== "boolean") ||
        (status !== undefined && !isTicketStatus(status)) ||
        (priority !== undefined && !isTicketPriority(priority)) ||
        (label !== undefined && typeof label !== "string") ||
        (limit !== undefined &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0))
      ) {
        return failure("INVALID_REQUEST", "Invalid ticket list filters.");
      }
      const { rows, labels } = await roster(io, project);
      // A label filter names a label as a person types it: ignoring case, and
      // a retired name follows its merge to the label it is worn as now.
      let wanted: string | null = null;
      if (typeof label === "string") {
        const key = label.trim().toLowerCase();
        const named = labels
          .filter((row) => row.name.toLowerCase() === key)
          .toSorted((a, b) => Number(a.mergedIntoId !== null) - Number(b.mergedIntoId !== null))[0];
        wanted = named === undefined ? null : (labelNamesOf([named.id], labels)[0] ?? null);
        if (wanted === null) return { v: 1, ok: true, data: { tickets: [] } };
      }
      const tickets = rows
        .filter(({ row }) => status === undefined || row.status === status)
        .filter(({ row }) => priority === undefined || row.priority === priority)
        .filter(({ wire }) => wanted === null || (wire["labels"] as string[]).includes(wanted))
        .slice(0, typeof limit === "number" ? limit : undefined)
        .map(({ wire }) => wire);
      return { v: 1, ok: true, data: { tickets } };
    }),

    "ticket.show": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      const eventLimit = countOr(request.args["events"], 5);
      const commentLimit = countOr(request.args["comments"], 5);
      const [eventRows, commentRows, signalRows] = await Promise.all([
        events(io, resolved, eventLimit),
        commentLimit === 0
          ? Promise.resolve([] as CommentRow[])
          : io.query<CommentRow[]>("board:comments", { ticketId: resolved.ticketId }),
        io.query<SignalRow[]>("board:signals", { ticketId: resolved.ticketId }),
      ]);
      // The latest of each kind is the one that stands.
      const standing = new Map<string, SignalRow>();
      for (const signal of signalRows) standing.set(signal.kind, signal);
      const compact =
        request.args["commentsOnly"] === true || (eventLimit === 0 && commentLimit === 0);
      return {
        v: 1,
        ok: true,
        data: {
          ticket: compact
            ? { id: resolved.key, status: resolved.ticket.status, title: resolved.ticket.title }
            : wireRead(resolved, resolved.project),
          signals: [...standing.values()].map((signal) => wireSignal(signal, resolved.key)),
          events: eventRows,
          comments: (commentLimit === 0 ? [] : commentRows.slice(-commentLimit)).map((comment) =>
            wireComment(comment, resolved.key),
          ),
        },
      };
    }),

    "ticket.events": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      const limit = positiveIntOr(request.args["limit"], 50);
      return { v: 1, ok: true, data: { events: await events(io, resolved, limit) } };
    }),

    "ticket.brief": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      const projectPath = options.place?.projectPath(resolved.project.id) ?? request.ctx.cwd;
      return {
        v: 1,
        ok: true,
        data: {
          prompt: composeTicketBrief({
            project: {
              id: resolved.project.id,
              path: projectPath,
              ticketPrefix: resolved.project.ticketPrefix,
            },
            ticket: {
              id: resolved.ticket.id,
              ticketNumber: resolved.ticket.number,
              title: resolved.ticket.title,
              body: resolved.body,
              usesWorktree: resolved.ticket.checkoutMode === "worktree",
              worktreePath: options.place?.worktreePath(resolved.ticket.id) ?? null,
              branch: resolved.ticket.branch,
              baseBranch: resolved.ticket.baseBranch,
            },
            attachments: [],
          }),
        },
      };
    }),

    "label.list": verb(async (io, request) => {
      const project = await projectFor(io, request);
      const labels = await io.query<{ name: string; color: string | null; tickets: number }[]>(
        "board:labels",
        { projectId: project.id },
      );
      return {
        v: 1,
        ok: true,
        data: {
          labels: labels.map(({ name, color, tickets }) => ({ name, color, tickets })),
        },
      };
    }),

    "project.list": verb(async (io) => {
      const { projects } = await io.projects();
      const rows = await Promise.all(
        projects.map(async (project) => {
          const [{ tickets }, archived] = await Promise.all([
            io.query<{ tickets: unknown[] }>("board:roster", { projectId: project.id }),
            archivedCount(io, project.id),
          ]);
          return {
            id: project.id,
            name: project.name,
            prefix: project.ticketPrefix,
            path: options.place?.projectPath(project.id) ?? null,
            tickets: tickets.length,
            archived,
          };
        }),
      );
      return { v: 1, ok: true, data: { projects: rows } };
    }),

    "board.createTicket": verb(async (io, request) => {
      const project = await projectFor(io, request);
      const title = request.args["title"];
      const status = request.args["status"] ?? "backlog";
      const priority = request.args["priority"] ?? "medium";
      const labels = request.args["labels"] ?? [];
      const base = request.args["base"];
      const harness = harnessOf(request.args["harness"]);
      if (
        typeof title !== "string" ||
        title.trim().length === 0 ||
        !isTicketStatus(status) ||
        !isTicketPriority(priority) ||
        (base !== undefined && (typeof base !== "string" || !isValidBranchName(base))) ||
        !Array.isArray(labels) ||
        !labels.every((name) => typeof name === "string")
      ) {
        return failure("INVALID_REQUEST", "Invalid ticket create arguments.");
      }
      const preview = dryRunResponse(request, {
        kind: "project",
        id: project.ticketPrefix,
        label: `${project.name} (${project.ticketPrefix})`,
      });
      if (preview !== null) return preview;
      const created = await io.mutation<{ ticketId: string; key: string }>("board:createTicket", {
        commandId: newId(),
        projectId: project.id,
        ticketId: newId(),
        status,
        title: title.trim(),
        priority,
        body: typeof request.args["body"] === "string" ? request.args["body"] : "",
        labels,
        checkoutMode: request.args["usesWorktree"] === false ? "main_checkout" : "worktree",
        ...(harness === undefined ? {} : { preferredHarnessId: harness }),
        baseBranch: typeof base === "string" ? base : null,
      });
      const ticket = await afterWrite(() => showTicket(io, created.ticketId, project), {
        id: created.key,
        project: project.name,
        title: title.trim(),
        status,
        priority,
      });
      return { v: 1, ok: true, data: { ticket } };
    }),

    "board.updateTicket": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      const { title, priority, base } = request.args;
      const mutationArg = request.args["bodyMutation"];
      const addLabels = request.args["addLabels"] ?? [];
      const removeLabels = request.args["removeLabels"] ?? [];
      const harness = harnessOf(request.args["harness"]);
      if (
        (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) ||
        (priority !== undefined && !isTicketPriority(priority)) ||
        (base !== undefined && (typeof base !== "string" || !isValidBranchName(base))) ||
        (mutationArg !== undefined && !isBodyMutation(mutationArg)) ||
        !Array.isArray(addLabels) ||
        !addLabels.every((name) => typeof name === "string") ||
        !Array.isArray(removeLabels) ||
        !removeLabels.every((name) => typeof name === "string")
      ) {
        return failure("INVALID_REQUEST", "Invalid ticket update arguments.");
      }
      if (base !== undefined) {
        return failure(
          "INVALID_REQUEST",
          "A ticket's base branch cannot be changed from an agent in Volli Cloud yet.",
          "Change it in the app.",
        );
      }
      if (isBodyMutation(mutationArg)) {
        // Checked against the body as read, so the refusal keeps its own code;
        // the backend applies it again to the body as it stands in the write.
        const next = applyTicketBodyMutation(resolved.body, mutationArg);
        if (!next.ok) return failure(next.code, next.message);
      }
      const preview = dryRunResponse(request, ticketTarget(resolved));
      if (preview !== null) return preview;
      await io.mutation("board:updateTicket", {
        commandId: newId(),
        ticketId: resolved.ticketId,
        ...(typeof title === "string" ? { title: title.trim() } : {}),
        ...(isBodyMutation(mutationArg) ? { bodyMutation: mutationArg } : {}),
        ...(harness === undefined ? {} : { preferredHarnessId: harness }),
        ...(isTicketPriority(priority) ? { priority } : {}),
        ...(addLabels.length > 0 ? { addLabels } : {}),
        ...(removeLabels.length > 0 ? { removeLabels } : {}),
      });
      const ticket = await afterWrite(
        () => showTicket(io, resolved.ticketId, resolved.project),
        wireRead(resolved, resolved.project),
      );
      return { v: 1, ok: true, data: { ticket } };
    }),

    "ticket.move": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      const to = request.args["to"];
      if (!isTicketStatus(to)) {
        return failure("INVALID_REQUEST", "ticket move requires a valid destination column.");
      }
      // A CLI move carries column semantics only, so a move to the column the
      // ticket is in is a no-op, never a reorder to the bottom.
      if (resolved.ticket.status === to) {
        const noOp = dryRunResponse(request, ticketTarget(resolved), {
          durableWrites: [],
          humanVisibleEffects: [],
          nonEffects: [
            `The Ticket is already in ${TICKET_STATUS_LABELS[to]}; no row, event, Session, or notification would be created.`,
          ],
        });
        if (noOp !== null) return noOp;
        return { v: 1, ok: true, data: { ticket: wireRead(resolved, resolved.project) } };
      }
      const preview = dryRunResponse(request, ticketTarget(resolved));
      if (preview !== null) return preview;
      await io.mutation("board:moveTickets", {
        commandId: newId(),
        projectId: resolved.project.id,
        ticketIds: [resolved.ticketId],
        toStatus: to,
      });
      const ticket = await afterWrite(() => showTicket(io, resolved.ticketId, resolved.project), {
        ...wireRead(resolved, resolved.project),
        status: to,
      });
      return { v: 1, ok: true, data: { ticket } };
    }),

    "board.createComment": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      const message = request.args["message"];
      if (typeof message !== "string" || message.trim().length === 0) {
        return failure("INVALID_REQUEST", "ticket comment requires a message.");
      }
      const preview = dryRunResponse(request, ticketTarget(resolved));
      if (preview !== null) return preview;
      const written = await io.mutation<{ createdAt?: number }>("board:createComment", {
        commandId: newId(),
        ticketId: resolved.ticketId,
        commentId: newId(),
        body: message,
      });
      return {
        v: 1,
        ok: true,
        data: {
          comment: {
            ticket: resolved.key,
            body: message,
            actor: "session",
            session: shortSessionId(io.sessionId),
            createdAt: written.createdAt ?? now(),
          },
        },
      };
    }),

    "ticket.signal": verb(async (io, request) => {
      const resolved = await ticketFor(io, request.args["id"]);
      // A verdict is signed by its Session, and scoped to that Session's own
      // project, as on a local board: a signer is not borrowed across projects.
      const { current } = await io.projects();
      if (resolved.project.id !== current) {
        return failure(
          "TICKET_NOT_FOUND",
          `${resolved.key} is not in this Session's project, so this Session cannot sign a verdict on it.`,
        );
      }
      const { kind, verdict } = request.args;
      if (!isTicketSignalKind(kind)) {
        return failure(
          "INVALID_REQUEST",
          `Unknown signal kind ${JSON.stringify(kind ?? null)} (valid: ${TICKET_SIGNAL_KINDS.join(", ")})`,
          "Retry with one of the named kinds; the vocabulary is fixed so signals stay queryable.",
        );
      }
      if (!isTicketSignalVerdict(verdict)) {
        return failure(
          "INVALID_REQUEST",
          `Unknown verdict ${JSON.stringify(verdict ?? null)} (valid: ${TICKET_SIGNAL_VERDICTS.join(", ")})`,
          "Retry with pass, fail, or blocked; anything more specific belongs in --detail.",
        );
      }
      const detailValue = request.args["detail"];
      if (detailValue !== undefined && typeof detailValue !== "string") {
        return failure(
          "INVALID_REQUEST",
          "The signal detail must be text.",
          "Pass --detail with one line of prose, or omit it.",
        );
      }
      const detail =
        typeof detailValue === "string" && detailValue.trim().length > 0 ? detailValue : null;
      const preview = dryRunResponse(request, ticketTarget(resolved));
      if (preview !== null) return preview;
      const written = await io.mutation<{ createdAt?: number }>("board:createSignal", {
        commandId: newId(),
        ticketId: resolved.ticketId,
        signalId: newId(),
        kind,
        verdict,
        detail,
      });
      return {
        v: 1,
        ok: true,
        data: {
          signal: {
            ticket: resolved.key,
            kind,
            verdict,
            detail,
            session: shortSessionId(io.sessionId),
            createdAt: written.createdAt ?? now(),
          },
        },
      };
    }),

    "label.merge": verb(async (io, request) => {
      const project = await projectFor(io, request);
      const from = request.args["from"];
      const into = request.args["into"];
      if (typeof from !== "string" || from.trim().length === 0) {
        return failure("INVALID_REQUEST", "label merge requires --from <name>.");
      }
      if (typeof into !== "string" || into.trim().length === 0) {
        return failure("INVALID_REQUEST", "label merge requires --into <name>.");
      }
      // The preview is the answer either way: once applied, `from` is an alias
      // of `into` and there is nothing left to list.
      const preview = await io.query<MergeAnswer>("board:labelMergePreview", {
        projectId: project.id,
        from,
        into,
      });
      if (request.args["apply"] !== true) {
        return {
          v: 1,
          ok: true,
          data: {
            ...wireMerge(preview, false),
            next: `Re-run with --apply to move ${preview.ticketCount} Ticket(s) onto ${preview.into} and retire ${preview.from} as an alias.`,
          },
        };
      }
      await io.mutation("board:mergeLabels", {
        commandId: newId(),
        projectId: project.id,
        from,
        into,
      });
      return { v: 1, ok: true, data: wireMerge(preview, true) };
    }),
  };
}

/**
 * A harness the backend can record: a built-in id. A registered harness is
 * this machine's, and the board in Volli Cloud does not know it.
 */
function harnessOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? parseHarnessId(value) : null;
  if (parsed === null || !(FIRST_CLASS_HARNESS_IDS as readonly string[]).includes(parsed)) {
    refuse(
      "INVALID_REQUEST",
      `Invalid harness ${JSON.stringify(value)} (valid in Volli Cloud: ${FIRST_CLASS_HARNESS_IDS.join(", ")})`,
    );
  }
  return parsed;
}

function isBodyMutation(value: unknown): value is TicketBodyMutation {
  if (typeof value !== "object" || value === null || !("mode" in value)) return false;
  if (value.mode === "replace") return "body" in value && typeof value.body === "string";
  if (value.mode === "append") return "text" in value && typeof value.text === "string";
  return (
    value.mode === "edit" &&
    "oldText" in value &&
    typeof value.oldText === "string" &&
    "newText" in value &&
    typeof value.newText === "string"
  );
}

/**
 * The cloud verb that answers a socket binding, or `null` when the binding's
 * route is not `cloud-board` or no cloud board is composed (a local launch).
 */
export function cloudBoardVerbOf(
  verbs: CloudBoardVerbs | undefined,
  binding: AgentCommandBindingId,
): CloudVerb | null {
  if (verbs === undefined) return null;
  const key = agentDoorKeyOf(binding);
  return CLOUD_AGENT_ROUTES[key].route === "cloud-board" ? verbs[key as CloudBoardKey] : null;
}
