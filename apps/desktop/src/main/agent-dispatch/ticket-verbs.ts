/**
 * The ticket write verbs: create, update, move, comment, signal, archive.
 *
 * Coordination tier — every one of them wants an authenticated session actor,
 * every one commits through `ticket-commands.ts` rather than touching a repo
 * directly, and every one that COMMITS tells `onMutation` the exact ticket it
 * touched so the renderer refreshes the right surfaces. A no-op (a same-column
 * move) deliberately reports nothing.
 */

import type Database from "better-sqlite3";
import {
  applyTicketBodyMutation,
  displayTicketId,
  errorMessage,
  FIRST_CLASS_HARNESS_IDS,
  isFirstClassHarnessId,
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
} from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  HarnessId,
  Ticket,
  TicketBodyMutation,
} from "@volli/shared";

import { getRegisteredHarness } from "../db/harness-registry-repo";
import { listTicketsByProject } from "../db/tickets-repo";
import {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  createTicketSignalCommand,
  interruptOnBackwardMove,
  moveTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  updateTicketFieldsCommand,
} from "../ticket-commands";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { dryRunResponse } from "./preview";
import {
  actorSessionTicketDisplay,
  invalidPriorityResponse,
  projectForCreate,
  requestActor,
  ticketForDisplayId,
} from "./resolution";
import { agentTicket } from "./wire";

/**
 * The harness twin of {@link invalidPriorityResponse}, with the one thing a
 * priority does not have: a vocabulary that grows. A registered manifest is a
 * harness the user brought and confirmed the bytes of, and there is no reason
 * `volli` may not name one — the CLI simply cannot check it. Which slugs exist,
 * and which of them a human actually ruled on, is this process's registry, so
 * the parser vets the shape and the whole of the judgement lives here.
 *
 * Trust, not registration, is the property. A `blocked` row is a harness someone
 * looked at and said no to; pinning a ticket to it would queue a launch that can
 * never happen, and would do it silently. The two refusals are separate
 * sentences because they ask for opposite things — register the harness, or go
 * and trust the one already sitting there.
 *
 * Returns the resolved id rather than a bare verdict, so the call sites stamp
 * exactly what was checked instead of re-narrowing the raw argument and quietly
 * dropping everything but the first-class four.
 */
function resolveRequestedHarness(
  db: Database.Database,
  value: unknown,
): { ok: true; harnessId: HarnessId | undefined } | { ok: false; response: AgentResponse } {
  if (value === undefined) return { ok: true, harnessId: undefined };
  const parsed = typeof value === "string" ? parseHarnessId(value) : null;
  if (parsed === null) {
    return {
      ok: false,
      response: failure(
        "INVALID_REQUEST",
        `Invalid harness ${JSON.stringify(value)} (valid: ${FIRST_CLASS_HARNESS_IDS.join(", ")}, or a registered, trusted harness)`,
        "Use a built-in id or the exact slug of a registered, trusted harness, then retry.",
      ),
    };
  }
  if (isFirstClassHarnessId(parsed)) return { ok: true, harnessId: parsed };
  const registered = getRegisteredHarness(db, parsed);
  if (registered === undefined) {
    return {
      ok: false,
      response: failure(
        "INVALID_REQUEST",
        `Unknown harness ${JSON.stringify(value)} — no harness by that name is registered (built in: ${FIRST_CLASS_HARNESS_IDS.join(", ")})`,
        "Register that harness through the app or use one of the built-in ids named in the refusal.",
      ),
    };
  }
  if (registered.decision !== "trusted") {
    return {
      ok: false,
      response: failure(
        "INVALID_REQUEST",
        `Harness ${JSON.stringify(value)} is registered but not trusted, so nothing can launch on it.`,
        "Review and trust that harness in the app, or choose a trusted harness, before retrying.",
      ),
    };
  }
  return { ok: true, harnessId: parsed };
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

/** `volli ticket create` — a new ticket, in Backlog unless told otherwise. */
export async function ticketCreateVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now, newId } = context;
  const resolved = projectForCreate(options.db, projects, envSession, request);
  if (!resolved.ok) return resolved.response;
  const createPriorityError = invalidPriorityResponse(request.args["priority"]);
  if (createPriorityError) return createPriorityError;
  const requestedHarness = resolveRequestedHarness(options.db, request.args["harness"]);
  if (!requestedHarness.ok) return requestedHarness.response;
  const title = request.args["title"];
  const status = request.args["status"] ?? "backlog";
  const priority = request.args["priority"] ?? "medium";
  const labels = request.args["labels"] ?? [];
  const base = request.args["base"];
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    !isTicketStatus(status) ||
    !isTicketPriority(priority) ||
    (base !== undefined && (typeof base !== "string" || !isValidBranchName(base))) ||
    !Array.isArray(labels) ||
    !labels.every((label) => typeof label === "string")
  ) {
    return failure("INVALID_REQUEST", "Invalid ticket create arguments.");
  }
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  const createPreview = dryRunResponse(request, {
    kind: "project",
    id: resolved.project.ticketPrefix,
    label: `${resolved.project.name} (${resolved.project.ticketPrefix})`,
  });
  if (createPreview !== null) return createPreview;

  try {
    const createdAt = now();
    const ticket = createTicketCommand(
      options.db,
      {
        id: newId(),
        projectId: resolved.project.id,
        title: title.trim(),
        body: typeof request.args["body"] === "string" ? request.args["body"] : "",
        status,
        priority,
        labels,
        usesWorktree:
          typeof request.args["usesWorktree"] === "boolean" ? request.args["usesWorktree"] : true,
        preferredHarnessId: requestedHarness.harnessId,
        // An explicit per-ticket override only (decision 11). `null` means
        // "inherit the pinned project setting" — resolved late by worktree
        // automation at use time, NOT stamped here from a snapshot.
        baseBranch: typeof base === "string" ? base : null,
      },
      { now: createdAt, actor: actor.actor },
    );
    options.onMutation?.({
      ticketId: ticket.id,
      projectId: resolved.project.id,
      kind: "ticket",
    });
    return {
      v: 1,
      ok: true,
      data: { ticket: agentTicket(ticket, resolved.project) },
    };
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
}

/** `volli ticket update` — a ticket's fields or body, in one transaction. */
export async function ticketUpdateVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  const title = request.args["title"];
  const priority = request.args["priority"];
  const base = request.args["base"];
  const mutation = request.args["bodyMutation"];
  const addLabels = request.args["addLabels"] ?? [];
  const removeLabels = request.args["removeLabels"] ?? [];
  const updatePriorityError = invalidPriorityResponse(priority);
  if (updatePriorityError) return updatePriorityError;
  const requestedHarness = resolveRequestedHarness(options.db, request.args["harness"]);
  if (!requestedHarness.ok) return requestedHarness.response;
  if (
    (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) ||
    (base !== undefined && (typeof base !== "string" || !isValidBranchName(base))) ||
    (mutation !== undefined && !isBodyMutation(mutation)) ||
    !Array.isArray(addLabels) ||
    !addLabels.every((label) => typeof label === "string") ||
    !Array.isArray(removeLabels) ||
    !removeLabels.every((label) => typeof label === "string")
  ) {
    return failure("INVALID_REQUEST", "Invalid ticket update arguments.");
  }
  const nextBody = mutation ? applyTicketBodyMutation(resolved.ticket.body, mutation) : undefined;
  if (nextBody && !nextBody.ok) {
    return failure(nextBody.code, nextBody.message);
  }
  const updateDisplayId = displayTicketId(
    resolved.project.ticketPrefix,
    resolved.ticket.ticketNumber,
  );
  const updatePreview = dryRunResponse(request, {
    kind: "ticket",
    id: updateDisplayId,
    label: updateDisplayId,
  });
  if (updatePreview !== null) return updatePreview;
  try {
    const updatedAt = now();
    const run = options.db.transaction((): Ticket => {
      let ticket = updateTicketFieldsCommand(
        options.db,
        {
          ticketId: resolved.ticket.id,
          ...(typeof title === "string" ? { title: title.trim() } : {}),
          ...(nextBody?.ok ? { body: nextBody.body } : {}),
          ...(typeof base === "string" ? { baseBranch: base } : {}),
          ...(requestedHarness.harnessId !== undefined
            ? { preferredHarnessId: requestedHarness.harnessId }
            : {}),
        },
        { now: updatedAt, actor: actor.actor },
      );
      if (isTicketPriority(priority) && priority !== resolved.ticket.priority) {
        ticket = setTicketPriorityCommand(
          options.db,
          { ticketId: resolved.ticket.id, priority },
          { now: updatedAt, actor: actor.actor },
        );
      }
      const currentLabels = resolved.ticket.labels;
      const requestedLabels = currentLabels
        .filter((label) => !removeLabels.includes(label))
        .concat(addLabels.filter((label) => !currentLabels.includes(label)));
      ticket = setTicketLabelsCommand(
        options.db,
        { ticketId: resolved.ticket.id, labels: requestedLabels },
        { now: updatedAt, actor: actor.actor },
      );
      return ticket;
    });
    const updated = run();
    options.onMutation?.({
      ticketId: resolved.ticket.id,
      projectId: resolved.project.id,
      kind: "ticket",
    });
    return {
      v: 1,
      ok: true,
      data: { ticket: agentTicket(updated, resolved.project) },
    };
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
}

/** `volli ticket move` — a ticket to another column. */
export async function ticketMoveVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  const to = request.args["to"];
  if (!isTicketStatus(to)) {
    return failure("INVALID_REQUEST", "ticket move requires a valid destination column.");
  }
  const moveDisplayId = displayTicketId(
    resolved.project.ticketPrefix,
    resolved.ticket.ticketNumber,
  );
  // A CLI move carries column semantics only (no drop index), so a move to
  // the column the ticket already occupies is an idempotent no-op — never
  // a reorder to the bottom, and no status event. Returned unchanged.
  if (resolved.ticket.status === to) {
    const noOpPreview = dryRunResponse(
      request,
      { kind: "ticket", id: moveDisplayId, label: moveDisplayId },
      {
        durableWrites: [],
        humanVisibleEffects: [],
        nonEffects: [
          `The Ticket is already in ${TICKET_STATUS_LABELS[to]}; no row, event, Session, or notification would be created.`,
        ],
      },
    );
    if (noOpPreview !== null) return noOpPreview;
    return {
      v: 1,
      ok: true,
      data: { ticket: agentTicket(resolved.ticket, resolved.project) },
    };
  }
  const movePreview = dryRunResponse(request, {
    kind: "ticket",
    id: moveDisplayId,
    label: moveDisplayId,
  });
  if (movePreview !== null) return movePreview;
  try {
    const movedAt = now();
    const before = listTicketsByProject(options.db, resolved.project.id);
    const toIndex = before.filter((ticket) => ticket.status === to).length;
    const moved = moveTicketCommand(
      options.db,
      {
        projectId: resolved.project.id,
        ticketId: resolved.ticket.id,
        toStatus: to,
        toIndex,
      },
      { now: movedAt, actor: actor.actor },
    );
    const ticket = moved.find(({ id }) => id === resolved.ticket.id)!;
    // Backward-move interrupt (issue #78): the move committed above, so the
    // interrupt runs as its side effect. `resolved.ticket.status` is the
    // pre-move status (same-column no-ops already returned above).
    try {
      await interruptOnBackwardMove(
        {
          ticketId: resolved.ticket.id,
          fromStatus: resolved.ticket.status,
          toStatus: to,
        },
        options.interruptTicketSessions,
      );
    } catch (error) {
      console.error(
        `[volli] failed to interrupt sessions after moving ${resolved.ticket.id}: ${errorMessage(error)}`,
      );
    }
    // Guardrail is visibility, not caps (decision 2): an agent- or
    // automation-initiated entry into Doing fires a native notification.
    // A plain CLI move (no session env → user actor, "the door not the
    // keyboard") stays silent; same-column moves already returned above,
    // so reaching here with to === "doing" means the prior status wasn't.
    if (to === "doing" && actor.actor.kind !== "user") {
      const movedDisplay = displayTicketId(
        resolved.project.ticketPrefix,
        resolved.ticket.ticketNumber,
      );
      let body: string;
      if (actor.actor.kind === "automation") {
        body = "Moved by automation";
      } else {
        const via = actorSessionTicketDisplay(options.db, projects, actor.actor.ticketId);
        body = via ? `Moved via ${via}'s session` : "Moved via a session";
      }
      options.notify?.(`${movedDisplay} → ${TICKET_STATUS_LABELS[to]}`, body);
    }
    options.onMutation?.({
      ticketId: resolved.ticket.id,
      projectId: resolved.project.id,
      kind: "ticket",
    });
    return {
      v: 1,
      ok: true,
      data: { ticket: agentTicket(ticket, resolved.project) },
    };
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
}

/** `volli ticket comment` — a comment on a ticket. */
export async function ticketCommentVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  const message = request.args["message"];
  if (typeof message !== "string" || message.trim().length === 0) {
    return failure("INVALID_REQUEST", "ticket comment requires a message.");
  }
  const commentPreview = dryRunResponse(request, {
    kind: "ticket",
    id: displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber),
    label: displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber),
  });
  if (commentPreview !== null) return commentPreview;
  try {
    const comment = createTicketCommentCommand(
      options.db,
      {
        ticketId: resolved.ticket.id,
        body: message,
        commentActor: request.ctx.env.session ? "session" : "user",
        sessionId: request.ctx.env.session ?? null,
      },
      { now: now(), actor: actor.actor },
    );
    options.onMutation?.({
      ticketId: resolved.ticket.id,
      projectId: resolved.project.id,
      kind: "comment",
    });
    return {
      v: 1,
      ok: true,
      data: {
        comment: {
          ticket: displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber),
          body: comment.body,
          actor: comment.actor,
          session: comment.sessionId ? shortSessionId(comment.sessionId) : null,
          createdAt: comment.createdAt,
        },
      },
    };
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
}

/**
 * `volli ticket signal` — one typed verdict on a ticket (VC-85).
 *
 * The verb that replaces the `VERDICT: FIRST-LINE` comment convention, and the
 * three refusals below are what a convention could not have. A kind outside the
 * vocabulary is named with the vocabulary; a missing `VOLLI_SESSION` is refused
 * outright rather than attributed to "user", because a verdict is worth what
 * its signer is; and the board is not touched on any path.
 *
 * The session requirement is the one thing here that is not like
 * `ticket.comment`, and it is deliberate (VC-92): comments are prose anybody
 * may leave, signals are state a machine will act on. VC-163 turns the
 * `VOLLI_SESSION` this reads from an attribution into an authentication; the
 * shape of the refusal does not change when it does.
 */
export async function ticketSignalVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const envSessionId = request.ctx.env.session;
  if (!envSessionId) {
    return failure(
      "CONTEXT_REQUIRED",
      "ticket signal requires VOLLI_SESSION context: a verdict records who reached it.",
      "Run it from inside a Volli session, or use ticket comment to leave prose from an unattributed shell.",
    );
  }
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  const kind = request.args["kind"];
  if (!isTicketSignalKind(kind)) {
    return failure(
      "INVALID_REQUEST",
      `Unknown signal kind ${JSON.stringify(kind ?? null)} (valid: ${TICKET_SIGNAL_KINDS.join(", ")})`,
      "Retry with one of the named kinds; the vocabulary is fixed so signals stay queryable.",
    );
  }
  const verdict = request.args["verdict"];
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
  // Trimmed to null rather than stored as "": an empty detail is the absence of
  // one, and two spellings of absence is a distinction every reader downstream
  // would have to keep making.
  const detail =
    typeof detailValue === "string" && detailValue.trim().length > 0 ? detailValue : null;
  const signalDisplayId = displayTicketId(
    resolved.project.ticketPrefix,
    resolved.ticket.ticketNumber,
  );
  try {
    const signal = createTicketSignalCommand(
      options.db,
      {
        ticketId: resolved.ticket.id,
        kind,
        verdict,
        detail,
        signalActor: "session",
        sessionId: envSessionId,
      },
      { now: now(), actor: actor.actor },
    );
    options.onMutation?.({
      ticketId: resolved.ticket.id,
      projectId: resolved.project.id,
      kind: "ticket",
    });
    return {
      v: 1,
      ok: true,
      data: {
        signal: {
          ticket: signalDisplayId,
          kind: signal.kind,
          verdict: signal.verdict,
          detail: signal.detail,
          session: signal.sessionId ? shortSessionId(signal.sessionId) : null,
          createdAt: signal.createdAt,
        },
      },
    };
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
}

/** `volli ticket archive` — a ticket, its worktree preserved. */
export async function ticketArchiveVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const actor = requestActor(request, envSession);
  if (!actor.ok) return actor.response;
  try {
    const archivedAt = now();
    archiveTicketCommand(options.db, resolved.ticket.id, {
      now: archivedAt,
      actor: actor.actor,
    });
    options.onMutation?.({
      ticketId: resolved.ticket.id,
      projectId: resolved.project.id,
      kind: "ticket",
    });
    return {
      v: 1,
      ok: true,
      data: {
        ticket: {
          id: displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber),
          archived: true,
          archivedAt,
        },
      },
    };
  } catch (error) {
    return failure("MUTATION_FAILED", errorMessage(error));
  }
}
