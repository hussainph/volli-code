import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { replyText, transcriptDigest } from "./transcript-digest";

function plan(todos: readonly { content: string; status: "pending" | "completed" }[]): UIMessage {
  return {
    id: "plan",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "volli.activity",
        toolCallId: "call-1",
        toolMetadata: {
          [ACTIVITY_METADATA_KEY]: {
            kind: "plan",
            nativeToolName: "todo_write",
            subject: { label: null, path: null, lineRange: null },
            outcome: null,
            startedAt: null,
            endedAt: null,
          },
        },
        state: "output-available",
        input: { todos },
        output: { ok: true },
      },
    ],
  } as UIMessage;
}

describe("replyText", () => {
  it("is the text parts, joined by a blank line and trimmed, never reasoning or tools", () => {
    expect(
      replyText({
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: " First. " },
          { type: "text", text: "Second." },
        ],
      }),
    ).toBe("First. \n\nSecond.");
    expect(replyText({ parts: [{ type: "text", text: "  \n " }] })).toBeNull();
    expect(replyText(plan([]))).toBeNull();
  });
});

describe("transcriptDigest", () => {
  it("marks an assistant message that said something as a reply", () => {
    expect(
      transcriptDigest({ id: "m", role: "assistant", parts: [{ type: "text", text: "Done." }] }),
    ).toEqual({ role: "assistant", reply: true });
    expect(
      transcriptDigest({ id: "m", role: "assistant", parts: [{ type: "text", text: " " }] }),
    ).toEqual({ role: "assistant" });
  });

  it("never marks a user or system message as a reply", () => {
    expect(
      transcriptDigest({ id: "m", role: "user", parts: [{ type: "text", text: "Do it" }] }),
    ).toEqual({ role: "user" });
    expect(
      transcriptDigest({ id: "m", role: "system", parts: [{ type: "text", text: "Note" }] }),
    ).toEqual({ role: "system" });
  });

  it("carries the plan a message settled, keeping a cleared list as []", () => {
    const todos = [{ content: "Step", status: "pending" as const }];
    expect(transcriptDigest(plan(todos))).toEqual({ role: "assistant", todoList: todos });
    expect(transcriptDigest(plan([]))).toEqual({ role: "assistant", todoList: [] });
  });
});
