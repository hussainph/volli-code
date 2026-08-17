import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { ChatTurn, type TurnContext } from "./chat-plane";

const context: TurnContext = {
  onOpenFile: () => undefined,
  interactions: new Map(),
  open: [],
  resolving: new Set(),
  onResolve: async () => true,
};

function message(role: "user" | "assistant"): UIMessage {
  return {
    id: `${role}-1`,
    role,
    parts: [{ type: "text", text: `${role} message` }],
  };
}

describe("ChatTurn copy control", () => {
  it.each(["user", "assistant"] as const)("renders Copy for a %s message", (role) => {
    const html = renderToStaticMarkup(
      <ChatTurn messages={[message(role)]} context={context} live={false} />,
    );

    expect(html).toContain('aria-label="Copy"');
  });
});
