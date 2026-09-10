/**
 * How much of a transcript is in the DOM (VC-338).
 *
 * A Session that has burned thirty million tokens has thousands of turns, and
 * `rows.map(...)` put every one of them in the document: markdown parsed,
 * syntax highlighted, one `<span>` per token. Sixteen of those planes is how a
 * renderer reaches two gigabytes. Nothing about the *transcript* needs that —
 * a reader can see about a dozen rows — so the plane mounts a tail and the
 * reader asks for the rest.
 *
 * The reader's ask is carried as a ROW KEY by the caller, not as a count, and
 * this module works in the indices that key resolves to. That is the whole
 * reason it exists rather than a `slice(-60)` at the call site: a live Session
 * appends rows while the reader is reading, so a count measured from the end
 * walks backwards through the conversation under them and drops the row they
 * were looking at out of the top of the window. An anchored index is what makes
 * "show me from here" keep meaning the same thing however much arrives after it.
 *
 * Pure, and tested to the branch: this decides what is on screen at all, and a
 * wrong answer is a transcript that silently ends early.
 */

/**
 * Rows mounted at rest.
 *
 * Deliberately several screens' worth rather than one viewport's: the tail is
 * what a reader scrolls back THROUGH on the way to asking for more, and a
 * window that ends one row above the fold turns every ordinary "what did it
 * just do" scroll into a paging interaction. At 60 rows a long Session's plane
 * mounts in a bounded document (the measurement in the PR), and the common
 * reading gesture — back a screen or two — never reaches the affordance.
 */
export const TRANSCRIPT_TAIL_ROWS = 60;

/** Rows one "Show earlier" reveals. A page, not the whole history. */
export const TRANSCRIPT_PAGE_ROWS = 40;

/** Which rows the transcript mounts, and what is still above them. */
export interface TranscriptWindow {
  /** First mounted row. The window runs from here to the end of the rows. */
  readonly start: number;
  /** How many rows sit above the window, unmounted. Zero means all of it. */
  readonly earlier: number;
  /**
   * Where the window would start after one "Show earlier", or `-1` when there
   * is nothing above. Resolved here rather than at the press so the affordance
   * stays honest while rows arrive: the press anchors on the page above the row
   * that was actually drawn at the top edge.
   */
  readonly earlierStart: number;
}

/**
 * The window over `rowCount` rows, given the index the reader asked to see from.
 *
 * `anchor` is `-1` for "no ask, just the tail" — which is also what the caller
 * passes when a revealed anchor has left the conversation. A compaction can
 * retire rows the reader had revealed, and the alternative to falling back to
 * the tail is a transcript anchored on a row that no longer exists.
 *
 * An anchor BELOW the tail start is clamped to the tail: revealing a page near
 * the end must never mount fewer rows than the plane shows at rest.
 */
export function transcriptWindow(
  rowCount: number,
  anchor: number,
  tail: number = TRANSCRIPT_TAIL_ROWS,
  page: number = TRANSCRIPT_PAGE_ROWS,
): TranscriptWindow {
  const tailStart = Math.max(0, rowCount - tail);
  const start = anchor < 0 ? tailStart : Math.min(anchor, tailStart);
  if (start <= 0) return { start: 0, earlier: 0, earlierStart: -1 };
  return { start, earlier: start, earlierStart: Math.max(0, start - page) };
}

/* ------------------------------------------------------------- the remount */

/**
 * Where a transcript was left, so a tab round-trip comes back to it.
 *
 * A chat plane is unmounted whenever its tab goes behind another (VC-338 makes
 * that true of a hidden surface too), and everything a Session IS survives that
 * in the resident client and the draft store. The READING POSITION is the one
 * thing that was nobody's: a reader twelve hundred rows up who glanced at
 * another tab came back to the bottom of the conversation. It lives here rather
 * than in the draft store because it is not part of the Session — a relaunch is
 * allowed to forget it, a tab switch is not.
 */
export interface TranscriptView {
  /** The earliest row the reader asked to see, as its row key, or the tail. */
  readonly anchorKey: string | null;
  /**
   * Scroll offset to come back to, or `null` while the reader was pinned to the
   * bottom — which is not an offset: the conversation has grown since, and the
   * bottom is wherever it is now.
   */
  readonly offset: number | null;
}

/**
 * Bounded for the reason `chat-drafts.ts` bounds its own map: nothing tells this
 * module a Session was deleted, so an unbounded one keeps a row per Session the
 * app has ever shown. Oldest write out first, and the cap is generous enough
 * that it can only ever evict a tab the reader left long ago.
 */
const VIEW_LIMIT = 50;
const views = new Map<string, TranscriptView>();

/** Where `sessionId`'s transcript was last left, or `null` if never recorded. */
export function readTranscriptView(sessionId: string): TranscriptView | null {
  return views.get(sessionId) ?? null;
}

/** Record where `sessionId`'s transcript stands now. */
export function rememberTranscriptView(sessionId: string, view: TranscriptView): void {
  // Delete before set so a re-write moves the entry to the end of the insertion
  // order; otherwise the cap would evict the tab being read.
  views.delete(sessionId);
  views.set(sessionId, view);
  if (views.size <= VIEW_LIMIT) return;
  const oldest = views.keys().next();
  if (oldest.done !== true) views.delete(oldest.value);
}

/** Forget every recorded position — for tests, which share one module instance. */
export function forgetTranscriptViews(): void {
  views.clear();
}
