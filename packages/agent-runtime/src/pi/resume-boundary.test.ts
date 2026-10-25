import { describe, expect, it } from "vite-plus/test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  ABANDONED_QUESTION_RESULT,
  INTERRUPTED_TOOL_RESULT,
  interruptedToolResults,
  resumeBoundary,
} from "./resume-boundary";

const failed = (message: AssistantMessage) => message.stopReason === "error";

const user: AgentMessage = { role: "user", content: "Fix the build.", timestamp: 1 };

function reply(
  stopReason: AssistantMessage["stopReason"],
  calls: readonly { id: string; name: string }[] = [],
): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Working on it." },
      ...calls.map(({ id, name }) => ({
        type: "toolCall" as const,
        id,
        name,
        arguments: {},
      })),
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  } as AssistantMessage;
}

function result(toolCallId: string, text = "ok", isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError,
    timestamp: 3,
  };
}

describe("resumeBoundary (VC-450)", () => {
  it("is settled on a user message, a failed reply, or every call answered", () => {
    expect(resumeBoundary([user], failed)).toBe("settled");
    expect(resumeBoundary([user, reply("error", [{ id: "c1", name: "bash" }])], failed)).toBe(
      "settled",
    );
    expect(
      resumeBoundary(
        [
          user,
          reply("toolUse", [
            { id: "c1", name: "bash" },
            { id: "c2", name: "write" },
          ]),
          result("c1"),
          result("c2", "failed", true),
        ],
        failed,
      ),
    ).toBe("settled");
  });

  it("is a tool in flight while any call of the last reply has no result", () => {
    expect(resumeBoundary([user, reply("toolUse", [{ id: "c1", name: "bash" }])], failed)).toBe(
      "tool-in-flight",
    );
    expect(
      resumeBoundary(
        [
          user,
          reply("toolUse", [
            { id: "c1", name: "bash" },
            { id: "c2", name: "write" },
          ]),
          result("c1"),
        ],
        failed,
      ),
    ).toBe("tool-in-flight");
  });

  it("counts a question the restart abandoned as unanswered", () => {
    expect(
      resumeBoundary(
        [
          user,
          reply("toolUse", [{ id: "q1", name: "ask_user" }]),
          result("q1", ABANDONED_QUESTION_RESULT, true),
        ],
        failed,
      ),
    ).toBe("tool-in-flight");
    // The same words as an ordinary result are not the repair.
    expect(
      resumeBoundary(
        [
          user,
          reply("toolUse", [{ id: "q1", name: "ask_user" }]),
          result("q1", ABANDONED_QUESTION_RESULT),
        ],
        failed,
      ),
    ).toBe("settled");
  });

  it("has nothing to continue after a finished reply, or with no conversation", () => {
    expect(resumeBoundary([], failed)).toBe("none");
    expect(resumeBoundary([user, reply("stop")], failed)).toBe("none");
    // Results with no reply before them answer nothing this could continue.
    expect(resumeBoundary([result("c1")], failed)).toBe("none");
  });
});

describe("interruptedToolResults (VC-450)", () => {
  it("answers each unanswered call of the last reply as interrupted, in order", () => {
    const messages = [
      user,
      reply("toolUse", [
        { id: "c1", name: "bash" },
        { id: "c2", name: "write" },
        { id: "c3", name: "browser" },
      ]),
      result("c2"),
    ];
    expect(interruptedToolResults(messages, failed, 9)).toEqual([
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
        isError: true,
        timestamp: 9,
      },
      expect.objectContaining({ toolCallId: "c3", toolName: "browser" }),
    ]);
  });

  it("answers nothing for a settled point, or for a failed reply the retry drops", () => {
    expect(interruptedToolResults([user], failed, 9)).toEqual([]);
    expect(
      interruptedToolResults([user, reply("error", [{ id: "c1", name: "bash" }])], failed, 9),
    ).toEqual([]);
  });
});
