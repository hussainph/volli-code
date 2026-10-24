/**
 * The ticket write verbs exposed on the Agent CLI: create, update, move,
 * comment, and signal. Archive is app-only curation (VC-163).
 *
 * Coordination tier — every one of them wants an authenticated session actor.
 * Create, update, move and comment are projections of the host's handler map
 * (VC-668, VC-794): this file maps the request and the answer, and the write,
 * its wakes, its feed rows and its `data-changed` are the handler's, whichever
 * door asked. `ticket.signal` has no map entry yet: it commits through
 * `ticket-commands.ts` and tells `onMutation` the ticket it touched. A no-op
 * (a same-column move) deliberately reports nothing.
 */

import { randomUUID } from "node:crypto";
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
import type { AgentRequest, AgentResponse, HarnessId, TicketBodyMutation } from "@volli/shared";

import { getRegisteredHarness } from "../db/harness-registry-repo";
import { createTicketSignalCommand } from "../ticket-commands";
import { withTicketWake } from "../ticket-wake";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { dryRunResponse } from "./preview";
import type { SocketDecode } from "./projection";
import {
  attributedActor,
  invalidPriorityResponse,
  projectForCreate,
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

/**
 * The `commandId` a projected board write records its receipt under. NDJSON
 * v1 carries no command id, so the door mints one per request (HP § Command
 * catalog): the write is receipted like any board command, and a socket retry
 * is still not deduplicated, as before.
 */
function socketCommandId(): string {
  return randomUUID();
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
 * `volli ticket create` — a new ticket, in Backlog unless told otherwise: the
 * socket's projection of `board.createTicket` (VC-794). This maps the request
 * (the project, the arguments, a dry-run preview) and the answer; the write,
 * its wake and its feed rows are the handler's.
 */
export const ticketCreateDecode: SocketDecode<"board.createTicket"> = (context, request) => {
  const { options, projects, envSession, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
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
  const createPreview = dryRunResponse(request, {
    kind: "project",
    id: resolved.project.ticketPrefix,
    label: `${resolved.project.name} (${resolved.project.ticketPrefix})`,
  });
  if (createPreview !== null) return createPreview;
  return {
    input: {
      commandId: socketCommandId(),
      projectId: resolved.project.id,
      title: title.trim(),
      body: typeof request.args["body"] === "string" ? request.args["body"] : "",
      status,
      priority,
      labels,
      usesWorktree:
        typeof request.args["usesWorktree"] === "boolean" ? request.args["usesWorktree"] : true,
      ...(requestedHarness.harnessId === undefined
        ? {}
        : { preferredHarnessId: requestedHarness.harnessId }),
      // An explicit per-ticket override only (decision 11). `null` means
      // "inherit the pinned project setting" — resolved late by worktree
      // automation at use time, NOT stamped here from a snapshot.
      baseBranch: typeof base === "string" ? base : null,
    },
    call: { actor: resolvedActor.actor },
    reply: ({ ticket }) => ({
      v: 1,
      ok: true,
      data: { ticket: agentTicket(ticket, resolved.project) },
    }),
  };
};

/**
 * `volli ticket update` — a ticket's fields, priority, labels or body: the
 * socket's projection of `board.updateTicket` (VC-794), one command and so one
 * transaction and one wake. The body mutation is checked here against the
 * body as read, so its refusal keeps its own code, and applied again by the
 * handler to the body as it stands inside the write.
 */
export const ticketUpdateDecode: SocketDecode<"board.updateTicket"> = (context, request) => {
  const { options, projects, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
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
  return {
    input: {
      commandId: socketCommandId(),
      ticketId: resolved.ticket.id,
      ...(typeof title === "string" ? { title: title.trim() } : {}),
      ...(isBodyMutation(mutation) ? { bodyMutation: mutation } : {}),
      ...(typeof base === "string" ? { baseBranch: base } : {}),
      ...(requestedHarness.harnessId !== undefined
        ? { preferredHarnessId: requestedHarness.harnessId }
        : {}),
      ...(isTicketPriority(priority) ? { priority } : {}),
      ...(addLabels.length > 0 ? { addLabels } : {}),
      ...(removeLabels.length > 0 ? { removeLabels } : {}),
    },
    call: { actor: resolvedActor.actor },
    reply: ({ ticket }) => ({
      v: 1,
      ok: true,
      data: { ticket: agentTicket(ticket, resolved.project) },
    }),
  };
};

/**
 * `volli ticket move` — a ticket to another column: the socket's projection
 * of the host's `ticket.move` handler (VC-668). This maps the request (the
 * display id, the column, a no-op or dry-run preview) and the answer (the
 * moved ticket); the move and every effect it has are the handler's.
 */
export const ticketMoveDecode: SocketDecode<"ticket.move"> = (context, request) => {
  const { options, projects, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
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
  }
  const movePreview = dryRunResponse(request, {
    kind: "ticket",
    id: moveDisplayId,
    label: moveDisplayId,
  });
  if (movePreview !== null) return movePreview;
  return {
    input: { projectId: resolved.project.id, ticketId: resolved.ticket.id, toStatus: to },
    call: { actor: resolvedActor.actor },
    reply: (tickets) => ({
      v: 1,
      ok: true,
      data: {
        ticket: agentTicket(
          tickets.find(({ id }) => id === resolved.ticket.id)!,
          resolved.project,
        ),
      },
    }),
  };
};

/**
 * `volli ticket comment` — a comment on a ticket: the socket's projection of
 * `board.createComment` (VC-794). The handler takes its author from the
 * call's actor, never from the request.
 */
export const ticketCommentDecode: SocketDecode<"board.createComment"> = (context, request) => {
  const { options, projects, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const message = request.args["message"];
  if (typeof message !== "string" || message.trim().length === 0) {
    return failure("INVALID_REQUEST", "ticket comment requires a message.");
  }
  const commentDisplayId = displayTicketId(
    resolved.project.ticketPrefix,
    resolved.ticket.ticketNumber,
  );
  const commentPreview = dryRunResponse(request, {
    kind: "ticket",
    id: commentDisplayId,
    label: commentDisplayId,
  });
  if (commentPreview !== null) return commentPreview;
  return {
    input: { commandId: socketCommandId(), ticketId: resolved.ticket.id, body: message },
    // From the RESOLVED actor, never from `request.ctx.env.session` (VC-163).
    // Reading the raw claim was a second, independent derivation of the same
    // fact, and the two could disagree in exactly the case that matters: a
    // forged `VOLLI_SESSION` with no token attributes the EVENT as
    // unauthenticated while stamping the COMMENT with the Session it named —
    // a row citing a Session that did not write it. The handler stores the
    // actor's kind and, only for a `session`, the id it cites.
    call: { actor: resolvedActor.actor },
    reply: ({ comment }) => ({
      v: 1,
      ok: true,
      data: {
        comment: {
          ticket: commentDisplayId,
          body: comment.body,
          actor: comment.actor,
          session: comment.sessionId ? shortSessionId(comment.sessionId) : null,
          createdAt: comment.createdAt,
        },
      },
    }),
  };
};

/**
 * `volli ticket signal` — one typed verdict on a ticket (VC-85).
 *
 * The verb that replaces the `VERDICT: FIRST-LINE` comment convention, and the
 * three refusals below are what a convention could not have. A kind outside the
 * vocabulary is named with the vocabulary; a caller without an authenticated
 * attachment token is refused outright, because a verdict is worth what its
 * signer is; and the board is not touched on any path.
 *
 * This check remains hard even if a project grants another coordination verb
 * to unauthenticated callers: policy may widen who can comment, but cannot mint
 * a signer for a machine-readable verdict. The authenticated Session also
 * scopes the target project, so neither admission nor attribution can be
 * borrowed across projects.
 */
export async function ticketSignalVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const actor = resolvedActor.actor;
  if (actor.kind !== "session" || envSession === null) {
    return failure(
      "FORBIDDEN_ACTOR",
      "ticket.signal requires an authenticated Volli Session; an unauthenticated caller cannot sign a verdict.",
      "Run it from inside the live Session attachment whose VOLLI_SESSION_TOKEN authenticates the signer.",
    );
  }
  const project = projects.find(({ id }) => id === envSession.projectId);
  if (project === undefined) {
    return failure("PROJECT_NOT_FOUND", "The authenticated Session's project no longer exists.");
  }
  const resolved = ticketForDisplayId(options.db, [project], request.args["id"]);
  if (!resolved.ok) return resolved.response;
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
  const signalPreview = dryRunResponse(request, {
    kind: "ticket",
    id: signalDisplayId,
    label: signalDisplayId,
  });
  if (signalPreview !== null) return signalPreview;
  try {
    // The wake a waiter is most likely parked on (VC-85): a verdict is the
    // fact another Session delegated work to find out.
    const signal = withTicketWake(options.db, resolved.ticket.id, () =>
      createTicketSignalCommand(
        options.db,
        {
          ticketId: resolved.ticket.id,
          kind,
          verdict,
          detail,
          signalActor: "session",
          sessionId: actor.sessionId,
        },
        { now: now(), actor },
      ),
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
