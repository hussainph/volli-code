/**
 * The board of a cloud launch (VC-889): each followed project's board read
 * live from Volli Cloud through the window's Convex client, and painted into
 * the board store (`paintBoard`), which every board surface already reads.
 *
 * - **Reads.** `open` watches the project's `board.roster`; every answer is
 *   projected (`projection.ts`) and painted, identity-preserving, so only the
 *   cards that changed redraw. The roster carries no body: the open ticket's
 *   own `board.getTicket` watch (`followTicket`) adopts it.
 * - **The open ticket.** {@link ConvexBoardSource.followTicket} watches its
 *   body, its history and its comments; a change to either of the last two
 *   publishes a planning change for it, so the Activity feed and the other
 *   per-ticket readers re-read exactly as they do for a local board.
 * - **A project that goes away.** A project the person can no longer read
 *   (`not_a_member`, `not_found`) is dropped, with one line naming why.
 * - **Writes** are refused in this release ("Not available for Volli Cloud
 *   projects yet"): the board is read-only until optimistic writes land.
 *
 * The client may start after the board is asked for: projects opened before
 * it are watched the moment it arrives ({@link ConvexBoardSource.attach}).
 * When it closes, every watch ends.
 */
import type {
  ArchivedTicket,
  DeliberateMoveChoice,
  Label,
  Ticket,
  TicketPriority,
  TicketStatus,
} from "@volli/shared";

import type { CloudSession } from "@renderer/lib/cloud-client";

import type { BoardSource, CreateFields, UpdateFields } from "../board-source";
import { projectArchived, projectBoard, type CloudRoster } from "./projection";

/** What the source does to the screen. */
export interface CloudBoardView {
  /** Paints one project's board. */
  paint(projectId: string, tickets: Ticket[], labels: Label[], unloaded: ReadonlySet<string>): void;
  /** Per-ticket surfaces re-read what the board does not hold. */
  notePlanningChange(change: { ticketId?: string; projectId?: string }): void;
  /** A read failed: say so (never swallow a failure). */
  failed(message: string): void;
  /** A write this release does not offer for a cloud project. */
  refused(message: string): void;
  /** The project is gone for this person: leave it, saying why. */
  dropped(projectId: string, message: string): void;
}

/** What a refused write says, for every write this release. */
export const CLOUD_WRITES_UNAVAILABLE = "Not available for Volli Cloud projects yet";

/** A Convex refusal's code and sentence, or the error's own message. */
export function cloudFailure(error: unknown): { code: string | null; message: string } {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const { code, message } = data as { code?: unknown; message?: unknown };
    if (typeof code === "string" && typeof message === "string") {
      return { code, message: message.slice(0, 300) };
    }
  }
  return {
    code: null,
    message: error instanceof Error && error.message !== "" ? error.message : "Unknown error",
  };
}

/** Whether a refusal means the person cannot see the project at all now. */
function gone(code: string | null): boolean {
  return code === "not_a_member" || code === "not_found";
}

interface Watched<T> {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): T | undefined;
}

interface Board {
  stop: (() => void) | null;
  roster: CloudRoster | null;
  /** The row each ticket had at the last paint, by id: what a change is measured against. */
  rows: Map<string, CloudRoster["tickets"][number]>;
  /** Whether the last read failed (said once, until a read lands). */
  failing: boolean;
}

/** How many Archive pages one load reads at most, and how many rows a page holds. */
export const ARCHIVE_PAGE_SIZE = 100;
export const ARCHIVE_PAGES_MAX = 10;

export class ConvexBoardSource implements BoardSource {
  readonly #view: CloudBoardView;
  #session: CloudSession | null = null;
  readonly #boards = new Map<string, Board>();
  readonly #bodies = new Map<string, string>();
  readonly #ticketProject = new Map<string, string>();

  constructor(view: CloudBoardView) {
    this.#view = view;
  }

  /** The client arrived (or closed, with `null`): watch every followed board, or stop them all. */
  attach(session: CloudSession | null): void {
    for (const board of this.#boards.values()) {
      board.stop?.();
      board.stop = null;
    }
    this.#session = session;
    if (session === null) return;
    for (const projectId of this.#boards.keys()) this.#watch(projectId);
  }

  follows(projectId: string): boolean {
    return this.#boards.has(projectId);
  }

  projectOf(ticketId: string): string | undefined {
    return this.#ticketProject.get(ticketId);
  }

  async open(projectId: string): Promise<void> {
    if (this.#boards.has(projectId)) return;
    this.#boards.set(projectId, { stop: null, roster: null, rows: new Map(), failing: false });
    if (this.#session !== null) this.#watch(projectId);
  }

  close(projectId: string): void {
    const board = this.#boards.get(projectId);
    if (board === undefined) return;
    board.stop?.();
    this.#boards.delete(projectId);
    for (const ticketId of board.rows.keys()) {
      this.#ticketProject.delete(ticketId);
      this.#bodies.delete(ticketId);
    }
  }

  closeAll(): void {
    for (const projectId of Array.from(this.#boards.keys())) this.close(projectId);
  }

  adoptBody(ticketId: string, body: string): void {
    if (this.#ticketProject.has(ticketId)) this.#bodies.set(ticketId, body);
  }

  #watch(projectId: string): void {
    const { client, api } = this.#session!;
    const watch = client.watchQuery(api.board.roster, { projectId }) as Watched<CloudRoster>;
    const board = this.#boards.get(projectId)!;
    board.stop = watch.onUpdate(() => this.#read(projectId, watch));
    this.#read(projectId, watch);
  }

  #read(projectId: string, watch: Watched<CloudRoster>): void {
    const board = this.#boards.get(projectId);
    if (board === undefined) return;
    let roster: CloudRoster | undefined;
    try {
      roster = watch.localQueryResult();
    } catch (error) {
      const failure = cloudFailure(error);
      if (gone(failure.code)) {
        this.close(projectId);
        this.#view.dropped(projectId, failure.message);
        return;
      }
      if (!board.failing) this.#view.failed(`Couldn’t read the board: ${failure.message}`);
      board.failing = true;
      return;
    }
    if (roster === undefined) return;
    board.failing = false;
    this.#paint(projectId, board, roster);
  }

  #paint(projectId: string, board: Board, roster: CloudRoster): void {
    const previous = board.rows;
    const first = board.roster === null;
    board.roster = roster;
    board.rows = new Map(roster.tickets.map((row) => [row.id, row]));
    for (const ticketId of previous.keys()) {
      if (board.rows.has(ticketId)) continue;
      this.#ticketProject.delete(ticketId);
      this.#bodies.delete(ticketId);
    }
    for (const row of roster.tickets) this.#ticketProject.set(row.id, projectId);
    const { tickets, labels, unloaded } = projectBoard(roster, this.#bodies);
    this.#view.paint(projectId, tickets, labels, unloaded);
    if (first) return;
    for (const row of roster.tickets) {
      if (previous.get(row.id)?.updatedAt === row.updatedAt) continue;
      this.#view.notePlanningChange({ ticketId: row.id, projectId });
    }
  }

  /**
   * Follows the open ticket: its body (each answer handed to `onBody`), and
   * its history and comments (a change after the first answer publishes a
   * planning change). `onError` hears a body read that failed. Answers the
   * function that stops it.
   */
  followTicket(
    ticketId: string,
    handlers: { onBody(body: string): void; onError(message: string): void },
  ): () => void {
    const session = this.#session;
    if (session === null) {
      handlers.onError("Volli Cloud isn’t connected yet.");
      return () => {};
    }
    const { client, api } = session;
    const body = client.watchQuery(api.board.getTicket, { ticketId }) as Watched<{
      body: string;
    }>;
    const readBody = () => {
      let answer: { body: string } | undefined;
      try {
        answer = body.localQueryResult();
      } catch (error) {
        handlers.onError(cloudFailure(error).message);
        return;
      }
      if (answer !== undefined) handlers.onBody(answer.body);
    };
    const stops = [body.onUpdate(readBody)];
    readBody();
    for (const reference of [api.board.ticketEvents, api.board.comments]) {
      const watch = client.watchQuery(reference, { ticketId }) as Watched<unknown>;
      let answered = safeResult(watch) !== undefined;
      stops.push(
        watch.onUpdate(() => {
          if (answered) {
            this.#view.notePlanningChange({ ticketId, projectId: this.projectOf(ticketId) });
          }
          answered = true;
        }),
      );
    }
    return () => {
      for (const stop of stops) stop();
    };
  }

  // ---- writes: not in this release ------------------------------------------

  #refuse(): void {
    this.#view.refused(CLOUD_WRITES_UNAVAILABLE);
  }

  async createTicket(_projectId: string, _fields: CreateFields): Promise<Ticket | null> {
    this.#refuse();
    return null;
  }

  async moveTickets(
    _projectId: string,
    _ticketIds: string[],
    _toStatus: TicketStatus,
    _toIndex: number,
    _choice?: DeliberateMoveChoice,
  ): Promise<void> {
    this.#refuse();
  }

  async setPriority(_projectId: string, _ticketId: string, _priority: TicketPriority) {
    this.#refuse();
  }

  async updateTicket(_projectId: string, _input: UpdateFields): Promise<Ticket | null> {
    this.#refuse();
    return null;
  }

  async setLabels(_projectId: string, _ticketId: string, _labels: string[]): Promise<void> {
    this.#refuse();
  }

  async setLabelColor(_projectId: string, _labelId: string, _color: string | null) {
    this.#refuse();
  }

  async archiveTicket(_projectId: string, _ticketId: string): Promise<boolean> {
    this.#refuse();
    return false;
  }

  async unarchiveTicket(_projectId: string, _archived: ArchivedTicket): Promise<Ticket | null> {
    this.#refuse();
    return null;
  }

  async deleteTicket(_projectId: string, _ticketId: string): Promise<boolean> {
    this.#refuse();
    return false;
  }

  /**
   * The project's Archive, newest-archived first, read a page at a time up
   * to {@link ARCHIVE_PAGES_MAX} pages; `null` when it could not be read
   * (already said).
   */
  async archivedTickets(projectId: string): Promise<ArchivedTicket[] | null> {
    const session = this.#session;
    if (session === null) {
      this.#view.failed("Couldn’t load the archive: Volli Cloud isn’t connected yet.");
      return null;
    }
    const labels = this.#boards.get(projectId)?.roster?.labels ?? [];
    const archived: ArchivedTicket[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < ARCHIVE_PAGES_MAX; page++) {
        const answer = (await session.client.query(session.api.board.archivedTickets, {
          projectId,
          paginationOpts: { numItems: ARCHIVE_PAGE_SIZE, cursor },
        })) as {
          page: Parameters<typeof projectArchived>[0];
          isDone: boolean;
          continueCursor: string;
        };
        archived.push(...projectArchived(answer.page, labels));
        if (answer.isDone) break;
        cursor = answer.continueCursor;
      }
    } catch (error) {
      this.#view.failed(`Couldn’t load the archive: ${cloudFailure(error).message}`);
      return null;
    }
    return archived;
  }
}

/** A watch's cached answer, or `undefined` when it has none (or it failed). */
function safeResult(watch: Watched<unknown>): unknown {
  try {
    return watch.localQueryResult();
  } catch {
    return undefined;
  }
}
