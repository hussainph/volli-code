/**
 * What a closed terminal's saved record actually says about itself, and which
 * controls that record makes meaningful (VC-290).
 *
 * A terminal that exited and had its tab closed is still a Session: it has a
 * name, a scope, a start, an end and — from the moment its process reported one
 * — an exit code. What it does NOT have is scrollback (the tail is an in-memory
 * pipeline that dies with the process) or the commands typed into it (nothing
 * records raw terminal input). This module turns the durable record into
 * exactly the first list and refuses to invent the second.
 *
 * **The refusals are the feature.** An unknown exit is `unavailable`, never a
 * silent zero: the relaunch sweep closes attachments no process was there to
 * report on, and every record written before `attachment.exited` existed has
 * the same hole. Reading either as success would tell a person their agent
 * finished cleanly when nothing observed it finishing at all. Same for the
 * ticket: a record whose ticket has been deleted says so, rather than borrowing
 * the project's name and presenting a Ticket Session as a Board Session.
 *
 * It lives in the Session Presentation Contract rather than in one client
 * because these are the historical-summary and available-control decisions the
 * contract exists to make (CONTEXT.md: "Session Surface Model … historical
 * summaries that a client may render"). Desktop, mobile and a future web client
 * must not each decide independently whether an exit nobody saw was fine, or
 * whether a deleted ticket may be recreated into. Framework-neutral by
 * construction — this package has no DOM, no React and no Electron — so the
 * client supplies its own harness catalogue, formats the timestamps in its own
 * locale, and performs the launch itself.
 */
import { canResumeHarness, displayTicketId, effectiveHarnessId } from "@volli/shared";
import type { HarnessAdapterLookup, SessionRecord } from "@volli/shared";

import { sessionSourceLabel } from "./session-source";

/** Said in full wherever a closed terminal is shown. Never softened into a hint. */
export const TERMINAL_OUTPUT_NOT_SAVED = "Terminal output was not saved.";

/**
 * The other absence, stated for the same reason. `session_commands` holds the
 * app's own Session commands, not the bytes a person typed into a shell, so
 * there is no last command to show — and guessing one from output we do not
 * keep is exactly the invention this view exists to avoid.
 */
export const TERMINAL_LAST_COMMAND_NOT_RECORDED = "Last command was not recorded.";

/**
 * How the terminal's process ended.
 *
 * `unavailable` is a first-class answer rather than a `null` the view has to
 * interpret: "we never saw a code" and "it exited 0" are different facts, and
 * the whole point of this vocabulary is that no reader can collapse them.
 */
export type TerminalHistoryExit =
  | { kind: "code"; code: number }
  | { kind: "unavailable" }
  | { kind: "running" };

/**
 * Whose terminal this was. `unavailable` covers both ways a ticket can go
 * missing: a record naming a ticket the board no longer lists, and a record
 * orphaned into `ticketId: null` by a ticket delete (the column is
 * `ON DELETE SET NULL`, so the null alone cannot be read as "Board Session" —
 * `bornTicketless` is the fact that can).
 */
export type TerminalHistoryScope =
  | { kind: "ticket"; ticketId: string; displayId: string; title: string }
  | { kind: "project" }
  | { kind: "unavailable" };

/**
 * Where a fresh terminal would be created, or `null` when there is no such
 * place. A record whose ticket is gone has no "here" left: starting a project
 * terminal instead would be a different scope wearing the closed Session's
 * name, which is the substitution this whole ticket is about.
 */
export type TerminalHistoryRecreate =
  | { kind: "ticket"; ticketId: string }
  | { kind: "project" }
  | null;

/**
 * The controls this record makes meaningful, and nothing about how to draw
 * them.
 *
 * Two verbs that must never be mistaken for each other, so they are separate
 * fields rather than one "primary action": recreation is a NEW execution in the
 * same scope, resume asks a harness to pick this Session's own history back up.
 * A client shows the ones that are non-null; it does not re-decide them.
 */
export interface TerminalHistoryActions {
  /** A new Session in the same scope, leaving this record untouched. */
  recreate: TerminalHistoryRecreate;
  /**
   * The ticket a resume would run in, or `null` when this record cannot be
   * resumed. A ticket id rather than a boolean because resume is resolved
   * inside that ticket's worktree, and a Session with no ticket scope has
   * nowhere to resume into however capable its harness is.
   */
  resume: { ticketId: string } | null;
}

export interface TerminalHistoryDetail {
  sessionId: string;
  projectId: string;
  title: string;
  /** The harness, `Shell`, or `Terminal` — {@link sessionSourceLabel}'s answer. */
  source: string;
  scope: TerminalHistoryScope;
  /** The scope in one line, ready to print. */
  scopeLabel: string;
  startedAt: number;
  /** Epoch ms the terminal ended, or `null` while its attachment is still open. */
  endedAt: number | null;
  /** Whether this record is a concluded terminal rather than a live one. */
  closed: boolean;
  exit: TerminalHistoryExit;
  /** {@link TerminalHistoryDetail.exit} in one line, ready to print. */
  exitLabel: string;
  /** The absolute working directory, or `null` when the record does not carry one. */
  cwd: string | null;
  actions: TerminalHistoryActions;
}

/**
 * The three facts the scope line needs from the record's ticket.
 *
 * Structural, not the whole `Ticket`: this contract reads a ticket's name and
 * number, and asking for a board row would make every caller that holds less
 * than one invent the rest. A `Ticket` satisfies it unchanged.
 */
export interface TerminalHistoryTicket {
  id: string;
  ticketNumber: number;
  title: string;
}

export interface TerminalHistoryDetailInput {
  record: SessionRecord;
  /** The record's ticket if the board still has it; `null` otherwise. */
  ticket: TerminalHistoryTicket | null;
  /** The project's ticket prefix, for the ticket's display id. */
  ticketPrefix: string;
  /**
   * The harness catalogue this client actually knows, for the resume decision.
   *
   * A parameter rather than the built-ins, because a harness the user has
   * registered and trusted can genuinely be resumed and only the caller knows
   * about it — see {@link HarnessAdapterLookup}.
   */
  harnesses: HarnessAdapterLookup;
}

/**
 * Whether this ended terminal record can be resumed — the harness-specific
 * rule, in one place.
 *
 * A terminal qualifies only when it actually launched an agent (a bare shell or
 * pre-metadata `unknown` record has no harness session to resume), has actually
 * ended (a still-live session has nothing to resume INTO — it is already
 * running), and its harness knows how to resume at all. The harness judged is
 * the one that was RUNNING when it ended, because that is the one a resume
 * restarts; deciding on the launch harness would offer Resume for an agent the
 * session had not been running since the moment it opened.
 */
export function canResumeTerminalRecord(
  record: SessionRecord,
  harnesses: HarnessAdapterLookup,
): boolean {
  return (
    record.launchKind === "agent" &&
    record.endedAt !== null &&
    canResumeHarness(effectiveHarnessId(record), record.harnessSessionId, harnesses)
  );
}

/**
 * Whose terminal this was — the scope decision on its own, for a surface that
 * needs the answer without the whole summary.
 *
 * Exported because ⌘K asks the same question about the same records and must
 * not answer it separately: a row that called an orphaned Ticket Session a
 * Board Session, while its detail called it unavailable, would be one client
 * disagreeing with itself about one durable record.
 */
export function terminalHistoryScope(
  record: SessionRecord,
  ticket: TerminalHistoryTicket | null,
  ticketPrefix: string,
): TerminalHistoryScope {
  if (record.ticketId !== null) {
    return ticket === null
      ? { kind: "unavailable" }
      : {
          kind: "ticket",
          ticketId: ticket.id,
          displayId: displayTicketId(ticketPrefix, ticket.ticketNumber),
          title: ticket.title,
        };
  }
  // A null ticket id is two different Sessions. Only `bornTicketless` tells
  // the Board Session from the orphan.
  return record.bornTicketless ? { kind: "project" } : { kind: "unavailable" };
}

function scopeLabelOf(scope: TerminalHistoryScope): string {
  if (scope.kind === "ticket") return `${scope.displayId} · ${scope.title}`;
  return scope.kind === "project" ? "Project session" : "Ticket unavailable";
}

function recreateOf(scope: TerminalHistoryScope): TerminalHistoryRecreate {
  if (scope.kind === "ticket") return { kind: "ticket", ticketId: scope.ticketId };
  return scope.kind === "project" ? { kind: "project" } : null;
}

function exitOf(record: SessionRecord): TerminalHistoryExit {
  // An observed status is proof the process ended, so it outranks a missing end
  // stamp: the exit and the attachment's close are two separate durable facts,
  // and a close that failed to record must not turn a code somebody watched
  // arrive into "Still running".
  if (record.exitCode !== null) return { kind: "code", code: record.exitCode };
  return record.endedAt === null ? { kind: "running" } : { kind: "unavailable" };
}

function exitLabelOf(exit: TerminalHistoryExit): string {
  if (exit.kind === "code") return `Exit code ${exit.code}`;
  return exit.kind === "unavailable" ? "Exit status unavailable" : "Still running";
}

/** The saved record, said back exactly — see the module comment for the refusals. */
export function buildTerminalHistoryDetail(
  input: TerminalHistoryDetailInput,
): TerminalHistoryDetail {
  const { record, ticket, ticketPrefix, harnesses } = input;
  const scope = terminalHistoryScope(record, ticket, ticketPrefix);
  const exit = exitOf(record);
  const recreate = recreateOf(scope);
  return {
    sessionId: record.id,
    projectId: record.projectId,
    title: record.title,
    source: sessionSourceLabel({ kind: "terminal", record }),
    scope,
    scopeLabel: scopeLabelOf(scope),
    startedAt: record.createdAt,
    endedAt: record.endedAt,
    closed: record.endedAt !== null,
    exit,
    exitLabel: exitLabelOf(exit),
    // An unreadable native detail projects `cwd: ""`. An empty string drawn in
    // a path row looks like a path that is somehow the filesystem root.
    cwd: record.cwd.length > 0 ? record.cwd : null,
    actions: {
      recreate,
      // Resume is a TICKET Session's affordance and never a substitute for
      // recreation: it is offered only where the scope still exists AND the
      // harness that was running can be resumed.
      resume:
        scope.kind === "ticket" && canResumeTerminalRecord(record, harnesses)
          ? { ticketId: scope.ticketId }
          : null,
    },
  };
}
