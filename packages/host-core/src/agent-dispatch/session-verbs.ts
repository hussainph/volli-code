/**
 * The Session verbs an agent runs deliberately: list, peek, start, and the two
 * lifecycle signals.
 *
 * A Session here is the durable one — a PTY session and a structured (chat)
 * Session are the same subject addressed by the same short public handle, and
 * these verbs answer for both wherever both can answer. Full UUIDs never cross
 * the socket as an input; `VOLLI_SESSION` is the one exception, and it is the
 * door contract rather than an argument.
 *
 * The involuntary Session channels — a harness's hooks and its launch wrapper
 * — are not here. They are addressed by `VOLLI_SESSION` alone, arrive on a
 * process-per-event hot path, and live in `harness-verbs.ts`.
 */

import {
  displayTicketId,
  effectiveHarnessId,
  EMPTY_SESSION_USAGE_SUMMARY,
  pendingSubagentIds,
  isSessionListState,
  SESSION_LIST_STATES,
  sessionUsageWindowSince,
  sessionInterruptionReason,
  sessionInterruptionDetail,
  shortSessionId,
  todoListMarkdown,
} from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  SessionProjection,
  SessionProvenance,
  SessionRecord,
  SessionTodoList,
  SessionUsageSummary,
} from "@volli/shared";
import {
  readSessionAnswer,
  readSessionTodoList,
  readSessionTranscriptTail,
} from "@volli/session-engine";

import { createTicketCommentCommand } from "../ticket-commands";
import { withTicketWake } from "../ticket-wake";
import { getTicket } from "../db/tickets-repo";
import {
  readSessionProvenance,
  readSessionProvenances,
  type SessionProvenanceQuery,
} from "../db/session-provenance-repo";
import { readSessionUsageWindow } from "./cost-verb";
import { chatSessionRecord, terminalSessionRecord } from "../session-control";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { dryRunResponse } from "./preview";
import { positiveIntOr, projectForCreate, ticketForDisplayId } from "./resolution";
import { publicSessionOrigin } from "./wire";
import { hostLogger } from "../log/root";

const log = hostLogger("session-verbs");

/**
 * How many transcript messages a chat `session peek` shows when the caller
 * names no `--lines`.
 *
 * Far smaller than the terminal default of 60 lines, and deliberately so: a
 * peek is spent out of the ASKING agent's context, and one chat message is
 * worth many terminal lines. Twelve is about one exchange plus the tool calls
 * around it — enough to see what is happening now, not enough to be a replay.
 */
export const CHAT_PEEK_ENTRIES = 12;

function sessionForPublicId(
  sessions: readonly SessionRecord[],
  selector: unknown,
): { ok: true; session: SessionRecord } | { ok: false; response: AgentResponse } {
  if (typeof selector !== "string") {
    return { ok: false, response: failure("INVALID_REQUEST", "A session id is required.") };
  }
  // Short ids are the only public session handles (decision 3): `session list`
  // prints them and `session peek` addresses by them. Full UUIDs never cross
  // the socket as an input — only requestActor's env `VOLLI_SESSION` uses them,
  // and that's the door contract, resolved separately.
  const matches = sessions.filter((session) => shortSessionId(session.id) === selector);
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure("AMBIGUOUS_CONTEXT", `Session id ${selector} is ambiguous.`),
    };
  }
  return matches[0]
    ? { ok: true, session: matches[0] }
    : {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${selector}.`),
      };
}

/** Whether a refusal was simply a miss — the only one `session.peek` retries elsewhere. */
function isSessionNotFound(response: AgentResponse): boolean {
  return !response.ok && response.error.code === "SESSION_NOT_FOUND";
}

/**
 * The structured half of {@link sessionForPublicId}: the chat Session behind a
 * short id, addressed by the same public handle and refused the same three
 * ways.
 *
 * Precedence mirrors the renderer's listing and `session.list`: a Session that
 * ever opened a terminal IS its terminal row, so those are skipped here rather
 * than answered twice in two vocabularies.
 */
function chatProjectionForPublicId(
  projections: readonly SessionProjection[],
  selector: unknown,
): { ok: true; projection: SessionProjection } | { ok: false; response: AgentResponse } {
  if (typeof selector !== "string") {
    return { ok: false, response: failure("INVALID_REQUEST", "A session id is required.") };
  }
  const matches = projections.filter(
    (projection) =>
      shortSessionId(projection.session.id) === selector &&
      terminalSessionRecord(projection) === null,
  );
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure("AMBIGUOUS_CONTEXT", `Session id ${selector} is ambiguous.`),
    };
  }
  return matches[0]
    ? { ok: true, projection: matches[0] }
    : {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${selector}.`),
      };
}

/** `volli session list` — a project's active terminal and chat sessions. */
export async function sessionListVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const window = readSessionUsageWindow(request.args["since"]);
  if (window === "invalid")
    return failure(
      "INVALID_REQUEST",
      "since must be an RFC 3339 instant or a look-back like 7d, 24h or 90m.",
    );
  const states = request.args["state"];
  if (
    states !== undefined &&
    (!Array.isArray(states) || states.length === 0 || !states.every(isSessionListState))
  ) {
    return failure(
      "INVALID_REQUEST",
      `Unknown session state (valid: ${SESSION_LIST_STATES.join(", ")}).`,
    );
  }
  const observedAt = now();
  const since =
    window === null
      ? observedAt - 24 * 60 * 60 * 1000
      : sessionUsageWindowSince(window, observedAt);
  const ticketSelector = request.args["ticket"];
  const ticketResolution =
    ticketSelector === undefined
      ? undefined
      : ticketForDisplayId(options.db, projects, ticketSelector);
  if (ticketResolution && !ticketResolution.ok) return ticketResolution.response;
  // An explicit --project alongside --ticket must agree: never silently
  // let the ticket's project win over what the caller explicitly asked
  // for. When both are present and disagree, refuse and name both.
  if (request.args["project"] !== undefined && ticketResolution?.ok) {
    const selected = projectForCreate(options.db, projects, envSession, request);
    if (!selected.ok) return selected.response;
    if (selected.project.id !== ticketResolution.project.id) {
      return failure(
        "CONTEXT_MISMATCH",
        `Ticket ${String(ticketSelector)} belongs to project ${ticketResolution.project.name}, not the requested project ${selected.project.name}.`,
      );
    }
  }
  const resolvedProject = ticketResolution?.ok
    ? ticketResolution.project
    : projectForCreate(options.db, projects, envSession, request);
  if (!("id" in resolvedProject)) {
    if (!resolvedProject.ok) return resolvedProject.response;
  }
  const project = "id" in resolvedProject ? resolvedProject : resolvedProject.project;
  const projectById = new Map(projects.map((entry) => [entry.id, entry]));
  // `session.list` is one of the verbs that actually reads the fleet fold
  // (VC-403): both loaders share the one memoized listing this pays for.
  const projections = await context.loadProjections();
  const sessions = await context.loadSessions();
  const chatRecords = projections.map((p) => chatSessionRecord(p));
  // What each Session consumed, off the fold above. Keyed by full id because
  // that is what both halves of the listing hold; the short handle is only
  // ever an output.
  const projectionById = new Map(
    projections.map((projection) => [projection.session.id, projection]),
  );
  const sources = new Map<object, SessionProvenanceQuery>();
  const projectSessions = sessions
    .filter((session) => session.projectId === project.id)
    .filter((session) => !ticketResolution?.ok || session.ticketId === ticketResolution.ticket.id)
    .map((session) => {
      const ticket = session.ticketId ? getTicket(options.db, session.ticketId) : undefined;
      const ticketProject = ticket ? projectById.get(ticket.projectId) : undefined;
      const row = {
        id: shortSessionId(session.id),
        kind: session.ticketId ? "ticket" : "project",
        status: session.endedAt === null ? "running" : "exited",
        ticket:
          ticket && ticketProject
            ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
            : null,
        title: session.title,
        // What is RUNNING there, not what opened it: an agent reading
        // this list is deciding where to look, and the launch harness of
        // a terminal somebody has since re-used is the wrong answer.
        harness: effectiveHarnessId(session),
        // Terminal rows have no structured activity state, but their durable
        // last event is still the liveness age a fleet reader needs.
        lastActivityAgeMs: Math.max(0, observedAt - session.lastActivityAt),
        ageMs: Math.max(0, observedAt - session.createdAt),
      };
      // Assigned rather than spread (oxc(no-map-spread)); the target is a
      // fresh literal on every row, so this is still copy-on-write.
      sources.set(row, { sessionId: session.id, ticketId: session.ticketId });
      const projection = projectionById.get(session.id);
      return Object.assign(
        row,
        projection === undefined ? {} : sessionOrchestrationCells(projection, chatRecords),
        usageCells(projection?.usage),
      );
    });
  // Structured chat rows (VC-13 decision 4): `session start` must never
  // open a session its own caller cannot see. Precedence mirrors the
  // renderer's listing — a Session that ever opened a terminal is its
  // terminal row above; only structured-only Sessions land here. The
  // addressable snapshot (identify/peek/rename) stays terminal-only:
  // a chat has no PTY to peek and exports no VOLLI_SESSION of its own.
  const chatRows = projections.flatMap((projection) => {
    if (projection.session.projectId !== project.id || terminalSessionRecord(projection) !== null)
      return [];
    const record = chatSessionRecord(projection);
    if (ticketResolution?.ok && record.ticketId !== ticketResolution.ticket.id) return [];
    const ticket = record.ticketId ? getTicket(options.db, record.ticketId) : undefined;
    const ticketProject = ticket ? projectById.get(ticket.projectId) : undefined;
    const row = {
      id: shortSessionId(record.sessionId),
      kind: "chat",
      // The Role (VC-9), so an orchestrator reading its fleet can tell the
      // helpers it delegated to from the Sessions it started.
      role: record.role,
      ticket:
        ticket && ticketProject
          ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
          : null,
      title: record.title,
      // Liveness on the row itself (VC-86): the same words and waiting
      // reason `session.peek` answers and the app sidebar shows, off the same
      // `chatSessionRecord` fold — never a second derivation. An orchestrator
      // triaging a fleet reads these instead of spending a peek per Session.
      status: record.activity,
      waitingOn: record.waitingOn,
      // Why the turn died, for the one state that says it did (VC-324). Read
      // off the same projection the fold read, and guarded by the state word
      // so the two move together exactly as `waitingOn` and "waiting" do —
      // a `stopped` row that was interrupted on the way down says `stopped`
      // and hands the caller no second, older reason.
      interruptedReason: interruptedReason(record, projection),
      ...sessionOrchestrationCells(projection, chatRecords),
      interruption: record.activity === "stopped" ? null : sessionInterruptionDetail(projection),
      // Age of the newest durable fact, against the caller's clock — beside
      // `ageMs` (age since creation), which stays for sorting what is old.
      lastActivityAgeMs: Math.max(0, observedAt - record.lastActivityAt),
      ageMs: Math.max(0, observedAt - record.createdAt),
    };
    sources.set(row, { sessionId: record.sessionId, ticketId: record.ticketId });
    return [Object.assign(row, modelCells(projection), usageCells(projection.usage))];
  });
  // Explicit scope/state filters define the roster being asked about. The
  // hidden count is only older rows removed by the window, so its recovery
  // hint stays true even when --state is present.
  const scoped = [...projectSessions, ...chatRows].filter(
    (row) => states === undefined || states.some((state) => state === row.status),
  );
  const visible = scoped.filter(
    (row) =>
      request.args["all"] === true ||
      ["working", "waiting", "interrupted", "running"].includes(row.status) ||
      (row.status === "idle" &&
        "pendingSubagents" in row &&
        Array.isArray(row.pendingSubagents) &&
        row.pendingSubagents.length > 0) ||
      row.lastActivityAgeMs <= observedAt - since,
  );
  // The old concatenation had no recency order; newest durable activity first.
  visible.sort((a, b) => a.lastActivityAgeMs - b.lastActivityAgeMs);
  // Who started each Session, asked once for the rows actually returned: the
  // roster's older Sessions pay nothing for an answer nobody reads.
  const shown = visible.flatMap((row) => {
    const source = sources.get(row);
    return source === undefined ? [] : [{ row, source }];
  });
  const startedBy = readSessionProvenances(
    options.db,
    shown.map(({ source }) => source),
  );
  for (const { row, source } of shown) {
    Object.assign(row, { startedBy: publicStartedBy(startedBy(source.sessionId), false) });
  }
  return { v: 1, ok: true, data: { sessions: visible, hidden: scoped.length - visible.length } };
}

/**
 * Shared list/peek/show cells for a Session's orchestration state: its
 * pending subagents, latest turn, and latest successful attachment.
 *
 * `latestTurn` is `null` until a turn has begun. After that `origin` is `null`
 * only for a turn whose door recorded none — a legacy fact, so unknown and
 * never the user — and `resumedAfterStop` says the turn followed a stop.
 */
function sessionOrchestrationCells(
  projection: SessionProjection,
  records: readonly ReturnType<typeof chatSessionRecord>[],
): Record<string, unknown> {
  const latest = projection.attachments.findLast((attachment) => attachment.openedAt !== null);
  return {
    latestAttachment:
      latest === undefined
        ? null
        : {
            origin: publicSessionOrigin(latest.origin ?? null),
            reattached: latest.reattached ?? false,
          },
    pendingSubagents: pendingSubagentIds(projection.session.id, records),
    latestTurn:
      projection.latestTurnId === null
        ? null
        : {
            origin: publicSessionOrigin(projection.latestTurnOrigin),
            resumedAfterStop: projection.resumedAfterStop,
          },
  };
}

/**
 * Who started a Session, as the wire carries it. `withTitle` adds the starting
 * parent's title — wanted by the one-Session reads, left off a list row where
 * a fleet of children would repeat it once each.
 */
function publicStartedBy(
  provenance: SessionProvenance,
  withTitle: boolean,
): Record<string, unknown> {
  switch (provenance.kind) {
    case "user":
      return { kind: "user" };
    case "automation":
      return {
        kind: "automation",
        automationName: provenance.automationName,
        automationRunId: provenance.automationRunId,
      };
    case "session":
      return {
        kind: "session",
        parentSessionId: shortSessionId(provenance.parentSessionId),
        ...(withTitle ? { parentTitle: provenance.parentTitle } : {}),
      };
  }
}

/** Latest durable signal, not a turn outcome or the current attention state. */
function publicSessionSignal(projection: SessionProjection | undefined, observedAt: number) {
  const signal = projection?.signal;
  return signal == null
    ? null
    : {
        kind: signal.signal,
        reason: signal.reason,
        at: signal.occurredAt,
        ageMs: Math.max(0, observedAt - signal.occurredAt),
      };
}

/** `volli session show` — metadata without spending a transcript read. */
export async function sessionShowVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, now } = context;
  const projections = await context.loadProjections();
  const terminals = await context.loadSessions();
  const resolved = sessionForPublicId(terminals, request.args["id"]);
  if (!resolved.ok && !isSessionNotFound(resolved.response)) return resolved.response;
  const observedAt = now();
  const identityCells = (session: {
    id: string;
    projectId: string;
    ticketId: string | null;
    title: string;
    createdAt: number;
    lastActivityAt: number;
  }) => {
    const project = projects.find((entry) => entry.id === session.projectId);
    const ticket = session.ticketId === null ? undefined : getTicket(options.db, session.ticketId);
    return {
      id: shortSessionId(session.id),
      title: session.title,
      project: project?.name ?? null,
      ticket: ticket && project ? displayTicketId(project.ticketPrefix, ticket.ticketNumber) : null,
      ageMs: Math.max(0, observedAt - session.createdAt),
      lastActivityAgeMs: Math.max(0, observedAt - session.lastActivityAt),
    };
  };
  if (resolved.ok) {
    const terminal = resolved.session;
    const projection = projections.find((p) => p.session.id === terminal.id);
    return {
      v: 1,
      ok: true,
      data: Object.assign(
        identityCells(terminal),
        {
          kind: terminal.ticketId === null ? "project" : "ticket",
          status: terminal.endedAt === null ? "running" : "exited",
          harness: effectiveHarnessId(terminal),
          signal: publicSessionSignal(projection, observedAt),
          startedBy: publicStartedBy(
            readSessionProvenance(options.db, {
              sessionId: terminal.id,
              ticketId: terminal.ticketId,
            }),
            true,
          ),
        },
        projection === undefined
          ? {}
          : sessionOrchestrationCells(
              projection,
              projections.map((p) => chatSessionRecord(p)),
            ),
        resumptionCells(projection),
        usageCells(projection?.usage),
      ),
    };
  }
  const chat = chatProjectionForPublicId(projections, request.args["id"]);
  if (!chat.ok) return chat.response;
  const projection = chat.projection;
  const record = chatSessionRecord(projection);
  const id = record.sessionId;
  const base = Object.assign(identityCells({ ...record, id }), {
    kind: "chat",
    status: record.activity,
  });
  const records = projections.map((p) => chatSessionRecord(p));
  const provenance = readSessionProvenance(options.db, {
    sessionId: id,
    ticketId: record.ticketId,
  });
  const provenanceOf = readSessionProvenances(
    options.db,
    records.map((r) => ({ sessionId: r.sessionId, ticketId: r.ticketId })),
  );
  const summary = (child: ReturnType<typeof chatSessionRecord>) => {
    const terminalChild = terminals.find((s) => s.id === child.sessionId);
    return {
      id: shortSessionId(child.sessionId),
      title: child.title,
      role: child.role,
      status: terminalChild
        ? terminalChild.endedAt === null
          ? "running"
          : "exited"
        : child.activity,
    };
  };
  const parent = records.find((r) => r.sessionId === record.parentSessionId);
  const children = records
    .filter((r) => {
      const startedBy = provenanceOf(r.sessionId);
      return (
        (r.role === "subagent" && r.parentSessionId === id) ||
        (startedBy.kind === "session" && startedBy.parentSessionId === id)
      );
    })
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .map(summary);
  return {
    v: 1,
    ok: true,
    data: Object.assign(
      base,
      {
        role: record.role,
        signal: publicSessionSignal(projection, observedAt),
        waitingOn: record.waitingOn,
        interruptedReason: interruptedReason(record, projection),
        startedBy: publicStartedBy(provenance, true),
        parentSession:
          record.parentSessionId === null
            ? null
            : parent
              ? summary(parent)
              : { id: shortSessionId(record.parentSessionId), title: null },
        children,
      },
      sessionOrchestrationCells(projection, records),
      resumptionCells(projection),
      modelCells(projection),
      usageCells(projection.usage),
    ),
  };
}

/** Successful reattachments, oldest first; independent of whether a turn began. */
function resumptionCells(projection: SessionProjection | undefined): Record<string, unknown> {
  return {
    resumptions:
      projection?.resumptions.map(({ attachmentId, origin }) => ({
        attachment: attachmentId.slice(0, 8),
        origin: publicSessionOrigin(origin),
      })) ?? [],
  };
}

/**
 * What a chat Session is running, and what it was asked for as (VC-259).
 *
 * `model` is the copyable `provider/model` id `model list` prints, `reasoning`
 * the level beside it, and `tier` the named tier the start resolved them
 * through — or null for a model chosen by exact id, which is most of them. A
 * delegating agent reading this list can tell a `fast` Session from one on
 * the same model that a person pinned, which is the whole reason the tier is
 * recorded. Null model means the Session has not recorded a policy yet.
 */
function modelCells(projection: SessionProjection): Record<string, unknown> {
  const selection = projection.modelSelection;
  return {
    model: selection === null ? null : `${selection.providerId}/${selection.modelId}`,
    reasoning: selection === null ? null : selection.reasoningLevel,
    tier: projection.modelTier,
  };
}

/**
 * What a listed Session cost, as the four fields a reader needs to quote it
 * safely (VC-87).
 *
 * The basis and the coverage travel WITH the amount rather than being dropped
 * for width. A bare `costUsd` cannot be printed honestly: most executors price
 * tokens against a local catalogue, so the number is right about what was
 * consumed and only an estimate of what will be invoiced, and a partial total
 * is a floor rather than a sum. A row that carried the dollars alone would
 * force every surface to invent its own hedge, or to skip one.
 *
 * `costUsd: null` is the honest answer for a Session nothing could price —
 * never `0`, which would say a provider reported no charge.
 */
function interruptedReason(
  record: ReturnType<typeof chatSessionRecord>,
  projection: SessionProjection,
): ReturnType<typeof sessionInterruptionReason> {
  return record.activity === "interrupted" ? sessionInterruptionReason(projection) : null;
}

function usageCells(usage: SessionUsageSummary | undefined): Record<string, unknown> {
  const summary = usage ?? EMPTY_SESSION_USAGE_SUMMARY;
  return {
    costUsd: summary.knownCostUsd,
    costBasis: summary.costBasis,
    costCoverage: summary.costCoverage,
    tokens:
      summary.inputTokens +
      summary.outputTokens +
      summary.cacheReadTokens +
      summary.cacheWriteTokens,
  };
}

/** `volli session peek` — a terminal's trailing output, or a chat's tail. */
export async function sessionPeekVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, sessionEngine, now } = context;
  // The terminal half first — most peeks are of a live terminal, and this
  // costs only `loadSessions` (which itself shares `loadProjections`'s memo
  // with the chat fallback below, so a peek that falls through pays for the
  // fold once, not twice — VC-403).
  const resolved = sessionForPublicId(await context.loadSessions(), request.args["id"]);
  if (resolved.ok) {
    const lines = positiveIntOr(request.args["lines"], 60);
    const observation = options.observeSession?.(resolved.session.id, lines);
    if (!observation) {
      return failure(
        "SESSION_NOT_FOUND",
        `Session ${shortSessionId(resolved.session.id)} has no observable live terminal.`,
      );
    }
    const projections = await context.loadProjections();
    const projection = projections.find((p) => p.session.id === resolved.session.id);
    return {
      v: 1,
      ok: true,
      data: {
        session: shortSessionId(resolved.session.id),
        status: observation.status,
        output: observation.output,
        startedBy: publicStartedBy(
          readSessionProvenance(options.db, {
            sessionId: resolved.session.id,
            ticketId: resolved.session.ticketId,
          }),
          false,
        ),
        ...(projection === undefined
          ? {}
          : sessionOrchestrationCells(
              projection,
              projections.map((p) => chatSessionRecord(p)),
            )),
      },
    };
  }
  // No terminal answers to that handle — try the structured side (VC-79).
  // Only a MISS falls through: an ambiguous or malformed handle is the
  // caller's mistake either way, and answering it from the other half of
  // the id space would hide the collision rather than report it.
  if (!isSessionNotFound(resolved.response)) return resolved.response;
  const projections = await context.loadProjections();
  const chat = chatProjectionForPublicId(projections, request.args["id"]);
  if (!chat.ok) return chat.response;
  const record = chatSessionRecord(chat.projection);
  const tail = await readSessionTranscriptTail(
    {
      listEvents: (query) => sessionEngine.listEvents(query),
      ...(options.readTranscriptArtifact ? { readArtifact: options.readTranscriptArtifact } : {}),
    },
    {
      sessionId: record.sessionId,
      limit: positiveIntOr(request.args["lines"], CHAT_PEEK_ENTRIES),
    },
  );
  const observedAt = now();
  return {
    v: 1,
    ok: true,
    data: {
      session: shortSessionId(record.sessionId),
      // The same words the app's own sidebar row says, so one vocabulary
      // describes a Session whichever surface asks.
      status: record.activity,
      waitingOn: record.waitingOn,
      // See `session list` — the state word's reason, on the same guard.
      interruptedReason: interruptedReason(record, chat.projection),
      ...sessionOrchestrationCells(
        chat.projection,
        projections.map((p) => chatSessionRecord(p)),
      ),
      startedBy: publicStartedBy(
        readSessionProvenance(options.db, {
          sessionId: record.sessionId,
          ticketId: record.ticketId,
        }),
        false,
      ),
      interruption:
        record.activity === "stopped" ? null : sessionInterruptionDetail(chat.projection),
      lastActivityAgeMs: Math.max(0, observedAt - record.lastActivityAt),
      turns: tail.turns,
      turnDepth: tail.turnDepth,
      messages: tail.messages,
      unreadable: tail.unreadable,
      // Ages, not timestamps: "when did it last do anything" is the
      // question, and every other session field here already answers in
      // elapsed milliseconds against the caller's own clock.
      transcript: tail.entries.map((entry) => ({
        ageMs: Math.max(0, observedAt - entry.at),
        role: entry.role,
        text: entry.text,
        tools: entry.tools,
      })),
    },
  };
}

/**
 * `volli session answer` — a chat Session's final message, in full (VC-9).
 *
 * The door a subagent's notice names: the parent reads its helper's answer
 * here, as this command's output, so the child's words arrive as a tool
 * result and never as the parent's own user. Any chat Session answers — a
 * peek cuts every message to a line, and this is the one read that does not.
 */
export async function sessionAnswerVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, sessionEngine, now } = context;
  const chat = chatProjectionForPublicId(await context.loadProjections(), request.args["id"]);
  if (!chat.ok) return chat.response;
  const record = chatSessionRecord(chat.projection);
  const answer = await readSessionAnswer(
    {
      listEvents: (query) => sessionEngine.listEvents(query),
      ...(options.readTranscriptArtifact ? { readArtifact: options.readTranscriptArtifact } : {}),
    },
    { sessionId: record.sessionId },
  );
  return {
    v: 1,
    ok: true,
    data: {
      session: shortSessionId(record.sessionId),
      role: record.role,
      title: record.title,
      state: answer.state,
      signal: publicSessionSignal(chat.projection, now()),
      turns: answer.turns,
      unreadable: answer.unreadable,
      answer: answer.text,
    },
  };
}

/**
 * The write behind both lifecycle signals: one durable `session.signal`
 * against the Session `VOLLI_SESSION` names.
 *
 * Private, and the two verbs that call it are separate handlers rather than
 * one handler that reads `request.cmd`, because `done` and `blocked` are two
 * verbs in the registry and the table binds each to its own id. What they
 * share is this write, not a branch: the signal arrives as an argument, so
 * neither handler can be reached by the wrong name.
 *
 * Note the refusal text, which names both verbs. It is what an agent that ran
 * either one outside a Volli session has always been told, and it stays
 * verbatim — the caller's mistake is the same mistake whichever it typed.
 */
async function recordSessionSignal(
  context: AgentCommandContext,
  request: AgentRequest,
  signal: "done" | "blocked",
): Promise<AgentResponse> {
  const { options, envSession, sessionEngine, newId } = context;
  const envSessionId = request.ctx.env.session;
  if (!envSessionId) {
    return failure("CONTEXT_REQUIRED", "session done and blocked require VOLLI_SESSION context.");
  }
  // Identity is the whole requirement: a structured (chat) Session
  // signals through the same door a PTY session does, and neither needs
  // a terminal attachment for it (VC-51). Deliberately no cwd fallback —
  // one ticket worktree hosts any number of sessions, so a directory can
  // never say which one is signalling.
  if (!envSession) {
    return failure("SESSION_NOT_FOUND", `No session matches ${envSessionId}.`);
  }
  const reasonValue = request.args["reason"];
  if (reasonValue !== undefined && typeof reasonValue !== "string") {
    return failure("INVALID_REQUEST", "The lifecycle reason must be text.");
  }
  const reason = typeof reasonValue === "string" ? reasonValue : null;
  const preview = dryRunResponse(request, {
    kind: "session",
    id: shortSessionId(envSession.id),
    label: `Session ${shortSessionId(envSession.id)}`,
  });
  if (preview !== null) return preview;
  const submitted = await sessionEngine.submit({
    commandId: newId(),
    sessionId: envSession.id,
    intent: { kind: "session.signal", signal, reason },
    // `adapter`/`terminal` predates structured callers; kept as-is so a
    // replayed ledger reads one vocabulary. Nothing routes or renders on
    // this source today (`session.signal` routes to no adapter). The detail is
    // the new part: the signal is this Session's own act, and the origin says
    // so in the one place every other door records who asked.
    provenance: {
      source: {
        kind: "adapter",
        id: "terminal",
        detail: { sessionOrigin: { kind: "session", sessionId: envSession.id } },
      },
      venue: options.venue ?? { id: "local", kind: "local" },
    },
  });
  if (submitted.receipt?.status !== "completed") {
    return failure("MUTATION_FAILED", "The Session signal was not durably completed.");
  }
  options.onMutation?.({
    ...(envSession.ticketId === null ? {} : { ticketId: envSession.ticketId }),
    projectId: envSession.projectId,
    kind: "session",
  });
  await postFinalTodoList(context, envSession, signal);
  return {
    v: 1,
    ok: true,
    data: {
      session: shortSessionId(envSession.id),
      signal,
      reason,
      recorded: true,
    },
  };
}

/**
 * Leave the Session's last todo list on the ticket as it ends (VC-6).
 *
 * A Session runs long and mostly unattended, and the person who comes back to
 * the ticket is the reader this exists for: the list is what the Session
 * thought it was doing, in its own words, at the moment it stopped. On
 * `blocked` that is the more useful of the two — an unfinished list beside a
 * reason is most of a handover.
 *
 * AFTER the signal, never before, and never in the same breath. The signal is
 * what this verb promises; the comment is a courtesy on top of it, so a comment
 * that cannot be written must not turn a recorded `done` into a refusal. That
 * is why the failure is logged and swallowed rather than returned — the same
 * reasoning `ticket move` applies to a failed arrival projection after its move
 * has already committed.
 *
 * Silent in three cases, each for its own reason: a Board Session has no ticket
 * to comment on, a Session that never called `todo_write` has nothing to say,
 * and a Session whose list is EMPTY deliberately cleared it — posting "here is
 * an empty checklist" would be noise on all three.
 */
async function postFinalTodoList(
  context: AgentCommandContext,
  session: { id: string; projectId: string; ticketId: string | null },
  signal: "done" | "blocked",
): Promise<void> {
  const { options, now, actor } = context;
  const { id: sessionId, ticketId } = session;
  if (ticketId === null) return;
  // Both refusals BEFORE the read, because the read walks the Session's whole
  // transcript: a Session with nowhere to post must not pay for the answer.
  // Attribution comes from the RESOLVED actor rather than from the
  // `VOLLI_SESSION` the request claimed — the distinction `ticket comment`
  // draws for the same write, and for the same reason (VC-163).
  if (actor === null || actor.kind !== "session") return;
  let list: SessionTodoList | null = null;
  try {
    list = await readSessionTodoList(
      {
        listEvents: (query) => options.sessionEngine.listEvents(query),
        ...(options.readTranscriptArtifact ? { readArtifact: options.readTranscriptArtifact } : {}),
      },
      { sessionId },
    );
  } catch (error) {
    log.error("failed to read the session's todo list", { sessionId, error });
    return;
  }
  if (list === null || list.length === 0) return;
  const body = `Todo list at session ${signal}:\n\n${todoListMarkdown(list)}`;
  try {
    withTicketWake(options.db, ticketId, () =>
      createTicketCommentCommand(
        options.db,
        { ticketId, body, commentActor: actor.kind, sessionId: actor.sessionId },
        { now: now(), actor },
      ),
    );
  } catch (error) {
    log.error("failed to comment the session's todo list", { sessionId, ticketId, error });
    return;
  }
  options.onMutation?.({ ticketId, projectId: session.projectId, kind: "comment" });
}

/** `volli session done` — this Session's work is finished. */
export async function sessionDoneVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  return recordSessionSignal(context, request, "done");
}

/** `volli session blocked` — this Session needs a person. */
export async function sessionBlockedVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  return recordSessionSignal(context, request, "blocked");
}
