import type { WorkTranscriptRow } from "@volli/session-presentation";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  checkpointReply,
  currentCheckpoint,
  holdCheckpoints,
  isCheckpointRow,
  messageCheckpoints,
} from "./message-checkpoints";

function user(id: string, ...parts: UIMessage["parts"]): WorkTranscriptRow {
  return { kind: "turn", messages: [{ id, role: "user", parts }] };
}
function said(id: string, text: string): WorkTranscriptRow {
  return {
    kind: "turn",
    viewKey: `${id}:0`,
    messages: [{ id, role: "assistant", parts: [{ type: "text", text }] }],
  };
}
const text = (value: string) => ({ type: "text" as const, text: value });
const work: WorkTranscriptRow = {
  kind: "work",
  work: { key: "work-1", rows: [], startedAt: null, endedAt: null, state: "complete" },
};

describe("messageCheckpoints", () => {
  it("marks each message the person sent, in order, and nothing else", () => {
    const rows: WorkTranscriptRow[] = [
      user("a", text("First ask")),
      said("r1", "First answer"),
      work,
      { kind: "host-notice", messageId: "n", notice: { kind: "unknown" } as never },
      { kind: "compaction", compaction: { sequence: 3 } as never },
      user("b", text("Second ask")),
      said("r2", "Second answer"),
    ];
    expect(messageCheckpoints(rows)).toEqual([
      { id: "a", prompt: "First ask", label: "First ask" },
      { id: "b", prompt: "Second ask", label: "Second ask" },
    ]);
  });

  it("names an attachment-only message by its files and skips one with nothing to say", () => {
    const rows = [
      user(
        "files",
        text("  "),
        { type: "file", mediaType: "image/png", url: "blob:1", filename: "spec.png" },
        { type: "file", mediaType: "image/png", url: "blob:2", filename: "flow.png" },
      ),
      user("blank", text("\u200B ")),
      user("unnamed", { type: "file", mediaType: "image/png", url: "blob:3" }),
    ];
    expect(messageCheckpoints(rows).map(({ id, prompt }) => ({ id, prompt }))).toEqual([
      { id: "files", prompt: "spec.png, flow.png" },
    ]);
  });

  it("answers the same for a message it has already read", () => {
    const blank = user("blank", text(" "));
    const asked = user("asked", text("Ask"));
    expect([isCheckpointRow(blank), isCheckpointRow(asked)]).toEqual([false, true]);
    expect([isCheckpointRow(blank), isCheckpointRow(asked)]).toEqual([false, true]);
  });

  it("leaves out a recorded answer to the agent's question", () => {
    const answer = user("answer", text("Option A"), {
      type: "data-interaction-resolution",
      data: {},
    });
    expect(isCheckpointRow(answer)).toBe(false);
    expect(messageCheckpoints([answer])).toEqual([]);
  });

  it("bounds the prompt and the accessible name", () => {
    const long = "word ".repeat(400);
    const [checkpoint] = messageCheckpoints([user("long", text(long))]);
    // 280 characters kept for the card, 100 for the accessible name.
    expect(Array.from(checkpoint!.prompt)).toHaveLength(280);
    expect(Array.from(checkpoint!.label).length).toBeLessThanOrEqual(100);
    expect(checkpoint!.label.endsWith("…")).toBe(true);
  });
});

describe("holdCheckpoints", () => {
  it("hands back the previous list when nothing the rail draws changed", () => {
    const before = messageCheckpoints([user("a", text("One")), user("b", text("Two"))]);
    const again = messageCheckpoints([user("a", text("One")), user("b", text("Two"))]);
    expect(again).not.toBe(before);
    expect(holdCheckpoints(before, again)).toBe(before);
  });

  it("keeps unchanged entries by identity when a message arrives", () => {
    const before = messageCheckpoints([user("a", text("One"))]);
    const next = holdCheckpoints(
      before,
      messageCheckpoints([user("a", text("One")), user("b", text("Two"))]),
    );
    expect(next).not.toBe(before);
    expect(next[0]).toBe(before[0]);
    expect(next.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("takes an edited prompt", () => {
    const before = messageCheckpoints([user("a", text("One"))]);
    const next = holdCheckpoints(before, messageCheckpoints([user("a", text("Uno"))]));
    expect(next[0]?.prompt).toBe("Uno");
  });
});

describe("checkpointReply", () => {
  const rows: WorkTranscriptRow[] = [
    user("a", text("Ask one")),
    said("r1", "Looking"),
    work,
    said("r2", "**Done** with one."),
    user("b", text("Ask two")),
    work,
    user("c", text("Ask three")),
    said("r3", "Partial so"),
  ];

  it("is the last agent text before the person's next message", () => {
    expect(checkpointReply(rows, "a")).toBe("Done with one.");
  });

  it("is null when the agent has only worked, not written", () => {
    expect(checkpointReply(rows, "b")).toBeNull();
  });

  it("is the latest text received for the live exchange", () => {
    expect(checkpointReply(rows, "c")).toBe("Partial so");
  });

  it("is null for a message no longer in the rows", () => {
    expect(checkpointReply(rows, "gone")).toBeNull();
  });

  it("passes over an empty turn row", () => {
    const empty: WorkTranscriptRow = { kind: "turn", messages: [] };
    expect(isCheckpointRow(empty)).toBe(false);
    expect(checkpointReply([user("a", text("Ask")), empty, said("r", "Said")], "a")).toBe("Said");
  });

  it("skips a blank trailing text part and anything that is not text", () => {
    const row: WorkTranscriptRow = {
      kind: "turn",
      messages: [
        {
          id: "r",
          role: "assistant",
          parts: [text("Said it"), text("  "), { type: "reasoning", text: "Thinking" }],
        },
      ],
    };
    expect(checkpointReply([user("a", text("Ask")), row], "a")).toBe("Said it");
  });
});

describe("currentCheckpoint", () => {
  const checkpoints = messageCheckpoints([
    user("a", text("A")),
    user("b", text("B")),
    user("c", text("C")),
  ]);

  it("is the last message above the reading line", () => {
    expect(
      currentCheckpoint({ checkpoints, above: new Set(["a", "b"]), before: null, pinned: false }),
    ).toBe("b");
  });

  it("is the latest exchange while pinned to the bottom", () => {
    expect(
      currentCheckpoint({ checkpoints, above: new Set(["a"]), before: null, pinned: true }),
    ).toBe("c");
  });

  it("is the exchange the window starts inside when no mounted message is above", () => {
    expect(currentCheckpoint({ checkpoints, above: new Set(), before: "b", pinned: false })).toBe(
      "b",
    );
  });

  it("is the first message at the top of the conversation", () => {
    expect(currentCheckpoint({ checkpoints, above: new Set(), before: null, pinned: false })).toBe(
      "a",
    );
  });

  describe("past the start of rows held back after a far jump (VC-1226)", () => {
    // "a" was landed on, "b" is held back, "c" is mounted below the hold.
    it("is the last held message, not the last one mounted above the hold", () => {
      expect(
        currentCheckpoint({
          checkpoints,
          above: new Set(["a"]),
          before: null,
          pinned: false,
          held: "b",
        }),
      ).toBe("b");
    });

    it("is a message below the hold once it crosses the line", () => {
      expect(
        currentCheckpoint({
          checkpoints,
          above: new Set(["a", "c"]),
          before: null,
          pinned: false,
          held: "b",
        }),
      ).toBe("c");
    });

    it("keeps the mounted message when the hold holds none of the person's", () => {
      // The last checkpoint before the hold's end is then the landed one.
      expect(
        currentCheckpoint({
          checkpoints,
          above: new Set(["a"]),
          before: null,
          pinned: false,
          held: "a",
        }),
      ).toBe("a");
    });

    it("is the held message with nothing mounted above the line", () => {
      expect(
        currentCheckpoint({
          checkpoints,
          above: new Set(),
          before: null,
          pinned: false,
          held: "b",
        }),
      ).toBe("b");
    });

    it("ignores a held message that is no longer a checkpoint", () => {
      expect(
        currentCheckpoint({
          checkpoints,
          above: new Set(["a"]),
          before: null,
          pinned: false,
          held: "gone",
        }),
      ).toBe("a");
      expect(
        currentCheckpoint({
          checkpoints,
          above: new Set(),
          before: null,
          pinned: false,
          held: "gone",
        }),
      ).toBe("a");
    });

    it("still answers the latest exchange while pinned", () => {
      expect(
        currentCheckpoint({ checkpoints, above: new Set(), before: null, pinned: true, held: "b" }),
      ).toBe("c");
    });
  });

  it("is nothing without checkpoints", () => {
    expect(
      currentCheckpoint({ checkpoints: [], above: new Set(), before: null, pinned: true }),
    ).toBeNull();
  });
});

describe("snippets", () => {
  /** The reply snippet `markdown` makes, read through the public reader. */
  const snippet = (markdown: string) =>
    checkpointReply([user("q", text("Q")), said("r", markdown)], "q");

  it("reads markdown as one line of text", () => {
    expect(
      snippet(
        "# Title\n\n- [x] **done** with `code`\n> quoted [link](https://x.y) ![img](a.png)\n\n```ts\nconst a = 1;\n```\n1. last",
      ),
    ).toBe("Title done with code quoted link img last");
  });

  it("drops fenced code when there is prose, and keeps it when there is not", () => {
    expect(snippet("Before\n```\nconst a = 1;\n```\nAfter")).toBe("Before After");
    expect(snippet("Streaming\n```ts\nconst half = ")).toBe("Streaming");
    expect(snippet("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("keeps snake_case and single asterisks inside words", () => {
    expect(snippet("use snake_case and 2*3")).toBe("use snake_case and 2*3");
  });

  it("cuts on a code point, not inside an emoji", () => {
    const [checkpoint] = messageCheckpoints([user("rockets", text("🚀".repeat(300)))]);
    expect(checkpoint!.prompt).toBe(`${"🚀".repeat(279)}…`);
    expect(checkpoint!.label).toBe(`${"🚀".repeat(99)}…`);
  });

  it("is nothing for whitespace and zero-width text", () => {
    expect(snippet(" \n\u200B\uFEFF ")).toBeNull();
  });
});

describe("cost per streamed update", () => {
  it("cuts a fresh snippet for a new message object, even under the same id", () => {
    const [before] = messageCheckpoints([user("edited", text("First words"))]);
    const [after] = messageCheckpoints([user("edited", text("Second words"))]);
    expect(before!.prompt).toBe("First words");
    expect(after!.prompt).toBe("Second words");
    expect(after!.label).toBe("Second words");
  });

  it("cuts each message's snippet once, however often the rows are re-read", () => {
    let reads = 0;
    const parts: UIMessage["parts"] = [text("A long ask")];
    const message = {
      id: "counted",
      role: "user" as const,
      get parts() {
        reads += 1;
        return parts;
      },
    } as UIMessage;
    const asked: WorkTranscriptRow = { kind: "turn", messages: [message] };
    const first = messageCheckpoints([asked, said("r", "Partial")]);
    const readsAfterFirst = reads;
    // Streamed updates: the reply grows, the user message object is the same.
    const second = messageCheckpoints([asked, said("r", "Partial so")]);
    const third = messageCheckpoints([asked, said("r", "Partial so far")]);
    expect(reads).toBe(readsAfterFirst);
    expect(second[0]).toBe(first[0]);
    expect(third[0]).toBe(first[0]);
    expect(holdCheckpoints(first, third)).toBe(first);
  });
});
