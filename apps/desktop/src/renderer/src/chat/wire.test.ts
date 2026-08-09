/**
 * What crosses the Session RPC edge, read defensively.
 *
 * Every value here arrives as JSON — a stream emission or a mutation result —
 * so every check is written against a plain `unknown`, constructed the way it
 * would arrive off the wire rather than through the typed helpers on the other
 * side of it. This is the last place a malformed delta can still just be
 * dropped rather than drawn, or thrown from inside a React state updater.
 */
import type { TranscriptDelta } from "@volli/session-engine";
import { describe, expect, it } from "vite-plus/test";

import { chatSessionFrame, chatSessionOverlay, rejectedReceipt } from "./wire";

/** The baseline every message's first delta is, keyed on one provider part. */
function baseline(id: string, text: string): TranscriptDelta {
  return {
    op: "reset",
    message: { id, role: "assistant", parts: [{ key: "prt_1", part: { type: "text", text } }] },
  };
}

/**
 * One transient emission exactly as it arrives — JSON, unvalidated, off the
 * wire — so the decoder is handed shapes its own types would have refused.
 */
function wireOverlay(delta: unknown): Record<string, unknown> {
  return { kind: "overlay", sessionId: "session-1", throughSequence: 0, messageId: "m1", delta };
}

/** A `reset`'s message with its parts left untyped, which is the half under test. */
function keyedMessage(parts: readonly unknown[]): unknown {
  return { id: "m1", role: "assistant", parts };
}

/** One durable frame exactly as it arrives, with every field overridable. */
function wireFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: "session-1",
    sequence: 1,
    event: { payload: { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" } },
    transcript: null,
    ...overrides,
  };
}

describe("chatSessionFrame", () => {
  it("accepts a well-formed frame with no transcript", () => {
    expect(chatSessionFrame(wireFrame())).toEqual({
      sessionId: "session-1",
      sequence: 1,
      event: { payload: { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" } },
      transcript: null,
    });
  });

  it("accepts a well-formed frame carrying a settled transcript message", () => {
    const message = { id: "m1", role: "assistant", parts: [{ type: "text", text: "done" }] };

    expect(chatSessionFrame(wireFrame({ transcript: { message } }))?.transcript).toEqual({
      message,
    });
  });

  it("refuses a value that is not a record", () => {
    expect(chatSessionFrame(null)).toBeNull();
    expect(chatSessionFrame("frame")).toBeNull();
    expect(chatSessionFrame([])).toBeNull();
  });

  it("refuses a frame missing a string sessionId", () => {
    expect(chatSessionFrame(wireFrame({ sessionId: 1 }))).toBeNull();
  });

  it("refuses a frame missing a numeric sequence", () => {
    expect(chatSessionFrame(wireFrame({ sequence: "1" }))).toBeNull();
  });

  it("refuses a frame whose event is not a record", () => {
    expect(chatSessionFrame(wireFrame({ event: null }))).toBeNull();
  });

  it("refuses a frame whose event payload is not a record", () => {
    expect(chatSessionFrame(wireFrame({ event: { payload: "turn.started" } }))).toBeNull();
  });

  it("refuses a frame whose transcript is malformed", () => {
    expect(chatSessionFrame(wireFrame({ transcript: "nope" }))).toBeNull();
    expect(chatSessionFrame(wireFrame({ transcript: {} }))).toBeNull();
    expect(chatSessionFrame(wireFrame({ transcript: { message: "nope" } }))).toBeNull();
  });

  it("accepts every role a transcript message may carry", () => {
    for (const role of ["user", "assistant", "system"]) {
      const message = { id: "m1", role, parts: [] };
      expect(chatSessionFrame(wireFrame({ transcript: { message } }))).not.toBeNull();
    }
  });

  it("refuses a transcript message with an id that is not a string", () => {
    const message = { id: 1, role: "assistant", parts: [] };
    expect(chatSessionFrame(wireFrame({ transcript: { message } }))).toBeNull();
  });

  it("refuses a transcript message with a role none of the three known ones", () => {
    const message = { id: "m1", role: "tool", parts: [] };
    expect(chatSessionFrame(wireFrame({ transcript: { message } }))).toBeNull();
  });

  it("refuses a transcript message whose parts are not an array", () => {
    const message = { id: "m1", role: "assistant", parts: "text" };
    expect(chatSessionFrame(wireFrame({ transcript: { message } }))).toBeNull();
  });

  it("refuses a transcript message whose parts contain non-record entries", () => {
    for (const parts of [[null], ["text"], [[]]]) {
      const message = { id: "m1", role: "assistant", parts };
      expect(chatSessionFrame(wireFrame({ transcript: { message } }))).toBeNull();
    }
  });
});

describe("chatSessionOverlay", () => {
  it("accepts a well-formed baseline", () => {
    expect(chatSessionOverlay(wireOverlay(baseline("m1", "half a ")))?.delta).toEqual(
      baseline("m1", "half a "),
    );
  });

  it("refuses a value that is not a record", () => {
    expect(chatSessionOverlay(null)).toBeNull();
  });

  it("refuses an emission whose kind is not overlay", () => {
    expect(chatSessionOverlay({ ...wireOverlay(baseline("m1", "x")), kind: "frame" })).toBeNull();
  });

  it("refuses an emission missing a string sessionId", () => {
    expect(chatSessionOverlay({ ...wireOverlay(baseline("m1", "x")), sessionId: 1 })).toBeNull();
  });

  it("refuses an emission missing a numeric throughSequence", () => {
    expect(
      chatSessionOverlay({ ...wireOverlay(baseline("m1", "x")), throughSequence: "0" }),
    ).toBeNull();
  });

  it("refuses an emission missing a string messageId", () => {
    expect(chatSessionOverlay({ ...wireOverlay(baseline("m1", "x")), messageId: 1 })).toBeNull();
  });

  it("refuses a baseline whose parts are not keyed entries", () => {
    // Each of these survives `Array.isArray` and none survives the fold: a
    // `null` entry throws in `projectKeyedTranscriptMessage`, and one with no
    // `part` projects to `undefined`, which `speaks()` then reads `.type` off
    // inside a React state updater — taking the chat surface down rather than
    // losing one message. Dropped here instead.
    const malformed = [
      [null],
      [{}],
      [{ key: "prt_1" }],
      [{ part: { type: "text", text: "hi" } }],
      // A key that is not a string names no part the later ops could address.
      [{ key: 1, part: { type: "text", text: "hi" } }],
      // A part that is not a record has no `type` to render off.
      [{ key: "prt_1", part: "text" }],
    ];

    for (const parts of malformed) {
      expect(
        chatSessionOverlay(wireOverlay({ op: "reset", message: keyedMessage(parts) })),
      ).toBeNull();
    }
  });

  it("accepts a baseline that carries no parts at all", () => {
    // An emitter leads a message with a baseline before it has anything
    // drawable, so an empty array is well-formed rather than malformed —
    // `layerTranscriptOverlay` already declines to open a bubble for it.
    expect(
      chatSessionOverlay(wireOverlay({ op: "reset", message: keyedMessage([]) })),
    ).not.toBeNull();
  });

  it("refuses a reset whose message is not a record, or whose id or role are not known", () => {
    expect(chatSessionOverlay(wireOverlay({ op: "reset", message: "nope" }))).toBeNull();
    expect(
      chatSessionOverlay(
        wireOverlay({ op: "reset", message: { id: 1, role: "assistant", parts: [] } }),
      ),
    ).toBeNull();
    expect(
      chatSessionOverlay(wireOverlay({ op: "reset", message: { id: "m1", role: 1, parts: [] } })),
    ).toBeNull();
    expect(
      chatSessionOverlay(
        wireOverlay({ op: "reset", message: { id: "m1", role: "tool", parts: [] } }),
      ),
    ).toBeNull();
  });

  it("accepts a well-formed part.upsert and refuses a malformed one", () => {
    const upsert = {
      op: "part.upsert",
      key: "prt_1",
      index: 0,
      part: { type: "text", text: "hi" },
    };
    expect(chatSessionOverlay(wireOverlay(upsert))).not.toBeNull();
    expect(chatSessionOverlay(wireOverlay({ ...upsert, key: 1 }))).toBeNull();
    expect(chatSessionOverlay(wireOverlay({ ...upsert, index: "0" }))).toBeNull();
    expect(chatSessionOverlay(wireOverlay({ ...upsert, part: "text" }))).toBeNull();
  });

  it("accepts a well-formed part.append and refuses one with a bad key or missing text", () => {
    expect(
      chatSessionOverlay(wireOverlay({ op: "part.append", key: "prt_1", text: "more" })),
    ).not.toBeNull();
    expect(chatSessionOverlay(wireOverlay({ op: "part.append", key: 1, text: "more" }))).toBeNull();
    expect(chatSessionOverlay(wireOverlay({ op: "part.append", key: "prt_1" }))).toBeNull();
  });

  it("accepts a well-formed part.remove and refuses one missing its key", () => {
    expect(chatSessionOverlay(wireOverlay({ op: "part.remove", key: "prt_1" }))).not.toBeNull();
    expect(chatSessionOverlay(wireOverlay({ op: "part.remove" }))).toBeNull();
  });

  it("accepts metadata and message.remove, which carry nothing to validate", () => {
    expect(chatSessionOverlay(wireOverlay({ op: "metadata" }))).not.toBeNull();
    expect(chatSessionOverlay(wireOverlay({ op: "message.remove" }))).not.toBeNull();
  });

  it("refuses an emission whose delta is not a record, or whose delta op it does not know", () => {
    expect(chatSessionOverlay(wireOverlay(null))).toBeNull();
    expect(chatSessionOverlay(wireOverlay({ op: "part.rewrite", key: "prt_1" }))).toBeNull();
  });
});

describe("rejectedReceipt", () => {
  it("reads the detail off a rejected receipt", () => {
    expect(rejectedReceipt({ receipt: { status: "rejected", detail: "no such model" } })).toBe(
      "no such model",
    );
  });

  it("falls back to the code when a rejected receipt carries no detail", () => {
    expect(rejectedReceipt({ receipt: { status: "rejected", code: "adapter_unavailable" } })).toBe(
      "adapter_unavailable",
    );
  });

  it("falls back to a bare word when a rejected receipt carries neither", () => {
    expect(rejectedReceipt({ receipt: { status: "rejected" } })).toBe("rejected");
    expect(rejectedReceipt({ receipt: { status: "rejected", detail: "" } })).toBe("rejected");
    expect(rejectedReceipt({ receipt: { status: "rejected", code: 1 } })).toBe("rejected");
  });

  it("reads nothing refused when the receipt is not a rejection", () => {
    expect(rejectedReceipt({ receipt: { status: "accepted" } })).toBeNull();
  });

  it("reads nothing refused when the result carries no receipt at all", () => {
    expect(rejectedReceipt(null)).toBeNull();
    expect(rejectedReceipt({})).toBeNull();
    expect(rejectedReceipt({ receipt: "accepted" })).toBeNull();
  });
});
