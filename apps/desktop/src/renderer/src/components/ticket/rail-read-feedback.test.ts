/**
 * The rail's read grammar (VC-406).
 *
 * The combinations are the decision, so the combinations are what is tested —
 * and they are the cheap half of this, because a person can only reach most of
 * them by unplugging their network. The one the audit recorded against two
 * production panels is the first case below: a refused first read must never be
 * drawable as a proven-empty folder.
 */
import { describe, expect, it } from "vite-plus/test";

import { railReadCanClaimEmpty, railReadFeedback, type RailReadState } from "./rail-read-feedback";

function state(over: Partial<RailReadState> = {}): RailReadState {
  return { hasData: false, pending: false, failed: false, ...over };
}

describe("railReadFeedback", () => {
  it("says nothing at all at rest", () => {
    expect(railReadFeedback(state({ hasData: true }), "Sessions")).toBeNull();
    // Never read, never asked, never failed: an unmounted block has no news.
    expect(railReadFeedback(state(), "Sessions")).toBeNull();
  });

  it("puts a first read in the BODY, because there is nothing else in it", () => {
    expect(railReadFeedback(state({ pending: true }), "Sessions")).toEqual({
      place: "body",
      kind: "reading",
      face: "Reading…",
      detail: "Reading…",
    });
  });

  it("puts a refused first read in the body, and lets it outrank the retry in flight", () => {
    const refused = railReadFeedback(state({ failed: true }), "Sessions");
    expect(refused).toEqual({
      place: "body",
      kind: "failed",
      face: "Sessions failed to read",
      detail: "Sessions failed to read",
    });
    // A retry that has not landed must not erase the reason the reader is
    // looking at a spinner.
    expect(railReadFeedback(state({ failed: true, pending: true }), "Sessions")).toEqual(refused);
  });

  it("puts a refresh on the HEADING, where the rows below it stay drawn", () => {
    expect(railReadFeedback(state({ hasData: true, pending: true }), "Sessions")).toEqual({
      place: "heading",
      kind: "refreshing",
      face: "Refreshing…",
      detail: "Refreshing · last read shown",
    });
    expect(railReadFeedback(state({ hasData: true, failed: true }), "Sessions")).toEqual({
      place: "heading",
      kind: "refresh-failed",
      face: "Refresh failed",
      detail: "Refresh failed · last read shown",
    });
  });

  it("keeps the fault above the pending read with rows on screen too", () => {
    const both = railReadFeedback(state({ hasData: true, failed: true, pending: true }), "Folder");
    expect(both?.kind).toBe("refresh-failed");
  });

  it("names the block's own content", () => {
    expect(railReadFeedback(state({ failed: true }), "Folder")?.face).toBe("Folder failed to read");
    expect(railReadFeedback(state({ failed: true }), "Changes")?.face).toBe(
      "Changes failed to read",
    );
  });
});

describe("railReadCanClaimEmpty", () => {
  it("lets only a landed read say there is nothing here", () => {
    expect(railReadCanClaimEmpty(state({ hasData: true }))).toBe(true);
    expect(railReadCanClaimEmpty(state())).toBe(false);
    expect(railReadCanClaimEmpty(state({ pending: true }))).toBe(false);
    expect(railReadCanClaimEmpty(state({ failed: true }))).toBe(false);
  });

  it("refuses the claim while last-good rows are stale", () => {
    // Rows on screen AND a failed refresh: the list is not empty, and it is
    // also not current — "no matches" here would be a claim about a read that
    // did not happen.
    expect(railReadCanClaimEmpty(state({ hasData: true, failed: true }))).toBe(false);
  });
});
