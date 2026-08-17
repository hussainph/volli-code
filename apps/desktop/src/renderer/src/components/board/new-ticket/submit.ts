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
 *   chip), then open the ticket's CHAT Session on the model and effort the
 *   composer picked and hand it its opening turn. With "Create more" off it
 *   navigates into the ticket workspace, where the chat's own tab is already in
 *   front — the whole point of one-step kickoff is landing on the running agent;
 *   with it on it starts the Session in the background and stays put.
 *
 * WHAT KICKOFF IS NOT ANY MORE. It used to boot a PTY and auto-launch a TUI
 * with the ticket's composed prompt as an argv, and the composer carried a
 * terminal-harness picker to choose which one (VC-15, subsumed by VC-56). The
 * product has one structured executor and terminals are manual companions, so
 * "Create & start" starts the thing the ticket workspace is built around and
 * never a terminal. Two consequences worth stating, because they look like
 * omissions:
 *
 *  - **No prompt is composed here.** A Ticket Session's agent is handed the
 *    Ticket Brief — id, title, body, worktree orientation — as its Runtime
 *    Brief at attach, so sending the ticket back to it as a message would be
 *    the same text twice. What kickoff sends is the instruction to begin
 *    ({@link DEFAULT_KICKOFF_MESSAGE}), which is the same sentence the agent
 *    socket's `volli session start` sends when nobody dictated one.
 *  - **No harness is persisted.** `preferredHarnessId` is the ticket's TERMINAL
 *    default, read when a terminal resumes; a kickoff that starts no terminal
 *    has no opinion to record, so it leaves the DB default alone.
 *
 * Failure policy (CLAUDE.md: never silently swallow a failed mutation): the
 * ticket create toasts its own failure via the board store, and the Session
 * start toasts (or, for a missing default model, opens Model Access) via the
 * chat-sessions store — so a partial failure still leaves the user somewhere
 * sane: the ticket exists in Doing, the failure is surfaced, and the foreground
 * flow has already navigated into the ticket so they can retry from there.
 */
import {
  autoTitleFromKickoff,
  DEFAULT_KICKOFF_MESSAGE,
  displayTicketId,
  type ModelSelection,
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
  /**
   * The ref the ticket's worktree branches from (the chip row's base picker).
   * `null` leaves it unset, and `resolveBaseBranch` detects the project default
   * at worktree time. Sent only when the ticket actually gets a worktree — a
   * base recorded against a ticket that works in the project checkout would be
   * a durable field nothing ever reads.
   */
  baseBranch: string | null;
}

/** How a kickoff opens the ticket's chat Session — see {@link runKickoff}. */
export interface KickoffChat {
  /**
   * The Session's durable title at birth.
   *
   * Chats are normally named by their first delivered message, and this one's
   * first message is a stock instruction — "Begin work on this ticket…" is not
   * what the rail should call it. `autoTitleFromKickoff` already answers this
   * for the socket door; kickoff asks it the same question.
   */
  title: string;
  /** The opening turn, queued for release the moment an executor is live. */
  message: string;
  /**
   * The model and effort the composer's run row picked. Absent means the
   * composer had nothing to offer (Model Access unconfigured), in which case
   * the Ticket default answers — or refuses, which the start surfaces as the
   * configuration state it is.
   */
  model?: ModelSelection;
}

/** The effectful callbacks the orchestration drives; the React layer wires these to the stores. */
export interface SubmitDeps {
  addTicket(
    projectId: string,
    status: TicketStatus,
    title: string,
    options: {
      priority: TicketPriority;
      body: string;
      labels: string[];
      usesWorktree: boolean;
      /** The worktree's base ref; omitted leaves it to worktree-time detection. */
      baseBranch?: string | null;
    },
  ): Promise<Ticket | null>;
  /**
   * Mint the ticket's chat Session, land its tab in front of the ticket's other
   * tabs, and queue `message` as its opening turn. Resolves the Session's id, or
   * null when the start failed (it has already surfaced why).
   */
  startChat(projectId: string, ticketId: string, chat: KickoffChat): Promise<string | null>;
  /**
   * Makes the ticket's workspace visible NOW — switches nav to Board, opens
   * its detail, and selects it on the board (workspace.openTicketWorkspace).
   * Using the narrower `workspace.openTicket` here was the bug: it never
   * touches nav, so invoking Create-&-start from Files/Sessions (the "c"
   * shortcut is app-wide) left the promised workspace unrendered.
   */
  openTicketWorkspace(projectId: string, ticketId: string): void;
  toastSuccess(message: string): void;
}

/** The shared outcome: whether a ticket was actually created (drives the form's reset/close). */
export interface SubmitResult {
  created: boolean;
}

/**
 * The base ref to record for `fields`. A ticket that works in the project
 * checkout never branches, so it records none — persisting one would leave a
 * durable field nothing reads, which would then resurface as a stale suggestion
 * if the ticket were later switched to a worktree.
 */
function baseBranchFor(fields: ComposerFields): string | null {
  return fields.usesWorktree ? fields.baseBranch : null;
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
    baseBranch: baseBranchFor(fields),
  });
  if (ticket === null) return { created: false };
  deps.toastSuccess(`${displayTicketId(fields.ticketPrefix, ticket.ticketNumber)} created`);
  return { created: true };
}

/**
 * Create the ticket in Doing (forced, regardless of the chip) and open its chat
 * Session on the chosen model. `createMore` off → navigate into the ticket
 * workspace, where the Session's tab is already the active one; on → background
 * start, no navigation. The caller resets/closes the form off `created`.
 */
export async function runKickoff(
  fields: ComposerFields,
  deps: SubmitDeps,
  opts: { createMore: boolean; model?: ModelSelection },
): Promise<SubmitResult> {
  // Kickoff forces Doing — a "Create & start" ticket is starting an agent now,
  // so it belongs in Doing whatever the Status chip says.
  const ticket = await deps.addTicket(fields.projectId, "doing", fields.title, {
    priority: fields.priority,
    body: fields.body,
    labels: fields.labels,
    usesWorktree: fields.usesWorktree,
    baseBranch: baseBranchFor(fields),
  });
  if (ticket === null) return { created: false };

  const displayId = displayTicketId(fields.ticketPrefix, ticket.ticketNumber);
  deps.toastSuccess(`${displayId} created`);
  const chat: KickoffChat = {
    title: autoTitleFromKickoff(DEFAULT_KICKOFF_MESSAGE, displayId),
    message: DEFAULT_KICKOFF_MESSAGE,
    ...(opts.model === undefined ? {} : { model: opts.model }),
  };

  if (opts.createMore) {
    // Background start: the composer stays open, so we don't navigate; the
    // Session (and any failure it surfaces) happens off-screen.
    await deps.startChat(fields.projectId, ticket.id, chat);
    return { created: true };
  }

  // Foreground: navigate FIRST so that even if the Session start fails (it
  // surfaces its own reason), the user lands in the ticket and can retry. The
  // chat's tab is put in front by the start itself, so there is no second
  // "focus it" step to get wrong — and a start that never landed leaves the Doc
  // tab active, which is the sane retry surface.
  deps.openTicketWorkspace(fields.projectId, ticket.id);
  await deps.startChat(fields.projectId, ticket.id, chat);
  return { created: true };
}
