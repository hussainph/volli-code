/**
 * The ticket write verbs exposed on the Agent CLI: create, update, move,
 * comment, and signal. Archive is app-only curation (VC-163).
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
  TicketEventActorKind,
} from "@volli/shared";

import { getRegisteredHarness } from "../db/harness-registry-repo";
import { listTicketsByProject } from "../db/tickets-repo";
import {
  createTicketCommand,
  createTicketCommentCommand,
  createTicketSignalCommand,
  interruptOnBackwardMove,
  moveTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  updateTicketFieldsCommand,
} from "../ticket-commands";
import { emitTicketWakesSince, withTicketWake } from "../ticket-wake";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { dryRunResponse } from "./preview";
import {
  actorSessionTicketDisplay,
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
  const { options, projects, envSession, now, newId, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const actor = resolvedActor.actor;
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
      { now: createdAt, actor },
    );
    // The wake goes out after the create's transaction returned, and with no
    // mark to take: a ticket that did not exist a moment ago has no events its
    // creation did not write (VC-85).
    emitTicketWakesSince(options.db, ticket.id, 0);
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
  const { options, projects, now, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const actor = resolvedActor.actor;
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
        { now: updatedAt, actor },
      );
      if (isTicketPriority(priority) && priority !== resolved.ticket.priority) {
        ticket = setTicketPriorityCommand(
          options.db,
          { ticketId: resolved.ticket.id, priority },
          { now: updatedAt, actor },
        );
      }
      const currentLabels = resolved.ticket.labels;
      const requestedLabels = currentLabels
        .filter((label) => !removeLabels.includes(label))
        .concat(addLabels.filter((label) => !currentLabels.includes(label)));
      ticket = setTicketLabelsCommand(
        options.db,
        { ticketId: resolved.ticket.id, labels: requestedLabels },
        { now: updatedAt, actor },
      );
      return ticket;
    });
    // One command, up to three events (fields, priority, labels), and the wake
    // carries each of them in the order they were written — after the
    // transaction, never inside it.
    const updated = withTicketWake(options.db, resolved.ticket.id, run);
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

/**
 * What the into-Doing notification says about who moved it.
 *
 * Total over {@link TicketEventActorKind} so a kind added later fails to
 * compile here rather than falling into someone else's sentence — which is
 * exactly how `unauthenticated` would have been announced as a Session had the
 * old `else` branch survived it.
 *
 * `via` is the display id of the Ticket the DRIVING Session is itself working,
 * and only the session sentence has ever named it.
 *
 * `user` is unreachable over the socket (VC-163) and is kept for totality
 * rather than for behaviour: this door cannot authenticate a person, and the
 * app's own moves never reach this verb.
 */
function moveNotificationBody(kind: TicketEventActorKind, via: string | null): string {
  switch (kind) {
    case "automation":
      return "Moved by automation";
    case "unauthenticated":
      return "Moved by an unauthenticated caller";
    case "session":
      return via ? `Moved via ${via}'s session` : "Moved via a session";
    case "user":
      return "Moved by you";
  }
}

/** `volli ticket move` — a ticket to another column. */
export async function ticketMoveVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, now, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const actor = resolvedActor.actor;
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
    // The wake fires here rather than after the interrupt below, because the
    // move is what a waiter is waiting for and it is already durable — an
    // interrupt that fails afterwards does not un-move the ticket.
    const moved = withTicketWake(options.db, resolved.ticket.id, () =>
      moveTicketCommand(
        options.db,
        {
          projectId: resolved.project.id,
          ticketId: resolved.ticket.id,
          toStatus: to,
          toIndex,
        },
        { now: movedAt, actor },
      ),
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
    // Guardrail is visibility, not caps (decision 2): an entry into Doing that
    // a person did not make at the keyboard fires a native notification.
    // Same-column moves already returned above, so reaching here with
    // to === "doing" means the prior status wasn't.
    //
    // Every actor this door can produce is notifiable, which is why there is no
    // "stays silent" case left to test for. The `user` actor no longer arrives
    // over this door at all (VC-163): the socket cannot authenticate a person,
    // so the plain-CLI move that used to be attributed to one is now
    // `unauthenticated` — and that case is the loudest of the three rather than
    // the quietest. A caller Volli could not identify, pushing work into the
    // active column, is the told-to-work-on-changes vector VC-92 §3 named. The
    // body says what is unknown about it rather than inventing a party.
    if (to === "doing") {
      const movedDisplay = displayTicketId(
        resolved.project.ticketPrefix,
        resolved.ticket.ticketNumber,
      );
      // Resolved only for the one sentence that names it, so an automation
      // move costs no ticket lookup — exactly as before.
      const via =
        actor.kind === "session"
          ? actorSessionTicketDisplay(options.db, projects, actor.ticketId)
          : null;
      options.notify?.(
        `${movedDisplay} → ${TICKET_STATUS_LABELS[to]}`,
        moveNotificationBody(actor.kind, via),
      );
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
  const { options, projects, now, actor: attribution } = context;
  const resolvedActor = attributedActor(attribution);
  if (!resolvedActor.ok) return resolvedActor.response;
  const actor = resolvedActor.actor;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
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
    const comment = withTicketWake(options.db, resolved.ticket.id, () =>
      createTicketCommentCommand(
        options.db,
        {
          ticketId: resolved.ticket.id,
          body: message,
          // From the RESOLVED actor, never from `request.ctx.env.session` (VC-163).
          // Reading the raw claim here was a second, independent derivation of
          // the same fact, and the two could disagree in exactly the case that
          // matters: a forged `VOLLI_SESSION` with no token attributes the EVENT
          // as unauthenticated while stamping the COMMENT with the Session it
          // named — a row citing a Session that did not write it.
          //
          // The comment's actor column stores the kind verbatim; only a
          // `session` carries an id to cite beside it.
          commentActor: actor.kind,
          sessionId: actor.kind === "session" ? actor.sessionId : null,
        },
        { now: now(), actor },
      ),
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
