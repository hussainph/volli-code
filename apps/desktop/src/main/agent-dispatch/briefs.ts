/**
 * What an agent is told about why its Session exists, before a user tells it
 * anything.
 *
 * Two compositions, one per Session scope, and both have two callers by
 * design: a verb hands the string to a terminal harness that asked for it, and
 * the Pi Agent Runtime is handed the same string as its Runtime Brief.
 */

import {
  blobsSectionInput,
  composeAttachmentsSection,
  composeTicketPrompt,
  displayTicketId,
  worktreeOrientationPreamble,
} from "@volli/shared";
import type { Project, Ticket } from "@volli/shared";

/**
 * The Ticket Brief: everything an agent is told about why this Session exists,
 * before it is told anything by a user.
 *
 * One composition with two callers by design. The `volli ticket brief` verb
 * hands it to a terminal harness that asked for it; the Pi Agent Runtime is
 * handed the same string as its Runtime Brief. A second composition would drift
 * from this one the first time either side changed, and the difference would
 * read as the two harnesses disagreeing about the ticket.
 */
export function composeTicketBrief(input: {
  project: Pick<Project, "id" | "path" | "ticketPrefix">;
  ticket: Pick<
    Ticket,
    | "id"
    | "ticketNumber"
    | "title"
    | "body"
    | "usesWorktree"
    | "worktreePath"
    | "branch"
    | "baseBranch"
  >;
  attachments: Parameters<typeof blobsSectionInput>[0];
}): string {
  const displayId = displayTicketId(input.project.ticketPrefix, input.ticket.ticketNumber);
  const ticketPrompt = composeTicketPrompt({
    displayId,
    title: input.ticket.title,
    body: input.ticket.body,
  });
  // Runtime-Brief orientation is message-side Cache Prefix material (VC-164):
  // every execution root is concrete once it exists. A worktree-scoped Ticket
  // with no stamp is intentionally silent because its worktree has not
  // materialized yet; a no-worktree Ticket is different — the Main checkout is
  // already its final execution root and must be named rather than mistaken for
  // the same pending state.
  const orientation = input.ticket.usesWorktree
    ? input.ticket.worktreePath !== null && input.ticket.branch !== null
      ? worktreeOrientationPreamble({
          worktreePath: input.ticket.worktreePath,
          branch: input.ticket.branch,
          baseBranch: input.ticket.baseBranch,
          projectPath: input.project.path,
        }) + "\n\n"
      : ""
    : `This Ticket intentionally runs in the Main checkout at \`${input.project.path}\`. All work happens in this directory.\n\n`;
  // Attachments (CONCEPT decision #19): the brief is read-only — it never
  // materializes, only lists what session boot already did (or will do), via
  // the same deterministic relPath mapping main's `ensure` pipeline uses.
  // Relative paths are correct whether this session runs in the worktree or the
  // main checkout (cwd is the session root either way).
  const attachmentsSection = composeAttachmentsSection(blobsSectionInput(input.attachments));
  const attachmentsSuffix = attachmentsSection.length > 0 ? `\n\n${attachmentsSection}` : "";
  return `${orientation}Board coordination goes through the bundled \`volli\` CLI. Run \`volli help\` when you need its reference (and the volli skill, when installed, for norms).\n\n${ticketPrompt}${attachmentsSuffix}`;
}

/**
 * The Project Brief: what an agent is told when the Session has no Ticket.
 *
 * A ticketless chat has no prose to hand over and no isolated checkout to name,
 * so the brief says exactly that rather than leaving the agent to infer a
 * missing Ticket from a brief that never mentions one. The `volli` sentence is
 * the Ticket Brief's, verbatim: the board is reachable from here too, and two
 * wordings of one instruction would read as two different rules.
 */
export function composeProjectBrief(input: { project: Pick<Project, "path"> }): string {
  return `This is a project-scoped chat Session with no Ticket. Your working directory is the project root at ${input.project.path}.\n\nBoard coordination goes through the bundled \`volli\` CLI. Run \`volli help\` when you need its reference (and the volli skill, when installed, for norms).`;
}
