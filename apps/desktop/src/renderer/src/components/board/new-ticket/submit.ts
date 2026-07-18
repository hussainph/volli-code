/**
 * The New-ticket composer's submit orchestration, hoisted out of the React
 * layer so the create/kickoff flows — including their ordering and failure
 * handling — are plain, unit-tested TypeScript rather than tangled JSX
 * handlers. The component supplies effectful callbacks ({@link SubmitDeps});
 * these functions just sequence them.
 *
 * Two actions:
 * - {@link runPlainCreate}: create the ticket in the chip's status, toast its
 *   display id on success.
 * - {@link runKickoff}: create the ticket DIRECTLY in Doing (regardless of the
 *   chip), then boot a terminal session that auto-launches the chosen harness
 *   with the ticket's composed prompt. With "Create more" off it navigates into
 *   the ticket detail (landing on the Doc tab, so the ticket's title/description
 *   are in view) with the agent session booted as a ready tab; with it on it
 *   boots the agent in the background and stays put.
 *
 * Failure policy (CLAUDE.md: never silently swallow a failed mutation): the
 * ticket create toasts its own failure via the board store, and the session
 * boot toasts its own failure via `createTerminalSession` — so a partial
 * failure (ticket created, session boot failed) still leaves the user somewhere
 * sane: the ticket exists in Doing, the session error is toasted, and the
 * foreground flow has already navigated into the detail view so they can retry
 * from there.
 */
import {
  composeTicketPrompt,
  displayTicketId,
  type HarnessId,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

/** The composed values a submit reads — the form's current field state, flattened. */
export interface ComposerFields {
  projectId: string;
  /** The target project's ticket prefix, for the success toast's display id. */
  ticketPrefix: string;
  status: TicketStatus;
  priority: TicketPriority;
  title: string;
  body: string;
  labels: string[];
  usesWorktree: boolean;
}

/** The effectful callbacks the orchestration drives; the React layer wires these to the stores. */
export interface SubmitDeps {
  addTicket(
    projectId: string,
    status: TicketStatus,
    title: string,
    options: { priority: TicketPriority; body: string; labels: string[]; usesWorktree: boolean },
  ): Promise<Ticket | null>;
  /** Boot a ticket session, auto-launching the harness with `prompt`; resolves the sessionId or null on failure. */
  startSession(
    projectId: string,
    ticketId: string,
    kickoff: { harnessId: HarnessId; prompt: string },
  ): Promise<string | null>;
  openTicket(projectId: string, ticketId: string): void;
  persistHarness(harnessId: HarnessId): void;
  toastSuccess(message: string): void;
}

/** The shared outcome: whether a ticket was actually created (drives the form's reset/close). */
export interface SubmitResult {
  created: boolean;
}

/** Create a ticket in the chip's status. Toasts the display id on success. */
export async function runPlainCreate(
  fields: ComposerFields,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const ticket = await deps.addTicket(fields.projectId, fields.status, fields.title, {
    priority: fields.priority,
    body: fields.body,
    labels: fields.labels,
    usesWorktree: fields.usesWorktree,
  });
  if (ticket === null) return { created: false };
  deps.toastSuccess(`${displayTicketId(fields.ticketPrefix, ticket.ticketNumber)} created`);
  return { created: true };
}

/**
 * Create the ticket in Doing (forced, regardless of the chip) and kick off the
 * chosen harness. `createMore` off → navigate into the detail view (Doc tab,
 * title in view) with the session booted as a ready tab; on → background boot,
 * no navigation. The caller resets/closes the form off `created`.
 */
export async function runKickoff(
  fields: ComposerFields,
  deps: SubmitDeps,
  opts: { createMore: boolean; harnessId: HarnessId },
): Promise<SubmitResult> {
  deps.persistHarness(opts.harnessId);
  // Kickoff forces Doing — a "Create & start" ticket is booting an agent now,
  // so it belongs in Doing whatever the Status chip says.
  const ticket = await deps.addTicket(fields.projectId, "doing", fields.title, {
    priority: fields.priority,
    body: fields.body,
    labels: fields.labels,
    usesWorktree: fields.usesWorktree,
  });
  if (ticket === null) return { created: false };

  const displayId = displayTicketId(fields.ticketPrefix, ticket.ticketNumber);
  const prompt = composeTicketPrompt({ displayId, title: fields.title, body: fields.body });
  deps.toastSuccess(`${displayId} created`);

  if (opts.createMore) {
    // Background boot: the composer stays open, so we don't navigate; the
    // session (and any boot failure toast) happens off-screen.
    await deps.startSession(fields.projectId, ticket.id, {
      harnessId: opts.harnessId,
      prompt,
    });
    return { created: true };
  }

  // Foreground: navigate FIRST so that even if the session boot fails (it
  // toasts its own error), the user lands in the ticket detail and can retry.
  // The detail opens on its Doc tab (title/description in view) and the session
  // boots as a ready tab in the strip — we deliberately don't switch focus to
  // it, so the landing view is the ticket itself, not a bare terminal.
  deps.openTicket(fields.projectId, ticket.id);
  await deps.startSession(fields.projectId, ticket.id, {
    harnessId: opts.harnessId,
    prompt,
  });
  return { created: true };
}
