/**
 * The boundary's two jobs, tested apart: where it lands, and what it says.
 *
 * The placement half is about totality — the fold can hand this an anchor no
 * turn claims, and a boundary that quietly disappears would be worse than one in
 * the wrong place. The wording half is here because the honesty rule this
 * surface was built around lives entirely in a string: the measured count is
 * drawn and the estimated one is not, and nothing but a test can hold that.
 */
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { compactionBoundaryCopy, weaveCompactionBoundaries } from "./compaction-boundary";
import type { TranscriptCompaction } from "./transcript";

function message(id: string, role: UIMessage["role"] = "assistant"): UIMessage {
  return { id, role, parts: [{ type: "text", text: id }] };
}

function compacted(
  sequence: number,
  afterMessageId: string | null,
  overrides: Partial<Extract<TranscriptCompaction, { outcome: "compacted" }>> = {},
): TranscriptCompaction {
  return {
    sequence,
    reason: "threshold",
    afterMessageId,
    outcome: "compacted",
    tokensBefore: 182_000,
    ...overrides,
  };
}

function failed(
  sequence: number,
  afterMessageId: string | null,
  detail = "The summarizer refused the request.",
): TranscriptCompaction {
  return { sequence, reason: "overflow", afterMessageId, outcome: "failed", detail };
}

/** The rows as a readable shape: a turn is its ids, a boundary is its sequence. */
function shape(
  turns: readonly (readonly UIMessage[])[],
  compactions: readonly TranscriptCompaction[],
) {
  return weaveCompactionBoundaries(turns, compactions).map((row) =>
    row.kind === "turn"
      ? row.messages.map((held) => held.id).join("+")
      : `—${row.compaction.sequence}—`,
  );
}

describe("weaveCompactionBoundaries", () => {
  it("draws nothing extra for a Session that has never compacted", () => {
    const turns = [[message("m1")], [message("m2")]];

    const rows = weaveCompactionBoundaries(turns, []);

    expect(rows).toEqual([
      { kind: "turn", messages: turns[0] },
      { kind: "turn", messages: turns[1] },
    ]);
    // The very array it was handed, so the turn's own memo still holds.
    expect(rows[0]).toMatchObject({ messages: turns[0] });
  });

  it("lands a boundary after the turn its anchor belongs to", () => {
    expect(
      shape(
        [[message("u1", "user")], [message("m1"), message("m2")], [message("u2", "user")]],
        [compacted(9, "m1")],
      ),
    ).toEqual(["u1", "m1+m2", "—9—", "u2"]);
  });

  it("never splits a turn, even when the compaction happened inside one", () => {
    // The threshold path runs at the head of a message and the overflow path
    // after a refused reply, so an anchor mid-turn is ordinary. The rule goes
    // after the whole utterance rather than through it.
    expect(shape([[message("m1"), message("m2"), message("m3")]], [compacted(9, "m1")])).toEqual([
      "m1+m2+m3",
      "—9—",
    ]);
  });

  it("draws an unanchored compaction above everything", () => {
    expect(shape([[message("m1")]], [compacted(2, null)])).toEqual(["—2—", "m1"]);
  });

  it("keeps two boundaries on the same turn in the order they happened", () => {
    expect(
      shape([[message("m1")], [message("m2")]], [compacted(3, "m1"), failed(4, "m1")]),
    ).toEqual(["m1", "—3—", "—4—", "m2"]);
  });

  it("draws a boundary whose anchor no turn claims rather than losing it", () => {
    expect(shape([[message("m1")]], [compacted(9, "gone")])).toEqual(["m1", "—9—"]);
  });
});

describe("compactionBoundaryCopy", () => {
  it("names the reason in the reader's words, not the executor's", () => {
    expect(compactionBoundaryCopy(compacted(1, "m1")).reason).toBe("the window filled");
    expect(compactionBoundaryCopy(compacted(1, "m1", { reason: "overflow" })).reason).toBe(
      "the provider refused this turn",
    );
    expect(compactionBoundaryCopy(compacted(1, "m1", { reason: "manual" })).reason).toBe(
      "you asked",
    );
    expect(compactionBoundaryCopy(failed(1, "m1")).reason).toBe("the provider refused this turn");
  });

  it("draws the measured count and no estimate of what replaced it", () => {
    const copy = compactionBoundaryCopy(compacted(1, "m1"));

    expect(copy.headline).toBe("Context compacted");
    // The context meter's own formatter, so the two surfaces never spell the
    // same magnitude two ways.
    expect(copy.before).toBe("182k before");
    // The honesty rule, pinned: nothing on this row is an estimate, and the ~
    // that would mark one has nothing to mark.
    expect(copy.description).not.toContain("~");
    expect(copy.description).toBe(
      "Context compacted — the window filled. Older messages above are no longer sent to the model; a summary of them is. The context held 182k tokens before.",
    );
  });

  it("says what a reader scrolling past the line is actually looking at", () => {
    expect(compactionBoundaryCopy(compacted(1, "m1")).note).toBe(
      "Older messages above are no longer sent to the model; a summary of them is.",
    );
  });

  it("borrows no count for a compaction that never happened", () => {
    const copy = compactionBoundaryCopy(failed(1, "m1"));

    expect(copy.headline).toBe("Compaction failed");
    expect(copy.before).toBeNull();
    expect(copy.note).toBe("The context was left as it was.");
    expect(copy.detail).toBe("The summarizer refused the request.");
    expect(copy.description).toBe(
      "Compaction failed — the provider refused this turn. The context was left as it was. The summarizer refused the request.",
    );
  });

  it("reads a diagnostic with no words in it as no diagnostic at all", () => {
    const copy = compactionBoundaryCopy(failed(1, "m1", "   "));

    expect(copy.detail).toBeNull();
    expect(copy.description).toBe(
      "Compaction failed — the provider refused this turn. The context was left as it was.",
    );
  });
});
