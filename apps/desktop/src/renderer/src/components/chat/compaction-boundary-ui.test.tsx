/**
 * The two dresses, rendered — the only place the difference between them is
 * visible at all.
 *
 * A compaction that happened divides the conversation and wears a rule; one
 * that failed divides nothing and must not draw one, because a seam that is not
 * there is the one thing this row can say that would be untrue. The count is
 * pinned here for the same reason: the measured half is on the row and the
 * estimated half is nowhere, and a later hand reaching for `tokensAfter` should
 * have to delete a test to draw it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { TranscriptCompaction } from "@renderer/chat/transcript";

import { CompactionBoundary } from "./compaction-boundary-ui";

const compacted: TranscriptCompaction = {
  sequence: 12,
  reason: "threshold",
  afterMessageId: "m2",
  outcome: "compacted",
  tokensBefore: 182_000,
};

const failed: TranscriptCompaction = {
  sequence: 13,
  reason: "overflow",
  afterMessageId: "m3",
  outcome: "failed",
  detail: "The summarizer refused the request.",
};

function markup(compaction: TranscriptCompaction): string {
  return renderToStaticMarkup(<CompactionBoundary compaction={compaction} />);
}

describe("a compaction that happened", () => {
  const html = markup(compacted);

  it("draws the rule that makes it a boundary", () => {
    expect(html).toContain('data-slot="separator"');
  });

  it("says what happened, why, and what the reader is now looking at", () => {
    expect(html).toContain("Context compacted");
    expect(html).toContain("the window filled");
    expect(html).toContain("Older messages above are no longer sent to the model");
  });

  it("carries the measured count and no estimate of what replaced it", () => {
    expect(html).toContain("182k before");
    // The hedge the context meter puts on every estimated count. Nothing on
    // this row is one, so nothing here wears it.
    expect(html).not.toContain("~");
  });
});

describe("a compaction that failed", () => {
  const html = markup(failed);

  it("draws no rule, because nothing was divided", () => {
    expect(html).not.toContain('data-slot="separator"');
  });

  it("says that the context is exactly as it was, in the executor's own words", () => {
    expect(html).toContain("Compaction failed");
    expect(html).toContain("the provider refused this turn");
    expect(html).toContain("The context was left as it was.");
    expect(html).toContain("The summarizer refused the request.");
  });

  it("borrows no count from the compaction that did not happen", () => {
    expect(html).not.toContain("before</span>");
  });
});
