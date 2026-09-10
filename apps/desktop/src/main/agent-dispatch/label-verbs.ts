/**
 * The label cleanup verb (VC-310).
 *
 * Case identity is not this file's job — the repo boundary and migration 043
 * make `UI` and `ui` one label before any caller gets here. What is left is
 * the duplicate a machine cannot detect: two genuinely different names that a
 * person knows mean the same thing (`front-end`, `frontend`). Folding those is
 * a judgement, so it is a tool a person drives rather than a rule the app
 * enforces.
 *
 * The preview is the DEFAULT, and `--apply` is the way to write. Every other
 * mutation verb previews under `--dry-run` and writes by default, which is the
 * right shape when the write is attributable and reversible — a comment can be
 * read and answered, a move can be moved back. This one is project-wide: it
 * retires one Label and rewrites the organisation of Tickets nobody is looking at.
 * The ticket's requirement is exactly that, "do not silently rewrite existing
 * organisation", and a flag a caller must remember to add would not have kept
 * it.
 */

import { displayTicketId } from "@volli/shared";
import type { AgentRequest, AgentResponse, Label } from "@volli/shared";

import { findLabelByName, findLabelRetirement, listLabelsByProject } from "../db/labels-repo";
import { mergeLabelsCommand, planLabelMerge, type LabelMergePlan } from "../ticket-commands";
import { emitTicketWakesSince, markTicketWake } from "../ticket-wake";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { attributedActor, projectForCreate } from "./resolution";

/** The two names a merge needs, or the refusal that says which one was wrong. */
function requireName(
  raw: unknown,
  option: string,
): { ok: true; name: string } | { ok: false; response: AgentResponse } {
  if (typeof raw === "string" && raw.trim().length > 0) return { ok: true, name: raw };
  return {
    ok: false,
    response: failure("INVALID_REQUEST", `label merge requires ${option} <name>.`),
  };
}

/**
 * A refusal that NAMES the project's vocabulary rather than only reporting the
 * miss: the caller misspelled one of a knowable, usually short list, and the
 * answer to "which labels are there" should not cost a second round trip.
 */
function unknownLabelRefusal(name: string, known: readonly Label[]): AgentResponse {
  const vocabulary = known.map((label) => label.name).toSorted();
  return failure(
    "INVALID_REQUEST",
    `This project has no label named ${name}.`,
    vocabulary.length > 0
      ? `Its labels are: ${vocabulary.join(", ")}.`
      : "It has no labels at all yet.",
  );
}

/** The complete public blast radius, including Tickets outside the live Board. */
function publicMergeTickets(plan: LabelMergePlan, ticketPrefix: string) {
  return plan.tickets.map((ticket) => ({
    id: displayTicketId(ticketPrefix, ticket.ticketNumber),
    title: ticket.title,
    archived: ticket.archived,
  }));
}

/** `volli label merge` — fold one label into another, previewing unless told to apply. */
export async function labelMergeVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, now } = context;
  const resolved = projectForCreate(options.db, projects, envSession, request);
  if (!resolved.ok) return resolved.response;
  const project = resolved.project;
  const resolvedActor = attributedActor(context.actor);
  if (!resolvedActor.ok) return resolvedActor.response;

  const from = requireName(request.args["from"], "--from");
  if (!from.ok) return from.response;
  const into = requireName(request.args["into"], "--into");
  if (!into.ok) return into.response;

  const projectLabels = listLabelsByProject(options.db, project.id);
  const fromLabel = findLabelByName(options.db, project.id, from.name);
  if (fromLabel === undefined) return unknownLabelRefusal(from.name, projectLabels);
  const intoLabel = findLabelByName(options.db, project.id, into.name);
  if (intoLabel === undefined) return unknownLabelRefusal(into.name, projectLabels);
  if (fromLabel.id === intoLabel.id) {
    const retirement = [from.name, into.name]
      .map((name) => findLabelRetirement(options.db, project.id, name))
      .find((candidate) => candidate?.intoId === fromLabel.id);
    return retirement
      ? failure(
          "INVALID_REQUEST",
          `${retirement.name} was already merged into ${retirement.intoName}.`,
          `Use ${retirement.intoName}; the retired name already resolves there.`,
        )
      : failure(
          "INVALID_REQUEST",
          `${from.name} and ${into.name} are already the same label.`,
          "Merging a label into itself would change nothing.",
        );
  }

  const plan = planLabelMerge(options.db, {
    fromLabelId: fromLabel.id,
    intoLabelId: intoLabel.id,
  });
  const preview = publicMergeTickets(plan, project.ticketPrefix);

  if (request.args["apply"] !== true) {
    return {
      v: 1,
      ok: true,
      data: {
        applied: false,
        from: fromLabel.name,
        into: intoLabel.name,
        tickets: preview,
        // Said plainly, because the preview is the whole safety story: the
        // caller has to know this run changed nothing.
        next: `Re-run with --apply to move ${preview.length} Ticket(s) onto ${intoLabel.name} and retire ${fromLabel.name} as an alias.`,
      },
    };
  }

  const wakeMarks = new Map(
    plan.tickets.map((ticket) => [ticket.id, markTicketWake(options.db, ticket.id)]),
  );
  const applied = mergeLabelsCommand(
    options.db,
    { fromLabelId: fromLabel.id, intoLabelId: intoLabel.id },
    { now: now(), actor: resolvedActor.actor },
  );
  for (const ticket of applied.tickets) {
    emitTicketWakesSince(options.db, ticket.id, wakeMarks.get(ticket.id) ?? 0);
  }
  // One Project-scoped invalidation is both cheaper and more honest than one
  // callback per Ticket: the Label vocabulary itself changed, including when
  // the source Label had no Ticket associations.
  options.onMutation?.({ projectId: project.id, kind: "ticket" });

  return {
    v: 1,
    ok: true,
    data: {
      applied: true,
      from: applied.from.name,
      into: applied.into.name,
      tickets: publicMergeTickets(applied, project.ticketPrefix),
    },
  };
}
