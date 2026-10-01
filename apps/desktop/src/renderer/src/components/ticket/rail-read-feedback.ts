/**
 * What a rail block says about its own read, and WHERE it says it (VC-406).
 *
 * THE DEFECT THIS REPLACES. Every list in the rail answered three questions —
 * is a read in flight, did the last one fail, is there anything on screen — with
 * its own chain of ternaries, and two of them got the combination wrong: a
 * first-read failure could draw the failure line AND the "nothing here yet"
 * sentence, so a refused read claimed to have proved the folder empty. The
 * combination is the decision, so the combination is what gets named once and
 * tested once.
 *
 * TWO PLACES, AND THE CHOICE BETWEEN THEM IS THE WHOLE POINT.
 *
 *  - **The body** speaks when there is nothing else in it. A read that has
 *    never landed has no rows to caveat, so the feedback IS the content: the
 *    full sentence, and — when it failed — the retry beside it. An empty body
 *    and a refused read must never read the same.
 *  - **The heading** speaks when rows are already on screen. Those rows were
 *    true as of the last read and stay drawn; what a refresh can add is a
 *    caveat, and a caveat belongs on the row the block already owns rather than
 *    in a reserved strip that is blank at rest. The earlier revision of this
 *    design reserved a fixed-height status row under every heading; at rest it
 *    was 24px of nothing under every block on the page.
 *
 * AT REST IT IS `null`, and that is the ordinary case: a block that has read
 * successfully and is not reading now says nothing at all about its read.
 *
 * Pure and clock-free so both rails, four pages and the worktree fold reach one
 * answer — and so the combinations a person can only reach by unplugging their
 * network are the cheap half of a unit test.
 */

/** What a caller knows about its own read, in the three bits that decide the rest. */
export interface RailReadState {
  /**
   * Whether the block currently holds the result of a COMPLETED read — rows, or
   * a read that legitimately returned none.
   *
   * Not "whether the row array is non-empty": that is the conflation this
   * module exists to remove. A successful read of an empty folder has data; a
   * refused first read does not, however empty its array looks.
   */
  hasData: boolean;
  /** Whether a read is in flight right now. */
  pending: boolean;
  /** Whether the most recent completed attempt failed. */
  failed: boolean;
}

/**
 * Where the feedback goes and what it says.
 *
 * `face` is the short form a surface may draw where it has the width; `detail`
 * is the whole sentence, which always reaches the reader through the accessible
 * name and the hover title even when the face is a bare mark.
 */
export type RailReadFeedback =
  | {
      place: "heading";
      kind: "refreshing" | "refresh-failed";
      face: string;
      detail: string;
    }
  | {
      place: "body";
      kind: "reading" | "failed";
      face: string;
      detail: string;
    }
  | null;

/**
 * The feedback `state` earns, for a block whose content is called `noun`.
 *
 * Read the branches in order; the order IS the priority the audit asked for.
 * Nothing-on-screen outranks everything, because a reader with no rows cannot
 * act on a caveat about rows. Within that, a fault outranks a pending read: a
 * retry that has not landed yet must not erase the reason the reader is looking
 * at a spinner. With rows on screen the same pair holds, one register quieter.
 */
export function railReadFeedback(state: RailReadState, noun: string): RailReadFeedback {
  if (!state.hasData) {
    if (state.failed) {
      const sentence = `${noun} failed to read`;
      return { place: "body", kind: "failed", face: sentence, detail: sentence };
    }
    if (state.pending)
      return { place: "body", kind: "reading", face: "Reading…", detail: "Reading…" };
    return null;
  }
  if (state.failed) {
    return {
      place: "heading",
      kind: "refresh-failed",
      face: "Refresh failed",
      detail: "Refresh failed · last read shown",
    };
  }
  if (state.pending) {
    return {
      place: "heading",
      kind: "refreshing",
      face: "Refreshing…",
      detail: "Refreshing · last read shown",
    };
  }
  return null;
}

/**
 * Whether the block may draw its successful-empty sentence.
 *
 * Gated on the read having LANDED, which is the high-priority finding the audit
 * recorded against two production panels: "no matches" and "this folder is
 * empty" are claims about what a read returned, and a block that has not
 * completed one is not entitled to make them.
 */
export function railReadCanClaimEmpty(state: RailReadState): boolean {
  return state.hasData && !state.failed;
}
