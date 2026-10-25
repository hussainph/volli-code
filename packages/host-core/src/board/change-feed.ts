/**
 * The board's per-project change feed (VC-565; HP § Workspace change feed,
 * F1): one feed per project, a tracked cursor, resume or resnapshot.
 *
 * The host protocol called a project a "Workspace"; that word now names the
 * team container (CONTEXT.md), so this module says project throughout.
 *
 * - **Stamp.** Every board command stamps the rows it committed, naming the
 *   Client's `commandId` (T5), in the synchronous turn of its COMMIT; the
 *   agent socket's ticket create, update, move and comment are those
 *   commands (VC-794). Every other writer (the socket's verbs with no map
 *   entry yet, such as `ticket.signal` and `label.merge`, Session lifecycle,
 *   retention, worktree work) already announces `data-changed` on the host's
 *   event bus;
 *   {@link BoardChangeFeed.noteDataChanged} stamps those too, rowless, so no
 *   committed board change lacks a cursor whichever door made it. A command
 *   that stamps its own rows announces its `data-changed` through
 *   {@link BoardChangeFeed.untapped}, so it is not stamped twice.
 * - **Cursor.** Opaque to Clients: `epoch:instance:seq`. `seq` rises by one
 *   per stamp within one instance (this process's feed for one project).
 *   Never compared across projects, instances or epochs: a cursor from
 *   another is `subscription-resnapshot-required`.
 * - **Epoch.** Read on every use, never cached: when a project's authority
 *   epoch changes, its feed ends (every subscriber is told to resnapshot) and
 *   a new instance starts, so no cursor minted under the old epoch resumes and
 *   no new cursor carries it. A project the host no longer holds has its
 *   feed ended the same way ({@link BoardChangeFeed.dispose}).
 * - **Retention.** A bounded window compacted to the latest change per
 *   entity, tombstones included. A cursor older than what the window still
 *   answers for is `subscription-resnapshot-required`; a host restart starts a
 *   new instance, so every Client resnapshots. Durability can come later
 *   without a wire change, because the cursor is opaque.
 * - **Removal.** A Ticket's tombstone is the one stamp that says a Ticket left
 *   the board, whichever writer made it (an archive keeps the row; a delete
 *   drops both). {@link BoardChangeFeedOptions.onTicketRemoved} is the host's
 *   own notice of that fact, for reclaiming what the Ticket held.
 *
 * In memory, single-threaded, host-owned: no Electron, no transport.
 */
import { randomUUID } from "node:crypto";
import { FeedResnapshotRequiredError, type BoardChange, type DataChangeScope } from "@volli/shared";

import { hostLogger } from "../log/root";

const log = hostLogger("board-feed");

/** One delivery: the changes stamped up to and including `cursor`, oldest first. */
export interface BoardFeedBatch {
  readonly cursor: string;
  readonly changes: readonly BoardChange[];
}

export type BoardFeedListener = (batch: BoardFeedBatch) => void;

/** Told once when a subscription's feed ends under it: the error says resnapshot. */
export type BoardFeedEnded = (error: FeedResnapshotRequiredError) => void;

/** Entities a project's window answers for before it compacts the oldest away. */
export const BOARD_FEED_RETENTION = 2_048;

export interface BoardChangeFeedOptions {
  /** The project's authority epoch (VC-550); 0 on a host that never served it. */
  readonly epochOf?: (projectId: string) => number;
  /** The project a ticket belongs to, for a `data-changed` that names only the ticket. */
  readonly projectOfTicket?: (ticketId: string) => string | undefined;
  /** Every project the host holds, for an untargeted `data-changed`. */
  readonly projects?: () => readonly string[];
  /** Entities retained per project; {@link BOARD_FEED_RETENTION} by default. */
  readonly retention?: number;
  /**
   * Told once per Ticket a committed stamp removed from the board: the
   * tombstone an archive or a hard delete writes, and nothing else.
   *
   * Host teardown, not a Client delivery (VC-837 clears the Ticket's Browser
   * partition here). A throw is reported and swallowed — the command it hangs
   * off has already committed.
   */
  readonly onTicketRemoved?: (projectId: string, ticketId: string) => void;
}

interface Stamped {
  readonly seq: number;
  readonly change: BoardChange;
}

class ProjectFeed {
  readonly instance = randomUUID();
  seq = 0;
  /** Changes past this seq were compacted away: a cursor below it cannot resume. */
  floor = 0;
  readonly latest = new Map<string, Stamped>();
  /** Each subscriber, with what to tell it if this feed ends under it. */
  readonly listeners = new Map<BoardFeedListener, BoardFeedEnded | undefined>();

  constructor(readonly epoch: number) {}
}

function entityKey(change: BoardChange): string {
  return `${change.kind}:${change.id}`;
}

/** The board's change feeds, one per project, created on first use. */
export class BoardChangeFeed {
  readonly #feeds = new Map<string, ProjectFeed>();
  readonly #options: BoardChangeFeedOptions;
  readonly #retention: number;
  #untapped = 0;

  constructor(options: BoardChangeFeedOptions = {}) {
    this.#options = options;
    this.#retention = options.retention ?? BOARD_FEED_RETENTION;
  }

  /**
   * The project's live feed, under its epoch as it stands now: a feed made
   * under another epoch ends here and a new instance takes its place.
   */
  #feed(projectId: string): ProjectFeed {
    const epoch = this.#options.epochOf?.(projectId) ?? 0;
    const held = this.#feeds.get(projectId);
    if (held !== undefined && held.epoch === epoch) return held;
    if (held === undefined) this.#prune();
    else this.#end(projectId, held);
    const feed = new ProjectFeed(epoch);
    this.#feeds.set(projectId, feed);
    return feed;
  }

  /** Drops a feed and tells each of its subscribers to resnapshot. */
  #end(projectId: string, feed: ProjectFeed): void {
    // Every caller ends the feed the map holds for this project.
    this.#feeds.delete(projectId);
    const ended = [...feed.listeners.values()];
    feed.listeners.clear();
    for (const onEnded of ended) onEnded?.(new FeedResnapshotRequiredError());
  }

  /** Ends the feeds of projects the host no longer holds, when it can say which it holds. */
  #prune(): void {
    if (this.#options.projects === undefined || this.#feeds.size === 0) return;
    const held = new Set(this.#options.projects());
    // Deleting the entry being visited is safe in a Map's own iteration.
    for (const [projectId, feed] of this.#feeds) {
      if (!held.has(projectId)) this.#end(projectId, feed);
    }
  }

  /**
   * Ends one project's feed (it was removed): its cache is released and its
   * subscribers told to resnapshot. A later use starts a new instance.
   */
  dispose(projectId: string): void {
    const feed = this.#feeds.get(projectId);
    if (feed !== undefined) this.#end(projectId, feed);
  }

  /** How many projects have a feed in memory (a test's view of disposal). */
  get size(): number {
    return this.#feeds.size;
  }

  /** The project's current cursor: what a snapshot read in the same turn reflects. */
  cursor(projectId: string): string {
    return cursorOf(this.#feed(projectId));
  }

  /**
   * Stamps one committed write's changes, all of one project, and delivers
   * them to its subscribers at once. Call it in the synchronous turn of the
   * write's COMMIT, after it.
   */
  stamp(projectId: string, changes: readonly BoardChange[]): void {
    if (changes.length === 0) return;
    const feed = this.#feed(projectId);
    for (const change of changes) {
      const key = entityKey(change);
      feed.latest.delete(key);
      feed.latest.set(key, { seq: ++feed.seq, change });
    }
    // Insertion order is seq order, so the oldest entity is the first key.
    while (feed.latest.size > this.#retention) {
      const [oldestKey, oldest] = feed.latest.entries().next().value!;
      feed.latest.delete(oldestKey);
      feed.floor = oldest.seq;
    }
    // Before the subscribers: reclaim must not wait on, or be skipped by, one.
    this.#announceRemovals(changes);
    const batch: BoardFeedBatch = {
      cursor: cursorOf(feed),
      changes,
    };
    // A copy: a listener may unsubscribe while the batch is delivered.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...feed.listeners.keys()]) listener(batch);
  }

  /**
   * Reports the tombstones written by archive and delete commands, not rowless
   * invalidations or changes to other entities. Errors are logged and swallowed:
   * teardown must not unwind a command whose write has already committed.
   */
  #announceRemovals(changes: readonly BoardChange[]): void {
    const removed = this.#options.onTicketRemoved;
    if (removed === undefined) return;
    for (const change of changes) {
      if (change.kind !== "ticket" || change.op !== "delete") continue;
      try {
        removed(change.projectId, change.id);
      } catch (error) {
        log.error("ticket removal listener failed", { error, ticketId: change.id });
      }
    }
  }

  /**
   * Runs `announce` without the {@link noteDataChanged} tap: a command that
   * stamped its own rows still tells the windows, without a second stamp.
   */
  untapped<T>(announce: () => T): T {
    this.#untapped++;
    try {
      return announce();
    } finally {
      this.#untapped--;
    }
  }

  /**
   * Stamps a `data-changed` some other writer announced. It names no row, so
   * each change asks a Client to re-read: the ticket (its roster), or the
   * whole board when it names only a project, or every board when it names
   * nothing.
   */
  noteDataChanged(scope: DataChangeScope): void {
    if (this.#untapped > 0) return;
    const { ticketId } = scope;
    const projectId =
      scope.projectId ??
      (ticketId === undefined ? undefined : this.#options.projectOfTicket?.(ticketId));
    if (projectId === undefined) {
      this.#prune();
      const every = this.#options.projects?.() ?? [...this.#feeds.keys()];
      for (const id of every) {
        this.stamp(id, [{ kind: "project", op: "upsert", id, projectId: id }]);
      }
      return;
    }
    if (ticketId === undefined) {
      this.stamp(projectId, [{ kind: "project", op: "upsert", id: projectId, projectId }]);
      return;
    }
    // A comment is a row the board does not hold; its ticket's history grew.
    if (scope.kind === "comment") {
      this.stamp(projectId, [
        { kind: "ticketEvent", op: "upsert", id: ticketId, projectId, ticketId },
      ]);
      return;
    }
    this.stamp(projectId, [
      {
        kind: "ticket",
        op: "upsert",
        id: ticketId,
        projectId,
        ...(scope.kind === "worktree" ? { checkoutMoved: true } : {}),
      },
    ]);
  }

  /**
   * Follows one project's feed. With `after`, first delivers (as one batch)
   * the latest change of every entity stamped after that cursor, then live;
   * without one, live only (a Client that read a snapshot in this turn).
   * Throws {@link FeedResnapshotRequiredError} for a cursor this feed cannot
   * resume: another epoch or instance, compacted past, or never minted. Once
   * following, `onEnded` hears the same error if the feed ends under it (an
   * epoch change, or the project removed). Returns the unsubscribe.
   */
  subscribe(
    projectId: string,
    after: string | null,
    listener: BoardFeedListener,
    onEnded?: BoardFeedEnded,
  ): () => void {
    const feed = this.#feed(projectId);
    if (after !== null) {
      const seq = this.#resumable(feed, after);
      const replay = [...feed.latest.values()]
        .filter((stamped) => stamped.seq > seq)
        .map((stamped) => stamped.change);
      if (replay.length > 0) listener({ cursor: cursorOf(feed), changes: replay });
    }
    feed.listeners.set(listener, onEnded);
    return () => {
      feed.listeners.delete(listener);
    };
  }

  #resumable(feed: ProjectFeed, cursor: string): number {
    const [epoch, instance, seqText, ...rest] = cursor.split(":");
    const seq = Number(seqText);
    if (
      rest.length > 0 ||
      epoch !== String(feed.epoch) ||
      instance !== feed.instance ||
      !Number.isSafeInteger(seq) ||
      seq < feed.floor ||
      seq > feed.seq
    ) {
      throw new FeedResnapshotRequiredError();
    }
    return seq;
  }
}

function cursorOf(feed: ProjectFeed): string {
  return `${feed.epoch}:${feed.instance}:${feed.seq}`;
}

/** One host's board feeds. A composition root makes one and hands it to its handlers and its bus. */
export function createBoardChangeFeed(options: BoardChangeFeedOptions = {}): BoardChangeFeed {
  return new BoardChangeFeed(options);
}
