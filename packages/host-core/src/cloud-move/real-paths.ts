/**
 * The real-path check after the commit: the moved project read
 * back as the person, through the same public queries the window uses, and
 * compared with the export. The storage check before the commit proves the
 * rows are there; this proves the app can show them.
 *
 * - The project in its Workspace's list (`projects.list`) and its board
 *   (`board.roster`): every live ticket, with its number, title and column.
 * - A sample of tickets (the largest open ones and a spread of the rest):
 *   body (`board.getTicket`), comments (`board.comments`) and activity
 *   (`board.ticketEvents`).
 * - Every moved Session folded to its head (`projectImportHistory.foldProgress`,
 *   waited for: the commit starts the folds), then a sample of Sessions
 *   (newest, oldest, largest and one of each role):
 *   folded to their last event (`sessions.snapshot`, waited for, since the
 *   commit starts the first fold), then every event through
 *   `sessions.history`, in order, by id, each one readable.
 *
 * Transcript bodies and attachments are read back once their read paths
 * carry moved Sessions and blobs (VC-990, VC-985). Counts and ids in the
 * report, never content.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MigrationExportManifest } from "../migration-export/exporter";
import { MANIFEST_FILE } from "../migration-export/staging";
import { MOVE_RETRY, withRetry } from "./backend";
import { exportRecords } from "./plan";
import type { MoveBackend, MoveRealPathCheck, RealPathInput, RealPathReport } from "./ports";

type Row = Record<string, unknown>;

const TICKET_SAMPLE = 20;
const SESSION_SAMPLE = 20;
const HISTORY_PAGE = 200;

export interface WindowReadCheckOptions {
  backend: MoveBackend;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** How long the first folds may take before the check reports them unfinished. */
  foldTimeoutMs?: number;
}

/** A deterministic spread: every `n`-th of `items`, at most `limit`. */
function spread<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]!);
}

export function windowReadCheck(options: WindowReadCheckOptions): MoveRealPathCheck {
  const now = options.now ?? Date.now;
  const foldTimeoutMs = options.foldTimeoutMs ?? 15 * 60_000;

  return {
    async check(input: RealPathInput, signal: AbortSignal): Promise<RealPathReport> {
      const call = <T>(kind: "query", path: string, args: Row) =>
        withRetry(() => options.backend[kind](path, args), {
          ...MOVE_RETRY,
          sleep: options.sleep,
          signal,
        }) as Promise<T>;
      const failures: string[] = [];
      const checks: RealPathReport["checks"] = {};
      const tally = (name: string, ok: boolean) => {
        const entry = (checks[name] ??= { checked: 0, failed: 0 });
        entry.checked += 1;
        if (!ok) entry.failed += 1;
      };
      const manifest = JSON.parse(
        await readFile(join(input.exportDir, MANIFEST_FILE), "utf8"),
      ) as MigrationExportManifest;
      const records = (name: Parameters<typeof exportRecords>[2]) =>
        exportRecords(input.exportDir, manifest, name);

      // ---- the project and its board ------------------------------------------
      let projectName: unknown = null;
      for await (const project of records("projects")) projectName = project.name;
      // Listed for the Workspace, as the rail lists it.
      const listed = await call<Row[]>("query", "projects:list", {
        workspaceId: input.workspaceId,
      });
      const shown = listed.find((project) => project.id === input.projectId);
      tally("project", shown !== undefined && shown.name === projectName);

      const tickets = new Map<string, Row>();
      for await (const ticket of records("tickets")) tickets.set(ticket.id as string, ticket);
      const roster = await call<{ tickets: Row[] }>("query", "board:roster", {
        projectId: input.projectId,
      });
      const live = [...tickets.values()].filter((ticket) => ticket.archivedAt === null);
      const onBoard = new Map(roster.tickets.map((ticket) => [ticket.id as string, ticket]));
      tally("boardTickets", onBoard.size === live.length);
      for (const ticket of live) {
        const row = onBoard.get(ticket.id as string);
        tally(
          "boardTicket",
          row !== undefined &&
            row.number === ticket.number &&
            row.title === ticket.title &&
            row.status === ticket.status,
        );
      }

      // ---- a sample of tickets, opened --------------------------------------------
      const bodies = new Map<string, string>();
      for await (const body of records("ticketBodies")) {
        bodies.set(body.ticketId as string, body.body as string);
      }
      const byBody = live.toSorted(
        (a, b) =>
          (bodies.get(b.id as string)?.length ?? 0) - (bodies.get(a.id as string)?.length ?? 0),
      );
      const sampled = new Set([
        ...byBody.slice(0, TICKET_SAMPLE).map((ticket) => ticket.id as string),
        ...spread([...tickets.keys()], TICKET_SAMPLE),
      ]);
      const comments = new Map<string, Map<string, string>>();
      for await (const comment of records("ticketComments")) {
        const ticketId = comment.ticketId as string;
        if (!sampled.has(ticketId)) continue;
        if (!comments.has(ticketId)) comments.set(ticketId, new Map());
        comments.get(ticketId)!.set(comment.id as string, comment.body as string);
      }
      const events = new Map<string, number>();
      for await (const event of records("boardEvents")) {
        const ticketId = event.ticketId as string;
        if (sampled.has(ticketId)) events.set(ticketId, (events.get(ticketId) ?? 0) + 1);
      }
      for (const ticketId of sampled) {
        signal.throwIfAborted();
        const opened = await call<{ body: string }>("query", "board:getTicket", { ticketId });
        tally("ticketBody", opened.body === (bodies.get(ticketId) ?? ""));
        const shownComments = await call<Row[]>("query", "board:comments", { ticketId });
        const want = comments.get(ticketId) ?? new Map<string, string>();
        tally(
          "ticketComments",
          shownComments.length === want.size &&
            shownComments.every((comment) => want.get(comment.id as string) === comment.body),
        );
        const shownEvents = await call<Row[]>("query", "board:ticketEvents", { ticketId });
        tally("ticketActivity", shownEvents.length === (events.get(ticketId) ?? 0));
      }

      // ---- a sample of Sessions, folded and read ---------------------------------
      const sessionRows: Row[] = [];
      for await (const session of records("sessions")) sessionRows.push(session);
      const pick = new Set<string>();
      const add = (rows: Row[]) => {
        for (const row of rows) {
          if (pick.size >= SESSION_SAMPLE) return;
          pick.add(row.id as string);
        }
      };
      const roles = new Map<string, Row>();
      for (const row of sessionRows)
        if (!roles.has(row.role as string)) roles.set(row.role as string, row);
      add([...roles.values()]);
      add(
        sessionRows
          .toSorted((a, b) => (b.lastActivityAt as number) - (a.lastActivityAt as number))
          .slice(0, 5),
      );
      add(
        sessionRows
          .toSorted((a, b) => (b.lastSequence as number) - (a.lastSequence as number))
          .slice(0, 5),
      );
      add(
        sessionRows
          .toSorted((a, b) => (a.createdAt as number) - (b.createdAt as number))
          .slice(0, 5),
      );
      add(spread(sessionRows, SESSION_SAMPLE));

      const expected = new Map<string, string[]>([...pick].map((id) => [id, []]));
      for await (const event of records("sessionEvents")) {
        expected.get(event.sessionId as string)?.push(event.id as string);
      }
      const deadline = now() + foldTimeoutMs;
      // Every moved Session folded to its head (the commit starts the folds),
      // a full pass of the move's own progress finding nothing behind.
      let allFolded = false;
      for (let wait = 500; ; wait = Math.min(wait * 2, 15_000)) {
        let behind = 0;
        for (let cursor: string | null = null; ;) {
          const page: { behind: unknown[]; isDone: boolean; continueCursor: string } = await call(
            "query",
            "projectImportHistory:foldProgress",
            { moveId: input.moveId, cursor },
          );
          behind += page.behind.length;
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
        if (behind === 0) {
          allFolded = true;
          break;
        }
        if (now() + wait > deadline) break;
        await options.sleep(wait, signal);
      }
      tally("allSessionsFolded", allFolded);
      for (const sessionId of pick) {
        signal.throwIfAborted();
        const ids = expected.get(sessionId)!;
        // The commit starts every moved Session's first fold: wait for this one's.
        let folded = false;
        for (let wait = 500; ; wait = Math.min(wait * 2, 15_000)) {
          const snapshot = await call<{ foldedThrough: number }>("query", "sessions:snapshot", {
            sessionId,
          });
          if (snapshot.foldedThrough >= ids.length) {
            folded = true;
            break;
          }
          if (now() + wait > deadline) break;
          await options.sleep(wait, signal);
        }
        tally("sessionFolded", folded);
        if (!folded) failures.push(`Session ${sessionId} was not folded in time`);
        let after = 0;
        let same = true;
        let unreadable = 0;
        for (;;) {
          const page = await call<{ events: Row[]; hasMore: boolean }>(
            "query",
            "sessions:history",
            {
              sessionId,
              afterSequence: after,
              limit: HISTORY_PAGE,
            },
          );
          for (const entry of page.events) {
            const sequence = entry.sequence as number;
            if (sequence !== after + 1 || ids[sequence - 1] !== entry.eventId) same = false;
            // Moved as it was: a quarantined fact was quarantined on this Mac too.
            if (entry.status === "unreadable") unreadable += 1;
            after = sequence;
          }
          if (!page.hasMore || page.events.length === 0) break;
        }
        tally("sessionHistory", same && after === ids.length);
        tally("sessionEventsReadable", unreadable === 0);
      }

      for (const [name, { failed }] of Object.entries(checks)) {
        if (failed > 0) failures.push(`${name}: ${failed} did not match`);
      }
      return { ok: failures.length === 0, checks, failures };
    },
  };
}
