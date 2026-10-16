/**
 * The tool doors onto {@link Watches} (VC-457): `watch`, the two retired await
 * tools, and the automatic watch `session_start`, `automation_run` and
 * `session_send` arm for their caller.
 *
 * Every door here RETURNS at once. That is the whole change from the await
 * tools this replaces: they parked the caller's turn until a fact arrived, and
 * a parked turn is a chat nobody can use. Here the caller is told what it is
 * now watching and goes on; the fact arrives later as a notice (`watches.ts`).
 *
 * ## Who may watch whom
 *
 * Bound to the caller's project before any handle or display id is parsed —
 * the bound every Session tool holds — and then by Role, exactly as the await
 * tools were:
 *
 * - `project` (a Board Session) — any Session and any Ticket in its project.
 * - `ticket` — any Ticket in its project, and only the Sessions it delegated.
 *   Its own subagents already report back without a watch; a sibling is
 *   supervision it does not hold.
 * - `subagent` — nothing; its bundle holds no watch door at all.
 *
 * Nobody watches itself: a Session's own turn ending would wake the Session
 * whose turn just ended, which is a loop, not a notice.
 *
 * What kinds may wake a watcher is project policy — the `awaitable` and
 * `awaitableSessions` lists the await tools read, kept under their durable
 * names because they are configuration a person may have written.
 */

import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import {
  displayTicketId,
  errorMessage,
  isSessionAwaitFor,
  isTicketAwaitFor,
  MAX_SESSION_AWAIT_TARGETS,
  MAX_TICKET_AWAIT_TARGETS,
  parseSessionAwaitTargets,
  parseTicketAwaitTargets,
  sessionAwaitKindsFor,
  shortSessionId,
  ticketAwaitKindsFor,
  type AuthorityPolicy,
  type Project,
  type RuntimeSessionIdentity,
  type RuntimeVerbCall,
  type RuntimeVerbResult,
  type Session,
  type SessionAwaitKind,
  type TicketAwaitKind,
} from "@volli/shared";

import { listLiveTicketRefsByNumber } from "./db/tickets-repo";
import { terminalSessionRecord } from "./session-control/terminal-attachment";
import type { Watches } from "./watches";

export interface WatchToolPorts {
  db: Database.Database;
  projects: () => readonly Project[];
  authorityPolicy: (projectId: string) => AuthorityPolicy;
  /** The Session read handles resolve through; null when the runtime never came up. */
  sessions: () => Pick<SessionEngine, "listSessions"> | null;
  /** The watch registry; null when the runtime never came up. */
  watches: () => Watches | null;
}

function refusal(text: string): RuntimeVerbResult {
  return { text };
}

interface SessionTarget {
  id: string;
  handle: string;
  title: string | null;
}

interface TicketTarget {
  id: string;
  display: string;
}

/** Why one caller may not watch one Session, or null when it may. */
function watchBarrier(
  caller: RuntimeSessionIdentity,
  target: Session,
  handle: string,
): string | null {
  if (caller.role === "subagent") {
    return "A subagent Session watches nothing; report what you found in your last message instead.";
  }
  if (target.id === caller.sessionId) {
    return `Session ${handle} is this Session; its own changes are not news to it.`;
  }
  if (caller.role === "project") return null;
  if (target.parentSessionId === caller.sessionId) return null;
  return `Session ${handle} is not one this Session delegated; a ticket Session may watch only its own subagents.`;
}

async function resolveSessions(
  ports: WatchToolPorts,
  caller: RuntimeSessionIdentity,
  project: Project,
  handles: readonly string[],
): Promise<{ ok: true; targets: SessionTarget[] } | { ok: false; text: string }> {
  const engine = ports.sessions();
  if (engine === null) {
    return {
      ok: false,
      text: "The structured session runtime is not available, so nothing was watched.",
    };
  }
  const projections = await engine.listSessions({ projectId: project.id, scope: "all" });
  const targets: SessionTarget[] = [];
  for (const handle of handles) {
    const matches = projections.filter(
      (projection) => shortSessionId(projection.session.id) === handle,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        text: `No session ${handle} in this project, so nothing was watched. \`volli session list\` prints the handles.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        text: `Session id ${handle} is ambiguous in this project, so nothing was watched.`,
      };
    }
    const target = matches[0]!;
    const barrier = watchBarrier(caller, target.session, handle);
    if (barrier !== null) return { ok: false, text: barrier };
    if (terminalSessionRecord(target) !== null) {
      return {
        ok: false,
        text: `Session ${handle} is a terminal session, which records no turns, signals or stops to watch.`,
      };
    }
    targets.push({
      id: target.session.id,
      handle,
      title: target.session.title,
    });
  }
  return { ok: true, targets };
}

/** A display id's number when it belongs to exactly this project prefix. */
function ticketNumberForProject(display: string, project: Project): number | null {
  const prefix = `${project.ticketPrefix}-`;
  if (!display.startsWith(prefix)) return null;
  const raw = display.slice(prefix.length);
  if (!/^\d+$/u.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function resolveTickets(
  ports: WatchToolPorts,
  project: Project,
  displays: readonly string[],
): { ok: true; targets: TicketTarget[] } | { ok: false; text: string } {
  const numbers = new Map<string, number>();
  for (const display of displays) {
    const number = ticketNumberForProject(display, project);
    if (number === null) {
      return { ok: false, text: `No ticket ${display} in this project, so nothing was watched.` };
    }
    numbers.set(display, number);
  }
  const byNumber = new Map(
    listLiveTicketRefsByNumber(ports.db, project.id, [...new Set(numbers.values())]).map(
      (ticket) => [ticket.ticketNumber, ticket] as const,
    ),
  );
  const targets: TicketTarget[] = [];
  for (const [display, number] of numbers) {
    const ticket = byNumber.get(number);
    if (ticket === undefined) {
      return { ok: false, text: `No ticket ${display} in this project, so nothing was watched.` };
    }
    targets.push({ id: ticket.id, display: displayTicketId(project.ticketPrefix, number) });
  }
  return { ok: true, targets };
}

/** What a watched Session will notify about, in the words a receipt uses. */
function sessionKindsText(kinds: readonly SessionAwaitKind[], armTurn: boolean): string {
  const parts = [
    ...(armTurn && kinds.includes("turn") ? ["when its next turn ends"] : []),
    ...(kinds.includes("verdict") ? ["when it signals done or blocked"] : []),
    ...(kinds.includes("stopped") ? ["if it is stopped"] : []),
  ];
  return parts.length === 0 ? "about nothing this project's policy allows" : parts.join(", ");
}

const TICKET_KIND_WORD: Record<TicketAwaitKind, string> = {
  status: "moves",
  comment: "comments",
  signal: "signals",
};

const NOTHING_REPORTS_BACK =
  "Nothing reports back into this Session; use `volli session peek` to look in on it.";

/**
 * Arm the automatic watch a Session-opening or Session-steering tool gives its
 * caller, and say what it arms in one receipt line. Never refuses: a caller
 * whose policy allows nothing, or a composition with no registry, is told
 * that nothing will report back — which is what those tools always said.
 *
 * Authorization is the explicit `watch` tool's, by origin:
 *
 * - `started` — the caller opened this Session (`session_start`,
 *   `automation_run`). Opening work is the strongest claim to hear about it,
 *   so a Ticket Session watches a Session its own-ticket grant started even
 *   though that Session is not one of its subagents.
 * - `steered` — the caller only sent into it (`session_send`). Holding a send
 *   is not holding a watch, so {@link watchBarrier} judges the target exactly
 *   as `watch` would: a Ticket Session granted `session_send` does not come
 *   to watch a Session the explicit tool would refuse it.
 */
export async function watchOpenedSession(
  ports: Pick<WatchToolPorts, "authorityPolicy" | "watches" | "sessions">,
  caller: RuntimeSessionIdentity,
  target: { sessionId: string; title: string | null },
  origin: "started" | "steered",
): Promise<string> {
  const watches = ports.watches();
  const kinds = ports.authorityPolicy(caller.projectId).actors.session.awaitableSessions;
  if (watches === null || caller.role === "subagent" || kinds.length === 0) {
    return NOTHING_REPORTS_BACK;
  }
  if (origin === "steered") {
    const engine = ports.sessions();
    let projections: readonly { session: Session }[];
    try {
      projections =
        engine === null
          ? []
          : await engine.listSessions({ projectId: caller.projectId, scope: "all" });
    } catch (error) {
      // The send this rides on has already been delivered. A read that fails
      // now is a watch that could not be armed, never a failed send: the
      // caller is told both halves and nothing is retried twice.
      return `Volli could not arm a watch on it (${errorMessage(error)}), so nothing will report back; use \`volli session peek ${shortSessionId(target.sessionId)}\` to look in on it.`;
    }
    const found = projections.find((projection) => projection.session.id === target.sessionId);
    if (
      found === undefined ||
      watchBarrier(caller, found.session, shortSessionId(target.sessionId)) !== null
    ) {
      return NOTHING_REPORTS_BACK;
    }
  }
  watches.watchSession({
    watcherSessionId: caller.sessionId,
    targetSessionId: target.sessionId,
    title: target.title,
    kinds,
    armTurn: true,
  });
  return `A notice from Volli will arrive in this Session ${sessionKindsText(kinds, true)}; keep working meanwhile, or end your turn and the notice will open a new one. \`volli session peek ${shortSessionId(target.sessionId)}\` looks in on it before then.`;
}

/**
 * `watch` — arm or end watches on Sessions and Tickets, and return at once.
 */
export async function watchTool(
  ports: WatchToolPorts,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
): Promise<RuntimeVerbResult> {
  const sessionsRaw = request.input.sessions;
  const ticketsRaw = request.input.tickets;
  if (sessionsRaw !== undefined && sessionsRaw !== null && typeof sessionsRaw !== "string") {
    return refusal("`sessions` must be short session ids separated by spaces or commas.");
  }
  if (ticketsRaw !== undefined && ticketsRaw !== null && typeof ticketsRaw !== "string") {
    return refusal("`tickets` must be ticket display ids separated by spaces or commas.");
  }
  const handles = typeof sessionsRaw === "string" ? parseSessionAwaitTargets(sessionsRaw) : [];
  const displays = typeof ticketsRaw === "string" ? parseTicketAwaitTargets(ticketsRaw) : [];
  if (handles.length === 0 && displays.length === 0) {
    return refusal(
      "Name at least one target: `sessions` (short session ids, e.g. 'a1b2c3d4') or `tickets` (display ids, e.g. 'VC-12').",
    );
  }
  if (handles.length > MAX_SESSION_AWAIT_TARGETS || displays.length > MAX_TICKET_AWAIT_TARGETS) {
    return refusal(
      `One call may name at most ${MAX_SESSION_AWAIT_TARGETS} sessions and ${MAX_TICKET_AWAIT_TARGETS} tickets.`,
    );
  }
  const action = request.input.action ?? "watch";
  if (action !== "watch" && action !== "unwatch") {
    return refusal("`action` must be watch or unwatch.");
  }
  const project = ports.projects().find(({ id }) => id === session.projectId);
  if (project === undefined) {
    return refusal("This Session's project is no longer registered, so nothing was watched.");
  }
  const watches = ports.watches();
  if (watches === null) {
    return refusal("The structured session runtime is not available, so nothing was watched.");
  }
  const sessions =
    handles.length === 0
      ? { ok: true as const, targets: [] }
      : await resolveSessions(ports, session, project, handles);
  if (!sessions.ok) return refusal(sessions.text);
  const tickets = resolveTickets(ports, project, displays);
  if (!tickets.ok) return refusal(tickets.text);

  // The targets as resolved, as data (VC-471), in the shape the registry's
  // `resultDetails` declares: canonical handles and display ids, so a program
  // compares them with what it started rather than reading the receipt.
  const named = {
    sessions: sessions.targets.map((target) => target.handle),
    tickets: tickets.targets.map((target) => target.display),
  };

  if (action === "unwatch") {
    const removed = watches.unwatch(session.sessionId, {
      sessions: sessions.targets.map((target) => target.id),
      tickets: tickets.targets.map((target) => target.id),
    });
    return {
      details: { action, ...named, ended: removed },
      text:
        removed === 0
          ? "None of those were being watched by this Session; nothing changed."
          : `Stopped watching ${removed} ${removed === 1 ? "target" : "targets"}. Nothing more about them will arrive here.`,
    };
  }

  // Every refusal before any watch is armed: a call is armed whole or not at
  // all, so a refusal never leaves half of it watching.
  const policy = ports.authorityPolicy(project.id).actors.session;
  if (sessions.targets.length > 0 && policy.awaitableSessions.length === 0) {
    return refusal(
      "This project's policy lets Sessions watch no Session facts, so nothing was watched.",
    );
  }
  if (tickets.targets.length > 0 && policy.awaitable.length === 0) {
    return refusal(
      "This project's policy lets Sessions watch no Ticket facts, so nothing was watched.",
    );
  }
  const lines: string[] = [];
  if (sessions.targets.length > 0) {
    for (const target of sessions.targets) {
      watches.watchSession({
        watcherSessionId: session.sessionId,
        targetSessionId: target.id,
        title: target.title,
        kinds: policy.awaitableSessions,
        armTurn: true,
      });
      lines.push(
        `Watching Session ${target.handle}: a notice arrives ${sessionKindsText(policy.awaitableSessions, true)}.`,
      );
    }
  }
  if (tickets.targets.length > 0) {
    for (const target of tickets.targets) {
      watches.watchTicket({
        watcherSessionId: session.sessionId,
        ticketId: target.id,
        display: target.display,
        kinds: policy.awaitable,
      });
    }
    lines.push(
      `Watching ${tickets.targets.map((target) => target.display).join(", ")}: a notice arrives on ${policy.awaitable.map((kind) => TICKET_KIND_WORD[kind]).join(", ")} made by anyone but this Session, until you unwatch.`,
    );
  }
  lines.push(
    "This call did not wait. Keep working, or end your turn: a notice from Volli opens a new turn when something changes. Changes that land together arrive as one notice.",
  );
  return { details: { action, ...named, ended: 0 }, text: lines.join("\n") };
}

/** The line every retired await answers with, before what it armed. */
function retiredLine(tool: string): string {
  return `${tool} no longer waits: Volli now delivers these changes to this Session as notices, so this call returned at once and armed a watch instead. \`timeoutSeconds\` and \`cursor\` are ignored.`;
}

/**
 * `session_await`, retired (VC-457). Sessions whose frozen surface still names
 * the tool keep it — reattachment must rebind that exact surface — and calling
 * it now arms the equivalent watch and returns.
 */
export async function retiredSessionAwaitTool(
  ports: WatchToolPorts,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
): Promise<RuntimeVerbResult> {
  const raw = request.input.sessions;
  const handles = typeof raw === "string" ? parseSessionAwaitTargets(raw) : [];
  if (handles.length === 0 || handles.length > MAX_SESSION_AWAIT_TARGETS) {
    return refusal(
      "`sessions` must name one or more short session ids, for example 'a1b2c3d4 e5f6a7b8'.",
    );
  }
  const forRaw = request.input.for ?? "any";
  if (!isSessionAwaitFor(forRaw))
    return refusal("`for` must be one of: turn, verdict, stopped, any.");
  const project = ports.projects().find(({ id }) => id === session.projectId);
  const watches = ports.watches();
  if (project === undefined || watches === null) {
    return refusal("Nothing can be watched from this Session right now, so nothing was armed.");
  }
  const resolved = await resolveSessions(ports, session, project, handles);
  if (!resolved.ok) return refusal(resolved.text);
  const allowed = ports.authorityPolicy(project.id).actors.session.awaitableSessions;
  const kinds = sessionAwaitKindsFor(forRaw).filter((kind) => allowed.includes(kind));
  if (kinds.length === 0) {
    return refusal(
      `This project's policy does not allow watching for ${String(forRaw)}; it allows: ${allowed.join(", ") || "nothing"}.`,
    );
  }
  for (const target of resolved.targets) {
    watches.watchSession({
      watcherSessionId: session.sessionId,
      targetSessionId: target.id,
      title: target.title,
      kinds,
      armTurn: true,
    });
  }
  return {
    text: [
      retiredLine("session_await"),
      `Watching ${resolved.targets.map((target) => target.handle).join(", ")}: a notice arrives ${sessionKindsText(kinds, true)}.`,
    ].join("\n"),
  };
}

/** `ticket_await`, retired (VC-457) on the same terms as `session_await`. */
export async function retiredTicketAwaitTool(
  ports: WatchToolPorts,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
): Promise<RuntimeVerbResult> {
  const raw = request.input.tickets;
  const displays = typeof raw === "string" ? parseTicketAwaitTargets(raw) : [];
  if (displays.length === 0 || displays.length > MAX_TICKET_AWAIT_TARGETS) {
    return refusal(
      "`tickets` must name one or more ticket display ids, for example 'VC-12 VC-14'.",
    );
  }
  const forRaw = request.input.for ?? "any";
  if (!isTicketAwaitFor(forRaw))
    return refusal("`for` must be one of: signal, comment, status, any.");
  if (session.role === "subagent") {
    return refusal(
      "A subagent Session watches nothing; report what you found in your last message instead.",
    );
  }
  const project = ports.projects().find(({ id }) => id === session.projectId);
  const watches = ports.watches();
  if (project === undefined || watches === null) {
    return refusal("Nothing can be watched from this Session right now, so nothing was armed.");
  }
  const resolved = resolveTickets(ports, project, displays);
  if (!resolved.ok) return refusal(resolved.text);
  const allowed = ports.authorityPolicy(project.id).actors.session.awaitable;
  const kinds = ticketAwaitKindsFor(forRaw).filter((kind) => allowed.includes(kind));
  if (kinds.length === 0) {
    return refusal(
      `This project's policy does not allow watching for ${String(forRaw)}; it allows: ${allowed.join(", ") || "nothing"}.`,
    );
  }
  for (const target of resolved.targets) {
    watches.watchTicket({
      watcherSessionId: session.sessionId,
      ticketId: target.id,
      display: target.display,
      kinds,
    });
  }
  return {
    text: [
      retiredLine("ticket_await"),
      `Watching ${resolved.targets.map((target) => target.display).join(", ")}: a notice arrives on ${kinds.map((kind) => TICKET_KIND_WORD[kind]).join(", ")} made by anyone but this Session, until this Session stops.`,
    ].join("\n"),
  };
}
