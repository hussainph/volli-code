import { describe, expect, it } from "vite-plus/test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MCP_UNTRUSTED_DATA_WARNING } from "./tools";
import { toolRefreshId, toolRefreshMessage } from "./tool-refresh-announcements";
import { systemHead, withSystemHead } from "./transcript-context";

describe("durable tool discovery messages", () => {
  it("stores the receipt on an ordinary Pi system message without touching the prefix", () => {
    const message = toolRefreshMessage([{ name: "volli", count: 2 }], 17, "event-1");
    const recovered = JSON.parse(JSON.stringify(message)) as AgentMessage;
    expect(toolRefreshId(recovered)).toBe("event-1");
    expect(message.content).toBe(
      "Tools added through Code Mode: volli (2). Find them with searchTools() and describeTool().",
    );
    const head = systemHead("frozen", []);
    const prefix = JSON.stringify(head);
    expect(withSystemHead(head, [recovered])).toEqual([head, recovered]);
    expect(JSON.stringify(head)).toBe(prefix);
    expect(message.content).not.toContain("event-1");
  });

  it("marks MCP namespaces, but never treats unrelated or malformed messages as receipts", () => {
    const message = toolRefreshMessage([{ name: "mcp:untrusted", count: 1 }], 18);
    expect(message.content).toContain(MCP_UNTRUSTED_DATA_WARNING);
    expect(toolRefreshId(message)).toBeUndefined();
    expect(toolRefreshId({ role: "user", timestamp: 0, content: "ordinary" })).toBeUndefined();
    expect(
      toolRefreshId({ ...message, volliToolRefreshId: 7 } as unknown as AgentMessage),
    ).toBeUndefined();
  });
});
