import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  toToolDeclaration,
  Type,
  type Message,
  type SystemMessage,
  type Tool,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import {
  conversationIsEmpty,
  systemHead,
  withoutSystemMessages,
  withSystemHead,
} from "./transcript-context";

const tools: Tool[] = [
  {
    name: "read",
    description: "Read a file.",
    parameters: Type.Object({ path: Type.String() }),
    // What an executable `AgentTool` carries beside its declaration: this must
    // not reach the transcript, and so must not reach a sidecar.
    ...({ execute: () => undefined } as object),
  },
  { name: "edit", description: "Edit a file.", parameters: Type.Object({}) },
];

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const delta: SystemMessage = {
  role: "system",
  content: "",
  toolsRemoved: [{ name: "x" }],
  timestamp: 2,
};

describe("systemHead", () => {
  it("is byte-identical to the message pi-ai's Agent would have seeded", () => {
    // PI-RESTATED: the restatement is pinned against the original, so a Pi
    // that changes the shape of its leading system message fails here rather
    // than at the first provider that meets two different heads.
    const declarations = tools.map(toToolDeclaration);
    expect(JSON.stringify(systemHead("You are the runtime.", tools))).toBe(
      JSON.stringify(createInitialSystemMessage("You are the runtime.", declarations)),
    );
    expect(JSON.stringify(systemHead("You are the runtime.", []))).toBe(
      JSON.stringify(createInitialSystemMessage("You are the runtime.", [])),
    );
    // Declarations under an empty prompt — the head compaction composes for a
    // caller with tools and no prompt — is a head to Pi too, with `""` inside.
    expect(JSON.stringify(systemHead("", tools))).toBe(
      JSON.stringify(createInitialSystemMessage("", declarations)),
    );
    expect(createInitialSystemMessage("", [])).toBeUndefined();
  });

  it("declares what the model sees and nothing it cannot", () => {
    const head = systemHead("prompt", tools);
    expect(head).toEqual({
      role: "system",
      content: "prompt",
      toolsAdded: [
        { name: "read", description: "Read a file.", parameters: expect.any(Object) },
        { name: "edit", description: "Edit a file.", parameters: expect.any(Object) },
      ],
      timestamp: 0,
    });
    expect(head.toolsAdded?.[0]).not.toHaveProperty("execute");
    // A declaration is plain JSON: the typebox schema's symbol keys are gone,
    // which is what lets a head survive a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(head))).toEqual(head);
  });

  it("omits the tools field rather than declaring an empty list", () => {
    expect(systemHead("prompt", [])).toEqual({ role: "system", content: "prompt", timestamp: 0 });
  });
});

describe("withSystemHead", () => {
  it("puts the head first and leaves the conversation's own order alone", () => {
    const head = systemHead("prompt", tools);
    const conversation: AgentMessage[] = [delta, user("hi")];
    const messages = withSystemHead(head, conversation);
    expect(messages[0]).toBe(head);
    expect(messages.slice(1)).toEqual(conversation);
    expect(messages).not.toBe(conversation);
  });
});

describe("conversationIsEmpty", () => {
  it("is empty with no messages, with only the head, and with only system messages", () => {
    expect(conversationIsEmpty([])).toBe(true);
    expect(conversationIsEmpty([systemHead("prompt", tools)])).toBe(true);
    expect(conversationIsEmpty([systemHead("prompt", tools), delta])).toBe(true);
  });

  it("is not empty once anyone has spoken", () => {
    expect(conversationIsEmpty([systemHead("prompt", tools), user("hi")])).toBe(false);
    expect(conversationIsEmpty([user("hi")])).toBe(false);
  });
});

describe("withoutSystemMessages", () => {
  it("drops every system message and keeps the rest in order", () => {
    const messages: Message[] = [
      systemHead("prompt", tools),
      { role: "user", content: "a", timestamp: 1 },
      delta,
      {
        role: "assistant",
        content: [],
        api: "x",
        provider: "y",
        model: "z",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ];
    expect(withoutSystemMessages(messages).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
