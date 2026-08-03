import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { projectTranscriptMessages } from "./message-projection";

function frame(sequence: number, message: UIMessage) {
  return { sequence, transcript: { message } };
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

  it("keeps an approval's durable receipt out of the conversation", () => {
    expect(
      projectTranscriptMessages([
        frame(2, { id: "user-1", role: "user", parts: [{ type: "text", text: "Investigate." }] }),
        // What the Session commits when a person answers a permission. Worth
        // keeping; not a thing anyone said.
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
    ).toEqual(["user-1", "assistant-1"]);
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
});
