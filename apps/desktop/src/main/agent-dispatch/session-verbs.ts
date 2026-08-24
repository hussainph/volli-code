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
  autoTitleFromKickoff,
  DEFAULT_KICKOFF_MESSAGE,
  displayTicketId,
  effectiveHarnessId,
  EMPTY_SESSION_USAGE_SUMMARY,
  errorMessage,
  REASONING_LEVELS,
  shortSessionId,
} from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  ReasoningLevel,
  SessionProjection,
  SessionRecord,
  SessionUsageSummary,
} from "@volli/shared";
import { readSessionTranscriptTail } from "@volli/session-engine";

import { getTicket } from "../db/tickets-repo";
import { chatSessionRecord, terminalSessionRecord } from "../session-control";
import { StructuredSessionsError } from "../session-runtime/sessions";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { dryRunResponse } from "./preview";
import {
  actorSessionTicketDisplay,
  positiveIntOr,
  projectForCreate,
  requestActor,
  ticketForDisplayId,
} from "./resolution";

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

/**
 * The provider/model pair a `session.start` override names — shape only, like
 * every other raw-socket argument here. Whether Model Access can actually run
 * it is the facade's judgement, refused as MODEL_UNAVAILABLE.
 */
function isModelRef(value: unknown): value is { providerId: string; modelId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "providerId" in value &&
    typeof value.providerId === "string" &&
    value.providerId.length > 0 &&
    "modelId" in value &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0
  );
}

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
  const { options, projects, sessions, envSession, sessionEngine, now } = context;
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
  // What each Session consumed, off the fold the dispatch already made. Keyed
  // by full id because that is what both halves of the listing hold; the short
  // handle is only ever an output.
  const usageById = new Map(
    context.projections.map((projection) => [projection.session.id, projection.usage]),
  );
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
        ageMs: Math.max(0, now() - session.createdAt),
      };
      // Assigned rather than spread (oxc(no-map-spread)); the target is a
      // fresh literal on every row, so this is still copy-on-write.
      return Object.assign(row, usageCells(usageById.get(session.id)));
    });
  // Structured chat rows (VC-13 decision 4): `session start` must never
  // open a session its own caller cannot see. Precedence mirrors the
  // renderer's listing — a Session that ever opened a terminal is its
  // terminal row above; only structured-only Sessions land here. The
  // addressable snapshot (identify/peek/rename) stays terminal-only:
  // a chat has no PTY to peek and exports no VOLLI_SESSION of its own.
  const chatRows = (
    await sessionEngine.listSessions({ projectId: project.id, scope: "all" })
  ).flatMap((projection) => {
    if (terminalSessionRecord(projection) !== null) return [];
    const record = chatSessionRecord(projection);
    if (ticketResolution?.ok && record.ticketId !== ticketResolution.ticket.id) return [];
    const ticket = record.ticketId ? getTicket(options.db, record.ticketId) : undefined;
    const ticketProject = ticket ? projectById.get(ticket.projectId) : undefined;
    const row = {
      id: shortSessionId(record.sessionId),
      kind: "chat",
      ticket:
        ticket && ticketProject
          ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
          : null,
      title: record.title,
      ageMs: Math.max(0, now() - record.createdAt),
    };
    return [Object.assign(row, usageCells(usageById.get(record.sessionId)))];
  });
  return { v: 1, ok: true, data: { sessions: [...projectSessions, ...chatRows] } };
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
  const { options, projections, sessions, sessionEngine, now } = context;
  const resolved = sessionForPublicId(sessions, request.args["id"]);
  if (resolved.ok) {
    const lines = positiveIntOr(request.args["lines"], 60);
    const observation = options.observeSession?.(resolved.session.id, lines);
    if (!observation) {
      return failure(
        "SESSION_NOT_FOUND",
        `Session ${shortSessionId(resolved.session.id)} has no observable live terminal.`,
      );
    }
    return {
      v: 1,
      ok: true,
      data: {
        session: shortSessionId(resolved.session.id),
        status: observation.status,
        output: observation.output,
      },
    };
  }
  // No terminal answers to that handle — try the structured side (VC-79).
  // Only a MISS falls through: an ambiguous or malformed handle is the
  // caller's mistake either way, and answering it from the other half of
  // the id space would hide the collision rather than report it.
  if (!isSessionNotFound(resolved.response)) return resolved.response;
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
      // The same three words the app's own sidebar row says, so one
      // vocabulary describes a Session whichever surface asks.
      status: record.activity,
      waitingOn: record.waitingOn,
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
 * `volli session start` — an agent chat Session on a ticket.
 *
 * VC-92 ruled this one control tier: a named tool in the `project` bundle, off
 * the socket for every caller. VC-162 makes that move, and it moves the ACCESS
 * MODE, not this function. The registry binds `session.start` to one handler
 * id; a verb that leaves the `cli` access mode leaves `AGENT_COMMAND_BINDINGS`
 * and stops being reachable over the wire, and the tool surface resolves the
 * same binding. Adding a second implementation there would be two verbs
 * wearing one name — exactly what the registry's one-binding-per-verb rule
 * exists to prevent.
 */
export async function sessionStartVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now, newId } = context;
  // Attended-only by structure (VC-13): this door's only transport is the
  // app-owned socket and the Pi runtime lives in Electron main, so an
  // unreachable app already failed as APP_UNREACHABLE before this line.
  // A launch whose Session runtime never came up reports the same
  // retryable class — relaunching the app is the sanctioned recovery.
  const sessionsFacade = options.sessions;
  if (!sessionsFacade) {
    return failure("APP_UNREACHABLE", "The Session runtime is not available this launch.");
  }
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  const message = request.args["message"];
  const title = request.args["title"];
  const model = request.args["model"];
  const reasoning = request.args["reasoning"];
  if (
    (message !== undefined && (typeof message !== "string" || message.trim().length === 0)) ||
    (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) ||
    (model !== undefined && !isModelRef(model)) ||
    (reasoning !== undefined && !(REASONING_LEVELS as readonly unknown[]).includes(reasoning))
  ) {
    return failure("INVALID_REQUEST", "Invalid session start arguments.");
  }
  const displayId = displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber);
  const kickoff = typeof message === "string" ? message : DEFAULT_KICKOFF_MESSAGE;
  const sessionTitle =
    typeof title === "string" ? title.trim() : autoTitleFromKickoff(kickoff, displayId);
  try {
    const started = await sessionsFacade.start({
      operationId: newId(),
      projectId: resolved.project.id,
      ticketId: resolved.ticket.id,
      // The explicit --title is already a user-set string. Otherwise the
      // deterministic kickoff heuristic gives the CLI door a meaningful
      // durable title before its detached first exchange begins.
      title: sessionTitle,
      actor: actor.actor,
      ...(model !== undefined || reasoning !== undefined
        ? {
            modelOverride: {
              ...(isModelRef(model) ? { model } : {}),
              ...(reasoning !== undefined ? { reasoningLevel: reasoning as ReasoningLevel } : {}),
            },
          }
        : {}),
    });
    // The kickoff rides only a ready attach — a Session that needs
    // recovery holds the first turn for the app's Retry — and it is
    // deliberately detached: the runtime answers a `message.submit` when
    // the TURN it started ends, and this reply is due as the session
    // opens, not when the agent finishes.
    if (started.state === "ready") {
      void Promise.resolve()
        .then(() => options.submitSessionMessage?.({ sessionId: started.sessionId, text: kickoff }))
        .catch((error: unknown) => {
          console.error(
            `[volli] kickoff for session ${shortSessionId(started.sessionId)} was not delivered: ${errorMessage(error)}`,
          );
        });
    }
    // Only the heuristic door refines: a session started with an
    // explicit --title is a person's naming and gets zero title calls.
    //
    // Gated on the same `ready` the kickoff delivery is gated on. A
    // Session held for recovery has not sent its first user message and
    // may never send this one — titling it from text nobody submitted
    // would spend a model call on a conversation that did not happen.
    if (typeof title !== "string" && started.state === "ready") {
      options.refineAutoTitle?.({
        sessionId: started.sessionId,
        firstMessage: kickoff,
        heuristicTitle: sessionTitle,
      });
    }
    options.onMutation?.({
      ticketId: resolved.ticket.id,
      projectId: resolved.project.id,
      kind: "session",
    });
    options.onSessionStarted?.({
      sessionId: started.sessionId,
      projectId: resolved.project.id,
      ticketId: resolved.ticket.id,
      ticketDisplayId: displayId,
      actor: actor.actor.kind,
      actorTicket:
        actor.actor.kind === "session"
          ? actorSessionTicketDisplay(options.db, projects, actor.actor.ticketId)
          : null,
      at: now(),
    });
    return {
      v: 1,
      ok: true,
      data: {
        session: shortSessionId(started.sessionId),
        ticket: displayId,
        state: started.state,
        model: `${started.model.providerId}/${started.model.modelId}`,
        reasoning: started.model.reasoningLevel,
      },
    };
  } catch (error) {
    // The facade's refusals land in the fixed vocabulary: the two model
    // errors keep their own names (exit class 1, auto-rendered into
    // `volli help exit-codes`); everything else failed to mutate.
    if (error instanceof StructuredSessionsError) {
      if (error.code === "DEFAULT_MODEL_REQUIRED") {
        return failure("MODEL_REQUIRED", error.message);
      }
      if (error.code === "MODEL_UNAVAILABLE") {
        return failure("MODEL_UNAVAILABLE", error.message);
      }
      return failure("MUTATION_FAILED", error.message);
    }
    return failure("MUTATION_FAILED", errorMessage(error));
  }
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
    // this source today (`session.signal` routes to no adapter).
    provenance: {
      source: { kind: "adapter", id: "terminal", detail: null },
      venue: { id: "local", kind: "local" },
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
