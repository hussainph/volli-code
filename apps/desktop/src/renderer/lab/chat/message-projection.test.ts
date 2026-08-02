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
});
