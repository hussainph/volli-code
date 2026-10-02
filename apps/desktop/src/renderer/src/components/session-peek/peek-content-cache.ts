/**
 * One renderer-local cache for Session cards and folder lines. Local folds and
 * utility refinements have separate promises, shared by Session/activity so a
 * reopened card joins work already bought instead of asking main twice.
 * Expiry is checked only when a new glance acquires a read; never by a timer.
 */
import { SESSION_PEEK_REFRESH_MS, type SessionPeekContent } from "@volli/shared";

export type ReadPeekContent = (
  sessionId: string,
  refine?: boolean,
) => Promise<SessionPeekContent | null>;

export class PeekContentRead {
  content: SessionPeekContent | null | undefined;
  failed = false;
  readAt = Date.now();
  refinement: Promise<void> | undefined;
  private local: Promise<void> | undefined;
  private pending = 0;

  constructor(
    private readonly sessionId: string,
    private readonly read: ReadPeekContent,
  ) {}

  get reusable(): boolean {
    return this.pending > 0 || (!this.failed && Date.now() - this.readAt < SESSION_PEEK_REFRESH_MS);
  }

  pull(refine: boolean): Promise<void> {
    const previous = refine ? this.refinement : this.local;
    if (previous !== undefined) return previous;
    this.pending++;
    const promise = Promise.resolve()
      .then(() => this.read(this.sessionId, refine))
      .then(
        (content) => {
          // A refused/empty refinement keeps the readable fold. Older replies
          // cannot replace a newer fold; an unrefined reply cannot erase prose.
          if (
            this.content === undefined ||
            (content !== null &&
              (this.content === null || content.lastActivityAt >= this.content.lastActivityAt))
          ) {
            this.content =
              content !== null &&
              this.content != null &&
              content.lastActivityAt === this.content.lastActivityAt &&
              content.summary == null &&
              this.content.summary != null
                ? { ...content, summary: this.content.summary }
                : content;
          }
          this.failed = false;
        },
        (error: unknown) => {
          if (this.content === undefined) this.failed = true;
          throw error;
        },
      )
      .finally(() => {
        this.pending--;
        this.readAt = Date.now();
      });
    if (refine) this.refinement = promise;
    else this.local = promise;
    return promise;
  }
}

export class PeekContentCache {
  private readonly reads = new Map<string, PeekContentRead>();

  constructor(private readonly read: ReadPeekContent) {}

  get(sessionId: string, activityToken: number): PeekContentRead {
    const key = JSON.stringify([sessionId, activityToken]);
    const previous = this.reads.get(key);
    if (previous?.reusable) return previous;
    const entry = new PeekContentRead(sessionId, this.read);
    this.reads.set(key, entry);
    return entry;
  }
}

/**
 * Publish the local fold first. Only a still-live, unpinned glance may start
 * utility work. A pin may observe refinement already in flight but buys none.
 * Disposing while the local fold is pending prevents the second stage entirely.
 */
export function observePeekContent(
  entry: PeekContentRead,
  refine: boolean,
  publish: (entry: PeekContentRead) => void,
): () => void {
  let live = true;
  const update = () => {
    if (live) publish(entry);
  };
  void entry.pull(false).then(() => {
    if (!live) return;
    update();
    const refinement = refine && entry.content != null ? entry.pull(true) : entry.refinement;
    if (refinement !== undefined) void refinement.then(update, update);
  }, update);
  update();
  return () => {
    live = false;
  };
}
