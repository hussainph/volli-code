import { describe, expect, it } from "vite-plus/test";
import {
  applyTranscriptDelta,
  projectKeyedTranscriptMessage,
  type KeyedTranscriptMessage,
  type TranscriptOverlay,
} from "./transcript-overlay";

const MESSAGE_ID = "assistant-1";

function keyed(parts: KeyedTranscriptMessage["parts"], metadata?: unknown): KeyedTranscriptMessage {
  return {
    id: MESSAGE_ID,
    role: "assistant",
    parts,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function overlayWith(message: KeyedTranscriptMessage): TranscriptOverlay {
  return applyTranscriptDelta(new Map(), MESSAGE_ID, { op: "reset", message });
}

function messageIn(overlay: TranscriptOverlay): KeyedTranscriptMessage {
  const message = overlay.get(MESSAGE_ID);
  if (!message) throw new Error("Expected an overlay entry");
  return message;
}

describe("applyTranscriptDelta", () => {
  it("creates and replaces an entry from a reset, leaving the input untouched", () => {
    const empty: TranscriptOverlay = new Map();
    const created = overlayWith(keyed([{ key: "part-1", part: { type: "text", text: "Hel" } }]));
    const replaced = applyTranscriptDelta(created, MESSAGE_ID, {
      op: "reset",
      message: keyed([{ key: "part-2", part: { type: "text", text: "Done" } }]),
    });

    expect(empty.size).toBe(0);
    expect(messageIn(created).parts).toEqual([
      { key: "part-1", part: { type: "text", text: "Hel" } },
    ]);
    expect(messageIn(replaced).parts).toEqual([
      { key: "part-2", part: { type: "text", text: "Done" } },
    ]);
  });

  it("ignores every non-reset delta for a message it holds no entry for", () => {
    const empty: TranscriptOverlay = new Map();

    for (const delta of [
      { op: "part.append", key: "part-1", text: "lo" },
      { op: "part.upsert", key: "part-1", index: 0, part: { type: "text", text: "Hi" } },
      { op: "part.remove", key: "part-1" },
      { op: "metadata", metadata: { model: "sonnet" } },
      { op: "message.remove" },
    ] as const) {
      expect(applyTranscriptDelta(empty, MESSAGE_ID, delta)).toBe(empty);
    }
  });

  it("appends onto text and reasoning parts by key", () => {
    const overlay = overlayWith(
      keyed([
        { key: "reason-1", part: { type: "reasoning", text: "Think", state: "streaming" } },
        { key: "text-1", part: { type: "text", text: "Hel" } },
      ]),
    );

    const grown = applyTranscriptDelta(
      applyTranscriptDelta(overlay, MESSAGE_ID, { op: "part.append", key: "text-1", text: "lo" }),
      MESSAGE_ID,
      { op: "part.append", key: "reason-1", text: "ing" },
    );

    expect(messageIn(grown).parts).toEqual([
      { key: "reason-1", part: { type: "reasoning", text: "Thinking", state: "streaming" } },
      { key: "text-1", part: { type: "text", text: "Hello" } },
    ]);
    // The fold is pure: the overlay it was handed still holds the old text.
    expect(messageIn(overlay).parts[1]).toEqual({
      key: "text-1",
      part: { type: "text", text: "Hel" },
    });
  });

  it("leaves the entry intact when an append names a missing or text-free part", () => {
    const overlay = overlayWith(
      keyed([
        {
          key: "tool-1",
          part: {
            type: "dynamic-tool",
            toolName: "read",
            toolCallId: "call-1",
            state: "input-streaming",
          },
        },
      ]),
    );

    expect(
      applyTranscriptDelta(overlay, MESSAGE_ID, { op: "part.append", key: "absent", text: "x" }),
    ).toBe(overlay);
    expect(
      applyTranscriptDelta(overlay, MESSAGE_ID, { op: "part.append", key: "tool-1", text: "x" }),
    ).toBe(overlay);
  });

  it("inserts, replaces, and moves an upserted part at its projected index", () => {
    const overlay = overlayWith(
      keyed([
        { key: "text-1", part: { type: "text", text: "One" } },
        { key: "text-2", part: { type: "text", text: "Two" } },
      ]),
    );

    const inserted = applyTranscriptDelta(overlay, MESSAGE_ID, {
      op: "part.upsert",
      key: "text-3",
      index: 1,
      part: { type: "text", text: "Middle" },
    });
    const moved = applyTranscriptDelta(inserted, MESSAGE_ID, {
      op: "part.upsert",
      key: "text-1",
      index: 2,
      part: { type: "text", text: "One again" },
    });

    expect(messageIn(inserted).parts.map(({ key }) => key)).toEqual(["text-1", "text-3", "text-2"]);
    expect(messageIn(moved).parts).toEqual([
      { key: "text-3", part: { type: "text", text: "Middle" } },
      { key: "text-2", part: { type: "text", text: "Two" } },
      { key: "text-1", part: { type: "text", text: "One again" } },
    ]);
  });

  it("clamps an out-of-range upsert index to the ends of the projected array", () => {
    const overlay = overlayWith(keyed([{ key: "text-1", part: { type: "text", text: "One" } }]));

    const low = applyTranscriptDelta(overlay, MESSAGE_ID, {
      op: "part.upsert",
      key: "text-0",
      index: -3,
      part: { type: "text", text: "First" },
    });
    const high = applyTranscriptDelta(overlay, MESSAGE_ID, {
      op: "part.upsert",
      key: "text-9",
      index: 40,
      part: { type: "text", text: "Last" },
    });

    expect(messageIn(low).parts.map(({ key }) => key)).toEqual(["text-0", "text-1"]);
    expect(messageIn(high).parts.map(({ key }) => key)).toEqual(["text-1", "text-9"]);
  });

  it("removes a part by key and answers an unknown key with the overlay it was given", () => {
    const overlay = overlayWith(
      keyed([
        { key: "text-1", part: { type: "text", text: "One" } },
        { key: "text-2", part: { type: "text", text: "Two" } },
      ]),
    );

    const removed = applyTranscriptDelta(overlay, MESSAGE_ID, { op: "part.remove", key: "text-1" });

    expect(messageIn(removed).parts.map(({ key }) => key)).toEqual(["text-2"]);
    expect(applyTranscriptDelta(overlay, MESSAGE_ID, { op: "part.remove", key: "absent" })).toBe(
      overlay,
    );
  });

  it("replaces message metadata and drops the whole entry on message.remove", () => {
    const overlay = overlayWith(
      keyed([{ key: "text-1", part: { type: "text", text: "One" } }], { model: "sonnet" }),
    );

    const stamped = applyTranscriptDelta(overlay, MESSAGE_ID, {
      op: "metadata",
      metadata: { model: "opus" },
    });
    const dropped = applyTranscriptDelta(stamped, MESSAGE_ID, { op: "message.remove" });

    expect(messageIn(stamped).metadata).toEqual({ model: "opus" });
    expect(messageIn(stamped).parts).toEqual(messageIn(overlay).parts);
    expect(dropped.has(MESSAGE_ID)).toBe(false);
    expect(messageIn(stamped).metadata).toEqual({ model: "opus" });
  });

  it("keeps entries for other messages out of every op's way", () => {
    const first = applyTranscriptDelta(new Map(), "assistant-1", {
      op: "reset",
      message: { id: "assistant-1", role: "assistant", parts: [] },
    });
    const both = applyTranscriptDelta(first, "assistant-2", {
      op: "reset",
      message: { id: "assistant-2", role: "assistant", parts: [] },
    });
    const dropped = applyTranscriptDelta(both, "assistant-1", { op: "message.remove" });

    expect([...both.keys()]).toEqual(["assistant-1", "assistant-2"]);
    expect([...dropped.keys()]).toEqual(["assistant-2"]);
  });
});

describe("projectKeyedTranscriptMessage", () => {
  it("strips the keys and keeps metadata only when the message carries some", () => {
    const parts: KeyedTranscriptMessage["parts"] = [
      { key: "text-1", part: { type: "text", text: "Hello" } },
      { key: "reason-1", part: { type: "reasoning", text: "Thinking", state: "done" } },
    ];

    expect(projectKeyedTranscriptMessage(keyed(parts))).toEqual({
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        { type: "text", text: "Hello" },
        { type: "reasoning", text: "Thinking", state: "done" },
      ],
    });
    expect(projectKeyedTranscriptMessage(keyed(parts, { model: "opus" }))).toMatchObject({
      metadata: { model: "opus" },
    });
    expect("metadata" in projectKeyedTranscriptMessage(keyed(parts))).toBe(false);
  });
});
