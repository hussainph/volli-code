import { expect, it } from "vite-plus/test";
import {
  UNKNOWN_MCP_PROVENANCE,
  scrubSessionEventPayload,
  type McpServerRecord,
  type McpToolDefinition,
} from "@volli/shared";
import type { ChatSessionFrame } from "./transcript";
import { transcriptMcpNames } from "./transcript-mcp-metadata";

const recorded: McpToolDefinition = {
  serverId: "server",
  toolName: "search_screens",
  providerName: "mcp__old_name__search_screens__1234abcd",
  description: "Search",
  inputSchema: {},
};
const current: McpToolDefinition = {
  ...recorded,
  providerName: "mcp__new_name__search_screens__1234abcd",
};
const server: McpServerRecord = {
  id: "server",
  projectId: "project",
  name: "Design library",
  enabled: true,
  transport: { type: "streamable-http", url: "https://design.example.org/mcp" },
  provenance: UNKNOWN_MCP_PROVENANCE,
  catalog: [
    {
      name: "search_screens",
      description: "Search",
      enabled: true,
      definition: current,
      error: null,
      hints: { title: "Find screens" },
    },
  ],
  stale: false,
  error: null,
  refreshedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};
const frame: ChatSessionFrame = {
  sessionId: "session",
  sequence: 1,
  transcript: null,
  event: {
    id: "event",
    sessionId: "session",
    sequence: 1,
    occurredAt: 1,
    recordedAt: 1,
    provenance: { source: { kind: "system", id: "fixture", detail: null }, venue: null },
    payload: {
      kind: "session.input.recorded",
      input: { kind: "tool-surface", tools: [recorded.providerName], mcpTools: [recorded] },
    },
  },
};

it("joins the frozen identity to configured names without rewriting any birth declaration", () => {
  const original = JSON.stringify(frame);
  const names = transcriptMcpNames([frame], [server]);
  expect(names.get(recorded.providerName)).toEqual({
    server: "Design library",
    tool: "Find screens",
    url: "https://design.example.org/mcp",
  });
  expect(names.get(current.providerName)).toEqual(names.get(recorded.providerName));
  expect(JSON.stringify(frame)).toBe(original);
});

it("humanizes real tool names without relying on a truncated provider id or a guessed hash", () => {
  const withoutHints = {
    ...server,
    catalog: server.catalog.map((tool) => ({ ...tool, hints: undefined })),
  };
  expect(transcriptMcpNames([frame], [withoutHints]).get(recorded.providerName)?.tool).toBe(
    "Search screens",
  );
  expect(transcriptMcpNames([], [server]).has(recorded.providerName)).toBe(false);
  expect(transcriptMcpNames([frame], []).size).toBe(0);
});

it("does not invent an identity from refresh fields the real renderer codec withholds", () => {
  const refresh: ChatSessionFrame = {
    ...frame,
    event: {
      ...frame.event!,
      payload: scrubSessionEventPayload({
        kind: "session.tools.refreshed",
        trigger: "code-mode",
        delta: { mcpTools: [recorded] },
        added: [recorded.providerName],
        changed: [],
      }),
    },
  };
  expect(transcriptMcpNames([refresh], [server]).has(recorded.providerName)).toBe(false);
  expect(transcriptMcpNames([refresh], [server]).get(current.providerName)?.server).toBe(
    "Design library",
  );
});
