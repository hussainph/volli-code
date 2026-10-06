/**
 * The Workspace change feed for the board (VC-565; HP § Workspace change
 * feed, F1): one feed per Workspace, a tracked cursor, resume or resnapshot.
 *
 * - **Stamp.** Every board command stamps the rows it committed, naming the
 *   Client's `commandId` (T5), in the synchronous turn of its COMMIT. Every
 *   other writer (the agent socket's verbs, Session lifecycle, retention,
 *   worktree work) already announces `data-changed` on the host's event bus;
 *   {@link BoardChangeFeed.noteDataChanged} stamps those too, rowless, so no
 *   committed board change lacks a cursor whichever door made it. A command
 *   that stamps its own rows announces its `data-changed` through
 *   {@link BoardChangeFeed.untapped}, so it is not stamped twice.
 * - **Cursor.** Opaque to Clients: `epoch:instance:seq`. `seq` rises by one
 *   per stamp within one instance (this process's feed for one Workspace).
 *   Never compared across Workspaces, instances or epochs: a cursor from
 *   another is `subscription-resnapshot-required`.
 * - **Retention.** A bounded window compacted to the latest change per
 *   entity, tombstones included. A cursor older than what the window still
 *   answers for is `subscription-resnapshot-required`; a host restart starts a
 *   new instance, so every Client resnapshots. Durability can come later
 *   without a wire change, because the cursor is opaque.
 *
 * In memory, single-threaded, host-owned: no Electron, no transport.
 */
import { randomUUID } from "node:crypto";
import { FeedResnapshotRequiredError, type BoardChange, type DataChangeScope } from "@volli/shared";

/** One delivery: the changes stamped up to and including `cursor`, oldest first. */
export interface BoardFeedBatch {
  readonly cursor: string;
  readonly changes: readonly BoardChange[];
}

export type BoardFeedListener = (batch: BoardFeedBatch) => void;

/** Entities a Workspace's window answers for before it compacts the oldest away. */
export const BOARD_FEED_RETENTION = 2_048;

export interface BoardChangeFeedOptions {
  /** The Workspace's authority epoch (VC-550); 0 on a host that never served it. */
  readonly epochOf?: (workspaceId: string) => number;
  /** The project a ticket belongs to, for a `data-changed` that names only the ticket. */
  readonly projectOfTicket?: (ticketId: string) => string | undefined;
  /** Every Workspace the host holds, for an untargeted `data-changed`. */
  readonly workspaces?: () => readonly string[];
  /** Entities retained per Workspace; {@link BOARD_FEED_RETENTION} by default. */
  readonly retention?: number;
}

interface Stamped {
  readonly seq: number;
  readonly change: BoardChange;
}

class WorkspaceFeed {
  readonly instance = randomUUID();
  seq = 0;
  /** Changes past this seq were compacted away: a cursor below it cannot resume. */
  floor = 0;
  readonly latest = new Map<string, Stamped>();
  readonly listeners = new Set<BoardFeedListener>();

  constructor(readonly epoch: number) {}
}

function entityKey(change: BoardChange): string {
  return `${change.kind}:${change.id}`;
}

/** The board's change feeds, one per Workspace, created on first use. */
export class BoardChangeFeed {
  readonly #feeds = new Map<string, WorkspaceFeed>();
  readonly #options: BoardChangeFeedOptions;
  readonly #retention: number;
  #untapped = 0;

  constructor(options: BoardChangeFeedOptions = {}) {
    this.#options = options;
    this.#retention = options.retention ?? BOARD_FEED_RETENTION;
  }

  #feed(workspaceId: string): WorkspaceFeed {
    let feed = this.#feeds.get(workspaceId);
    if (feed === undefined) {
      feed = new WorkspaceFeed(this.#options.epochOf?.(workspaceId) ?? 0);
      this.#feeds.set(workspaceId, feed);
    }
    return feed;
  }

  /** The Workspace's current cursor: what a snapshot read in the same turn reflects. */
  cursor(workspaceId: string): string {
    const feed = this.#feed(workspaceId);
    return `${feed.epoch}:${feed.instance}:${feed.seq}`;
  }

  /**
   * Stamps one committed write's changes, all of one Workspace, and delivers
   * them to its subscribers at once. Call it in the synchronous turn of the
   * write's COMMIT, after it.
   */
  stamp(workspaceId: string, changes: readonly BoardChange[]): void {
    if (changes.length === 0) return;
    const feed = this.#feed(workspaceId);
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
    const batch: BoardFeedBatch = {
      cursor: this.cursor(workspaceId),
      changes,
    };
    for (const listener of [...feed.listeners]) listener(batch);
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
      const every = this.#options.workspaces?.() ?? [...this.#feeds.keys()];
      for (const workspaceId of every) {
        this.stamp(workspaceId, [
          { kind: "project", op: "upsert", id: workspaceId, projectId: workspaceId },
        ]);
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
   * Follows one Workspace's feed. With `after`, first delivers (as one batch)
   * the latest change of every entity stamped after that cursor, then live;
   * without one, live only (a Client that read a snapshot in this turn).
   * Throws {@link FeedResnapshotRequiredError} for a cursor this feed cannot
   * resume: another epoch or instance, compacted past, or never minted.
   * Returns the unsubscribe.
   */
  subscribe(workspaceId: string, after: string | null, listener: BoardFeedListener): () => void {
    const feed = this.#feed(workspaceId);
    if (after !== null) {
      const seq = this.#resumable(feed, after);
      const replay = [...feed.latest.values()]
        .filter((stamped) => stamped.seq > seq)
        .map((stamped) => stamped.change);
      if (replay.length > 0) listener({ cursor: this.cursor(workspaceId), changes: replay });
    }
    feed.listeners.add(listener);
    return () => {
      feed.listeners.delete(listener);
    };
  }

  #resumable(feed: WorkspaceFeed, cursor: string): number {
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

/** One host's board feeds. A composition root makes one and hands it to its handlers and its bus. */
export function createBoardChangeFeed(options: BoardChangeFeedOptions = {}): BoardChangeFeed {
  return new BoardChangeFeed(options);
}
