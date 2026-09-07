/**
 * What a closed terminal's saved record actually says about itself (VC-290).
 *
 * A terminal that exited and had its tab closed is still a Session: it has a
 * name, a scope, a start, an end and — from the moment its PTY reported one —
 * an exit code. What it does NOT have is scrollback (the tail is an in-memory
 * pipeline that dies with the process) or the commands typed into it (nothing
 * records raw terminal input). This module turns the durable record into
 * exactly the first list and refuses to invent the second.
 *
 * **The refusals are the feature.** An unknown exit is `unavailable`, never a
 * silent zero: the boot sweep closes attachments no PTY was there to report on,
 * and every record written before the code was persisted has the same hole.
 * Reading either as success would tell a person their agent finished cleanly
 * when nothing observed it finishing at all. Same for the ticket: a record whose
 * ticket has been deleted says so, rather than borrowing the project's name and
 * presenting a Ticket Session as a Board Session.
 *
 * Pure and view-free so the decisions are testable without a dialog around
 * them; the panel owns layout and the absolute-time formatting, which is the
 * one thing here that is a locale question rather than a truth question.
 */
import { displayTicketId, type SessionRecord, type Ticket } from "@volli/shared";

import { sessionSourceLabel } from "../ticket/session-history";

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
export type TerminalSessionExit =
  | { kind: "code"; code: number }
  | { kind: "unavailable" }
  | { kind: "running" };

/**
 * Whose terminal this was. `unavailable` covers both ways a ticket can go
 * missing: a record naming a ticket this project no longer lists, and a record
 * orphaned into `ticketId: null` by a ticket delete (the column is
 * `ON DELETE SET NULL`, so the null alone cannot be read as "Board Session" —
 * `bornTicketless` is the fact that can).
 */
export type TerminalSessionScope =
  | { kind: "ticket"; ticketId: string; displayId: string; title: string }
  | { kind: "project" }
  | { kind: "unavailable" };

/**
 * Where **New terminal here** would put a fresh Session, or `null` when there
 * is no such place. A record whose ticket is gone has no "here" left: starting
 * a project terminal instead would be a different scope wearing the closed
 * Session's name, which is the substitution this whole ticket is about.
 */
export type TerminalSessionRecreate =
  | { kind: "ticket"; ticketId: string }
  | { kind: "project" }
  | null;

export interface TerminalSessionDetail {
  sessionId: string;
  projectId: string;
  title: string;
  /** The harness, `Shell`, or `Terminal` — `sessionSourceLabel`'s answer. */
  source: string;
  scope: TerminalSessionScope;
  /** The scope in one line, ready to print. */
  scopeLabel: string;
  startedAt: number;
  /** Epoch ms the terminal ended, or `null` while its attachment is still open. */
  endedAt: number | null;
  /** Whether this record is a concluded terminal rather than a live one. */
  closed: boolean;
  exit: TerminalSessionExit;
  /** {@link TerminalSessionDetail.exit} in one line, ready to print. */
  exitLabel: string;
  /** The absolute working directory, or `null` when the record does not carry one. */
  cwd: string | null;
  recreate: TerminalSessionRecreate;
}

export interface TerminalSessionDetailInput {
  record: SessionRecord;
  /** The record's ticket if the board still has it; `null` otherwise. */
  ticket: Ticket | null;
  /** The project's ticket prefix, for the ticket's display id. */
  ticketPrefix: string;
}

function scopeOf(
  record: SessionRecord,
  ticket: Ticket | null,
  ticketPrefix: string,
): TerminalSessionScope {
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

function scopeLabelOf(scope: TerminalSessionScope): string {
  if (scope.kind === "ticket") return `${scope.displayId} · ${scope.title}`;
  return scope.kind === "project" ? "Project session" : "Ticket unavailable";
}

function recreateOf(scope: TerminalSessionScope): TerminalSessionRecreate {
  if (scope.kind === "ticket") return { kind: "ticket", ticketId: scope.ticketId };
  return scope.kind === "project" ? { kind: "project" } : null;
}

function exitOf(record: SessionRecord): TerminalSessionExit {
  if (record.endedAt === null) return { kind: "running" };
  return record.exitCode === null
    ? { kind: "unavailable" }
    : { kind: "code", code: record.exitCode };
}

function exitLabelOf(exit: TerminalSessionExit): string {
  if (exit.kind === "code") return `Exit code ${exit.code}`;
  return exit.kind === "unavailable" ? "Exit status unavailable" : "Still running";
}

/** The saved record, said back exactly — see the module comment for the refusals. */
export function buildTerminalSessionDetail(
  input: TerminalSessionDetailInput,
): TerminalSessionDetail {
  const { record, ticket, ticketPrefix } = input;
  const scope = scopeOf(record, ticket, ticketPrefix);
  const exit = exitOf(record);
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
    recreate: recreateOf(scope),
  };
}
