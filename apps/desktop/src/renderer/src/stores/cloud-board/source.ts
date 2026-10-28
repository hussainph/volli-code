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
 * - **Writes** go to the backend's board mutations, each with its optimistic
 *   update (`optimistic.ts`, the shared rules over the client's own rows) so
 *   the board repaints in the same frame. A write is refused at once, never
 *   queued, unless the link serves and the socket is up; a refusal from the
 *   backend rolls its paint back and says the backend's sentence. Deleting a
 *   ticket, and a runner's branch fields, are not offered for cloud tickets.
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
  TicketComment,
  TicketPriority,
  TicketStatus,
} from "@volli/shared";
import { DEFAULT_HARNESS_ID } from "@volli/shared";
import {
  boardTicketFromRow,
  dropNeighbours,
  newId,
  type TicketId,
  type UpdateTicketCommand,
} from "@volli/shared/cloud";

import type { CloudSession } from "@renderer/lib/cloud-client";

import type { BoardSource, CreateFields, UpdateFields } from "../board-source";
import {
  optimisticArchive,
  optimisticComment,
  optimisticCreate,
  optimisticLabelColor,
  optimisticMove,
  optimisticUnarchive,
  optimisticUpdate,
  type LocalStore,
} from "./optimistic";
import { projectArchived, projectBoard, projectComments, type CloudRoster } from "./projection";

/** What the source does to the screen. */
export interface CloudBoardView {
  /** Paints one project's board. */
  paint(projectId: string, tickets: Ticket[], labels: Label[], unloaded: ReadonlySet<string>): void;
  /** Per-ticket surfaces re-read what the board does not hold. */
  notePlanningChange(change: { ticketId?: string; projectId?: string }): void;
  /** A read failed: say so (never swallow a failure). */
  failed(message: string): void;
  /** A write that may not go (read-only now, or not offered for a cloud project). */
  refused(message: string): void;
  /** A write still unanswered, or an answer worth a word that is not a failure. */
  unconfirmed(message: string): void;
  /**
   * Why the project cannot be written to now (its link's words), or `null`
   * when it can; `undefined` asks about Volli Cloud itself, for a ticket whose
   * project this source has not read (one the offline snapshot painted).
   */
  readOnly(projectId: string | undefined): string | null;
  /** The project is gone for this person: leave it, saying why. */
  dropped(projectId: string, message: string, code?: "not_a_member"): void;
}

/** What a write a cloud ticket does not offer says. */
export const CLOUD_WRITES_UNAVAILABLE = "Not available for Volli Cloud projects yet";

/** What a write says while the client is not connected. */
export const CLOUD_READ_ONLY = "Can’t reach Volli Cloud · Read-only";

/** What a drop says before its board has loaded. */
export const BOARD_NOT_LOADED = "The board hasn’t loaded yet.";

/** What recoloring a label the backend has not named yet says. */
export const LABEL_PENDING = "That label is still being saved.";

/** The fields a cloud ticket's update sends. */
type CloudUpdate = Pick<UpdateTicketCommand, "title" | "body" | "priority" | "checkoutMode"> & {
  labels?: string[];
};

/** How long a write may go unanswered on a connected socket before it says so. */
export const UNCONFIRMED_AFTER_MS = 5_000;

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

/** A live query as the board reads it: its answer now, and a call on every change. */
export interface Watched<T> {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): T | undefined;
}

interface Board {
  stop: (() => void) | null;
  /** The roster's live query while watched: its answer includes pending updates. */
  watch: Watched<CloudRoster> | null;
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
  /** Who this window's writes are by, as an optimistic row names them. */
  readonly #actor: { readonly kind: "person"; readonly userId: string };
  #session: CloudSession | null = null;
  readonly #boards = new Map<string, Board>();
  readonly #bodies = new Map<string, string>();
  readonly #ticketProject = new Map<string, string>();

  constructor(view: CloudBoardView, userId: string) {
    this.#view = view;
    this.#actor = { kind: "person", userId };
  }

  /** The client arrived (or closed, with `null`): watch every followed board, or stop them all. */
  attach(session: CloudSession | null): void {
    for (const board of this.#boards.values()) {
      board.stop?.();
      board.stop = null;
      board.watch = null;
    }
    this.#session = session;
    if (session === null) return;
    for (const projectId of this.#boards.keys()) this.#watch(projectId);
  }

  follows(projectId: string): boolean {
    return this.#boards.has(projectId);
  }

  /** Whether the project's board has painted from a live answer (what an offline snapshot may keep). */
  painted(projectId: string): boolean {
    return (this.#boards.get(projectId)?.roster ?? null) !== null;
  }

  projectOf(ticketId: string): string | undefined {
    return this.#ticketProject.get(ticketId);
  }

  async open(projectId: string): Promise<void> {
    if (this.#boards.has(projectId)) return;
    this.#boards.set(projectId, {
      stop: null,
      watch: null,
      roster: null,
      rows: new Map(),
      failing: false,
    });
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
    board.watch = watch;
    board.stop = watch.onUpdate(() => this.#read(projectId, watch));
    this.#read(projectId, watch);
  }

  #read(projectId: string, watch: Watched<CloudRoster>): void {
    // A queued callback may outlive its subscription or belong to a previous
    // visit to this project. Neither may paint into the new Workspace.
    const board = this.#boards.get(projectId);
    if (board === undefined || board.watch !== watch) return;
    let roster: CloudRoster | undefined;
    try {
      roster = watch.localQueryResult();
    } catch (error) {
      const failure = cloudFailure(error);
      if (gone(failure.code)) {
        this.close(projectId);
        if (failure.code === "not_a_member")
          this.#view.dropped(projectId, failure.message, "not_a_member");
        else this.#view.dropped(projectId, failure.message);
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

  // ---- writes ---------------------------------------------------------------

  /**
   * One write: refused at once, and never issued, unless the project's link
   * serves and the socket is up (writes never queue, §7.4); otherwise issued
   * with its optimistic update. A write still unanswered after
   * {@link UNCONFIRMED_AFTER_MS} on a connected socket says so once (it may
   * still land: it is idempotent by its command id). A refusal rolls the
   * paint back (Convex) and says the backend's sentence. Resolves the reply,
   * or `null` when it was refused or failed (already said).
   */
  async #write<Reply>(
    projectId: string | undefined,
    verb: string,
    issue: (session: CloudSession) => Promise<Reply>,
  ): Promise<Reply | null> {
    const outcome = await this.#issue(projectId, issue);
    if (outcome.ok) return outcome.reply;
    if (outcome.refused) this.#view.refused(outcome.error);
    // A project dropped for it has said why already.
    else if (!outcome.dropped) this.#view.failed(`Couldn’t ${verb}: ${outcome.error}`);
    return null;
  }

  /** {@link #write} without the saying: the caller reports the outcome itself. */
  async #issue<Reply>(
    projectId: string | undefined,
    issue: (session: CloudSession) => Promise<Reply>,
  ): Promise<
    { ok: true; reply: Reply } | { ok: false; error: string; refused: boolean; dropped: boolean }
  > {
    const refusal = this.#refusal(projectId);
    if (refusal !== null) return { ok: false, error: refusal, refused: true, dropped: false };
    const session = this.#session!;
    const unconfirmed = setTimeout(() => {
      if (session.client.connectionState().isWebSocketConnected) {
        this.#view.unconfirmed("Still saving to Volli Cloud…");
      }
    }, UNCONFIRMED_AFTER_MS);
    try {
      return { ok: true, reply: await issue(session) };
    } catch (error) {
      const failure = cloudFailure(error);
      // Only a lost membership is about the project; a write's `not_found`
      // names the ticket, neighbour or comment it named, and the roster's own
      // watch notices a project that is really gone.
      const dropped = projectId !== undefined && failure.code === "not_a_member";
      if (dropped) {
        this.close(projectId);
        this.#view.dropped(projectId, failure.message, "not_a_member");
      }
      return { ok: false, error: failure.message, refused: false, dropped };
    } finally {
      clearTimeout(unconfirmed);
    }
  }

  /** Why a write to the project may not go now, or `null` when it may. */
  #refusal(projectId: string | undefined): string | null {
    const session = this.#session;
    if (session === null || !session.client.connectionState().isWebSocketConnected) {
      return CLOUD_READ_ONLY;
    }
    return this.#view.readOnly(projectId);
  }

  /** The project's roster as the client holds it now, its pending updates included. */
  #liveRoster(projectId: string): CloudRoster | null {
    const watch = this.#boards.get(projectId)?.watch;
    if (watch === undefined || watch === null) return null;
    try {
      return watch.localQueryResult() ?? null;
    } catch {
      return null;
    }
  }

  /** The ticket as the board paints it now (after a write's answer). */
  #ticket(projectId: string, ticketId: string): Ticket | null {
    const roster = this.#liveRoster(projectId);
    if (roster === null) return null;
    return projectBoard(roster, this.#bodies).tickets.find(({ id }) => id === ticketId) ?? null;
  }

  async createTicket(projectId: string, fields: CreateFields): Promise<Ticket | null> {
    const ticketId = newId("ticket");
    const command = {
      ticketId,
      status: fields.status,
      title: fields.title,
      ...(fields.priority === undefined ? {} : { priority: fields.priority }),
      ...(fields.body === undefined ? {} : { body: fields.body }),
      ...(fields.labels === undefined ? {} : { labels: fields.labels }),
      ...(fields.usesWorktree === undefined
        ? {}
        : {
            checkoutMode: fields.usesWorktree ? ("worktree" as const) : ("main_checkout" as const),
          }),
      ...(fields.preferredHarnessId === undefined
        ? {}
        : { preferredHarnessId: fields.preferredHarnessId }),
      ...(fields.baseBranch === undefined ? {} : { baseBranch: fields.baseBranch }),
    };
    if (command.body !== undefined) this.#bodies.set(ticketId, command.body);
    // Stamped once: Convex re-runs the update on every push until it settles.
    const issuedAt = Date.now();
    const reply = await this.#write(projectId, "create ticket", ({ client, api }) =>
      client.mutation(
        api.board.createTicket,
        { commandId: newId("command"), projectId, ...command },
        {
          optimisticUpdate: (store) =>
            optimisticCreate(store as unknown as LocalStore, api.board, {
              projectId,
              command,
              createdBy: this.#actor,
              now: issuedAt,
            }),
        },
      ),
    );
    if (reply === null) {
      this.#bodies.delete(ticketId);
      return null;
    }
    this.#ticketProject.set(ticketId, projectId);
    // Accepted: the card as the board paints it, or as accepted when the
    // board cannot be read right now (never "not created": a retry would duplicate it).
    return (
      this.#ticket(projectId, ticketId) ?? {
        id: ticketId,
        projectId,
        ticketNumber: reply.number,
        title: fields.title.trim(),
        body: fields.body ?? "",
        status: fields.status,
        priority: fields.priority ?? "medium",
        labels: [...(fields.labels ?? [])],
        usesWorktree: fields.usesWorktree ?? true,
        preferredHarnessId: fields.preferredHarnessId ?? DEFAULT_HARNESS_ID,
        order: 0,
        worktreePath: null,
        branch: null,
        baseBranch: fields.baseBranch ?? null,
        prUrl: null,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      }
    );
  }

  async moveTickets(
    projectId: string,
    ticketIds: string[],
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void> {
    const roster = this.#liveRoster(projectId);
    if (roster === null) {
      // A drop's place is read off the board; without one it would land elsewhere.
      this.#view.refused(BOARD_NOT_LOADED);
      return;
    }
    const facts = roster.tickets.map(boardTicketFromRow);
    const issuedAt = Date.now();
    const command = {
      ticketIds: ticketIds as TicketId[],
      toStatus,
      ...dropNeighbours(facts, toStatus, ticketIds, toIndex),
      ...(choice === undefined ? {} : { choice }),
    };
    const reply = await this.#write(
      projectId,
      ticketIds.length === 1 ? "move ticket" : "move tickets",
      ({ client, api }) =>
        client.mutation(
          api.board.moveTickets,
          { commandId: newId("command"), projectId, ...command },
          {
            optimisticUpdate: (store) =>
              optimisticMove(store as unknown as LocalStore, api.board, {
                projectId,
                command,
                now: issuedAt,
              }),
          },
        ),
    );
    if (reply !== null && reply.unstartedRuns.length > 0) {
      this.#view.unconfirmed("The picked Automation has nowhere to run yet.");
    }
  }

  async setPriority(projectId: string, ticketId: string, priority: TicketPriority) {
    await this.#update(projectId, ticketId, "update priority", { priority });
  }

  async updateTicket(projectId: string, input: UpdateFields): Promise<Ticket | null> {
    const { ticketId, title, body, usesWorktree } = input;
    const command: CloudUpdate = {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(usesWorktree === undefined
        ? {}
        : { checkoutMode: usesWorktree ? "worktree" : "main_checkout" }),
    };
    // A branch is a runner's: a cloud ticket offers no field for it.
    if (Object.keys(command).length === 0) {
      this.#view.refused(CLOUD_WRITES_UNAVAILABLE);
      return null;
    }
    const done = await this.#update(projectId, ticketId, "update ticket", command);
    if (!done) return null;
    if (body !== undefined) this.#bodies.set(ticketId, body);
    return this.#ticket(projectId, ticketId);
  }

  async setLabels(projectId: string, ticketId: string, labels: string[]): Promise<void> {
    await this.#update(projectId, ticketId, "update labels", { labels });
  }

  async #update(
    projectId: string,
    ticketId: string,
    verb: string,
    command: CloudUpdate,
  ): Promise<boolean> {
    const issuedAt = Date.now();
    const reply = await this.#write(projectId, verb, ({ client, api }) =>
      client.mutation(
        api.board.updateTicket,
        { commandId: newId("command"), ticketId, ...command },
        {
          optimisticUpdate: (store) =>
            optimisticUpdate(store as unknown as LocalStore, api.board, {
              projectId,
              ticketId,
              command,
              now: issuedAt,
            }),
        },
      ),
    );
    return reply !== null;
  }

  async setLabelColor(projectId: string, labelId: string, color: string | null) {
    if (labelId.startsWith("pending:")) {
      this.#view.refused(LABEL_PENDING);
      return;
    }
    await this.#write(projectId, "update label color", ({ client, api }) =>
      client.mutation(
        api.board.setLabelColor,
        { commandId: newId("command"), labelId, color },
        {
          optimisticUpdate: (store) =>
            optimisticLabelColor(store as unknown as LocalStore, api.board, {
              projectId,
              labelId,
              color,
            }),
        },
      ),
    );
  }

  async archiveTicket(projectId: string, ticketId: string): Promise<boolean> {
    const reply = await this.#write(projectId, "archive ticket", ({ client, api }) =>
      client.mutation(
        api.board.archiveTicket,
        { commandId: newId("command"), ticketId },
        {
          optimisticUpdate: (store) =>
            optimisticArchive(store as unknown as LocalStore, api.board, { projectId, ticketId }),
        },
      ),
    );
    return reply !== null;
  }

  async unarchiveTicket(projectId: string, archived: ArchivedTicket): Promise<Ticket | null> {
    const ticketId = archived.id;
    const issuedAt = Date.now();
    const reply = await this.#write(projectId, "unarchive ticket", ({ client, api }) =>
      client.mutation(
        api.board.unarchiveTicket,
        { commandId: newId("command"), ticketId },
        {
          optimisticUpdate: (store) =>
            optimisticUnarchive(store as unknown as LocalStore, api.board, {
              projectId,
              ticketId,
              now: issuedAt,
            }),
        },
      ),
    );
    if (reply === null) return null;
    const { archivedAt: _archivedAt, ...live } = archived;
    return this.#ticket(projectId, ticketId) ?? live;
  }

  /** Deletion is retention's (L5): a cloud ticket offers Archive only. */
  async deleteTicket(_projectId: string, _ticketId: string): Promise<boolean> {
    this.#view.refused(CLOUD_WRITES_UNAVAILABLE);
    return false;
  }

  /**
   * A comment written on a ticket of a followed board: its new id, or the
   * failure's sentence (the caller says it). Gated and painted like every
   * board write.
   */
  async createComment(
    ticketId: string,
    body: string,
  ): Promise<{ ok: true; comment: TicketComment } | { ok: false; error: string }> {
    const commentId = newId("comment");
    const now = Date.now();
    const projectId = this.projectOf(ticketId);
    const row = {
      id: commentId,
      ticketId,
      projectId: projectId ?? "",
      sessionId: null,
      author: this.#actor,
      body,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
    };
    const outcome = await this.#issue(projectId, ({ client, api }) =>
      client.mutation(
        api.board.createComment,
        { commandId: newId("command"), ticketId, commentId, body },
        {
          optimisticUpdate: (store) =>
            optimisticComment(store as unknown as LocalStore, api.board, {
              kind: "create",
              ticketId,
              comment: row,
            }),
        },
      ),
    );
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return { ok: true, comment: projectComments([row])[0]! };
  }

  /** An edit of a comment on a ticket of a followed board. */
  async updateComment(
    ticketId: string,
    commentId: string,
    body: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const issuedAt = Date.now();
    const outcome = await this.#issue(this.projectOf(ticketId), ({ client, api }) =>
      client.mutation(
        api.board.updateComment,
        { commandId: newId("command"), commentId, body },
        {
          optimisticUpdate: (store) =>
            optimisticComment(store as unknown as LocalStore, api.board, {
              kind: "update",
              ticketId,
              commentId,
              body,
              now: issuedAt,
            }),
        },
      ),
    );
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  }

  /** A removal of a comment on a ticket of a followed board. */
  async removeComment(
    ticketId: string,
    commentId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const outcome = await this.#issue(this.projectOf(ticketId), ({ client, api }) =>
      client.mutation(
        api.board.removeComment,
        { commandId: newId("command"), commentId },
        {
          optimisticUpdate: (store) =>
            optimisticComment(store as unknown as LocalStore, api.board, {
              kind: "remove",
              ticketId,
              commentId,
            }),
        },
      ),
    );
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
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
