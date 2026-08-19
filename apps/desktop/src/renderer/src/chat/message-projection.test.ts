import type { KeyedTranscriptMessage, TranscriptOverlay } from "@volli/session-engine";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { layerTranscriptOverlay, projectTranscriptMessages } from "./message-projection";

function frame(sequence: number, message: UIMessage) {
  return { sequence, transcript: { message } };
}

function durable(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function inFlight(id: string, ...parts: KeyedTranscriptMessage["parts"]): KeyedTranscriptMessage {
  return { id, role: "assistant", parts };
}

function overlay(...messages: readonly KeyedTranscriptMessage[]): TranscriptOverlay {
  return new Map(messages.map((message) => [message.id, message]));
}

describe("projectTranscriptMessages", () => {
  it("replaces streamed snapshots without duplicating their message bubble", () => {
    expect(
      projectTranscriptMessages([
        frame(2, { id: "user-1", role: "user", parts: [{ type: "text", text: "Investigate." }] }),
        frame(4, {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "I found" }],
        }),
        frame(5, {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "I found the cause." }],
        }),
        frame(7, {
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "I can fix it." }],
        }),
      ]),
    ).toEqual([
      { id: "user-1", role: "user", parts: [{ type: "text", text: "Investigate." }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I found the cause." }],
      },
      { id: "assistant-2", role: "assistant", parts: [{ type: "text", text: "I can fix it." }] },
    ]);
  });

  it("keeps an answer's durable receipt at the point it was given", () => {
    expect(
      projectTranscriptMessages([
        frame(2, { id: "user-1", role: "user", parts: [{ type: "text", text: "Investigate." }] }),
        // What the Session commits when a person answers a permission. Not a
        // thing anyone said, so the transcript draws it as a one-line receipt
        // rather than as an empty user bubble — but it keeps its position,
        // because where a decision was taken is half of what it records.
        frame(3, {
          id: "command-1",
          role: "user",
          metadata: { kind: "interaction-resolution", interactionId: "permission:per_1" },
          parts: [{ type: "data-interaction-resolution", data: { optionIds: ["once"] } }],
        } as UIMessage),
        frame(4, {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Done." }],
        }),
      ]).map(({ id }) => id),
    ).toEqual(["user-1", "command-1", "assistant-1"]);
  });

  it("keeps an assistant turn that only ran tools", () => {
    expect(
      projectTranscriptMessages([
        frame(2, {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "dynamic-tool", toolName: "read", toolCallId: "call-1" }],
        } as UIMessage),
      ]).map(({ id }) => id),
    ).toEqual(["assistant-1"]);
  });

  it("keeps a user turn that is nothing but an attachment (VC-50)", () => {
    // A dropped screenshot sent without words: the text part is empty, the
    // file part is the message. It must survive projection — the transcript
    // draws its thumb where prose would have been.
    expect(
      projectTranscriptMessages([
        frame(1, {
          id: "user-1",
          role: "user",
          parts: [{ type: "file", url: `volli-blob:${"a".repeat(64)}`, mediaType: "image/png" }],
        }),
      ]).map(({ id }) => id),
    ).toEqual(["user-1"]);
  });

  it("skips a durable frame that carries no transcript message at all", () => {
    // Not every durable frame is a message — a tool-only or interaction event
    // shares the same log without ever setting `transcript`.
    expect(
      projectTranscriptMessages([
        { transcript: null },
        frame(2, {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Done." }],
        }),
      ]).map(({ id }) => id),
    ).toEqual(["assistant-1"]);
  });
});

describe("layerTranscriptOverlay", () => {
  it("hands back the durable list untouched when nothing is in flight", () => {
    const settled = [durable("assistant-1", "I found the cause.")];

    // Identity: the overwhelmingly common case must not hand the plane a new
    // list to re-group and re-segment.
    expect(layerTranscriptOverlay(settled, new Map())).toBe(settled);
  });

  it("rewrites a durable message in place and drops the keys", () => {
    const layered = layerTranscriptOverlay(
      [durable("user-1", "Investigate."), durable("assistant-1", "I found")],
      overlay(
        inFlight("assistant-1", { key: "prt_1", part: { type: "text", text: "I found the" } }),
      ),
    );

    expect(layered).toEqual([
      durable("user-1", "Investigate."),
      durable("assistant-1", "I found the"),
    ]);
  });

  it("renders a message that has never settled after every one that has", () => {
    const layered = layerTranscriptOverlay(
      [durable("assistant-1", "On it.")],
      overlay(
        inFlight("assistant-2", { key: "prt_1", part: { type: "text", text: "second" } }),
        inFlight("assistant-3", { key: "prt_2", part: { type: "text", text: "third" } }),
      ),
    );

    // In the overlay's own order, which is the order it first heard of them.
    expect(layered.map(({ id }) => id)).toEqual(["assistant-1", "assistant-2", "assistant-3"]);
  });

  it("keeps a baseline with nothing drawable out of the transcript", () => {
    // An emitter leads a message with a reset that can carry no parts yet.
    // Drawing it opens an empty bubble in front of the first word — the same
    // reason `projectTranscriptMessages` filters a durable message that says
    // nothing.
    expect(layerTranscriptOverlay([], overlay(inFlight("assistant-1")))).toEqual([]);
  });

  it("holds the durable message when the overlay over it has nothing to draw", () => {
    const settled = [durable("assistant-1", "I found the cause.")];

    // The same rule, read the other way: the overlay is what renders while it
    // has something to render, and the durable latest is the fallback — so a
    // partial baseline cannot blank a row that already said something.
    expect(layerTranscriptOverlay(settled, overlay(inFlight("assistant-1")))).toEqual(settled);
  });
});
