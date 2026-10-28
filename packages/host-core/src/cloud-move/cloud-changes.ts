/**
 * "Go back to local": what changed in Volli Cloud since a
 * project moved, read as the person through the window's own reads and saved
 * as a readable export beside the move, before the local copy is unlocked.
 * Nothing in Volli Cloud is changed or removed by it.
 *
 * - Tickets: every ticket with board activity after the commit (or born
 *   there), with its row, body, comments and that activity.
 * - Sessions: every Session active after the commit, with its events past
 *   the head it moved with (all of them for a Session born there).
 *
 * The export is `cloud-changes.json` (everything, as the reads answered it)
 * and `cloud-changes.md` (what a person reads first: counts, new comments).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withRetry } from "./backend";
import type { MovePlan } from "./plan";
import type { MoveBackend } from "./ports";

type Row = Record<string, unknown>;

export const CLOUD_CHANGES_FORMAT = "volli.cloud-changes/1";
const PAGE = 100;
const HISTORY_PAGE = 200;

export interface CloudChangesSummary {
  dir: string;
  tickets: number;
  comments: number;
  boardEvents: number;
  sessions: number;
  sessionEvents: number;
}

export async function saveCloudChanges(input: {
  backend: MoveBackend;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  projectId: string;
  committedAt: number;
  plan: Pick<MovePlan, "tickets" | "sessionList">;
  dir: string;
  now: number;
  signal: AbortSignal;
}): Promise<CloudChangesSummary> {
  const { signal } = input;
  const query = <T>(path: string, args: Row) =>
    withRetry(() => input.backend.query(path, args), {
      attempts: 6,
      baseMs: 1_000,
      maxMs: 30_000,
      sleep: input.sleep,
      signal,
    }) as Promise<T>;
  const after = (at: unknown) => typeof at === "number" && at > input.committedAt;

  // ---- tickets ----------------------------------------------------------------
  const roster = await query<{ tickets: Row[] }>("board:roster", { projectId: input.projectId });
  const all = [...roster.tickets];
  for (let cursor: string | null = null; ;) {
    const page: { page: Row[]; isDone: boolean; continueCursor: string } = await query(
      "board:archivedTickets",
      { projectId: input.projectId, paginationOpts: { numItems: PAGE, cursor } },
    );
    all.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  const tickets: Row[] = [];
  let comments = 0;
  let boardEvents = 0;
  for (const ticket of all) {
    signal.throwIfAborted();
    const ticketId = ticket.id as string;
    const events = (await query<Row[]>("board:ticketEvents", { ticketId })).filter((event) =>
      after(event.occurredAt),
    );
    const born = input.plan.tickets[ticketId] === undefined;
    if (!born && events.length === 0 && !after(ticket.updatedAt)) continue;
    const opened = await query<{ body: string }>("board:getTicket", { ticketId });
    const newComments = (await query<Row[]>("board:comments", { ticketId })).filter(
      (comment) => after(comment.createdAt) || after(comment.editedAt),
    );
    comments += newComments.length;
    boardEvents += events.length;
    tickets.push({ ticket, born, body: opened.body, comments: newComments, events });
  }

  // ---- Sessions ---------------------------------------------------------------
  const movedHead = new Map(input.plan.sessionList.map((s) => [s.sessionId, s.lastSequence]));
  const sessions: Row[] = [];
  let sessionEvents = 0;
  outer: for (let cursor: string | null = null; ;) {
    const page: { page: Row[]; isDone: boolean; continueCursor: string } = await query(
      "sessions:list",
      { projectId: input.projectId, paginationOpts: { numItems: PAGE, cursor } },
    );
    for (const session of page.page) {
      // Most recently active first: the rest did nothing since the move.
      if (!after(session.lastActivityAt)) break outer;
      const sessionId = session.id as string;
      const head = movedHead.get(sessionId) ?? 0;
      const events: Row[] = [];
      for (let from = head; ;) {
        signal.throwIfAborted();
        const history: { events: Row[]; hasMore: boolean } = await query("sessions:history", {
          sessionId,
          afterSequence: from,
          limit: HISTORY_PAGE,
        });
        events.push(...history.events);
        if (!history.hasMore || history.events.length === 0) break;
        from = history.events.at(-1)!.sequence as number;
      }
      sessionEvents += events.length;
      sessions.push({ session, born: !movedHead.has(sessionId), movedThrough: head, events });
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  await mkdir(input.dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(input.dir, "cloud-changes.json"),
    JSON.stringify(
      {
        format: CLOUD_CHANGES_FORMAT,
        projectId: input.projectId,
        movedAt: input.committedAt,
        savedAt: input.now,
        tickets,
        sessions,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const lines = [
    "# Changes made in Volli Cloud since this project moved",
    "",
    `Moved: ${new Date(input.committedAt).toISOString()} · saved: ${new Date(input.now).toISOString()}`,
    "",
    `- Tickets changed or created: ${tickets.length}`,
    `- Comments added or edited: ${comments}`,
    `- Board activity: ${boardEvents}`,
    `- Sessions active: ${sessions.length} (${sessionEvents} events)`,
    "",
    "Everything is in `cloud-changes.json`. The project's copy in Volli Cloud is unchanged.",
    "",
  ];
  for (const entry of tickets) {
    const ticket = entry.ticket as Row;
    lines.push(
      `## #${String(ticket.number)} ${String(ticket.title)}${entry.born ? " (new)" : ""}`,
      "",
    );
    for (const comment of entry.comments as Row[]) lines.push(String(comment.body), "", "---", "");
  }
  await writeFile(join(input.dir, "cloud-changes.md"), lines.join("\n"), { mode: 0o600 });
  return {
    dir: input.dir,
    tickets: tickets.length,
    comments,
    boardEvents,
    sessions: sessions.length,
    sessionEvents,
  };
}
