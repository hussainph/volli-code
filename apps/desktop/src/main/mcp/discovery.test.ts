import { describe, expect, it, vi } from "vite-plus/test";
import { MCP_TOOL_COUNT_MAX, type McpServerDraft } from "@volli/shared";

import { discoverMcpServer, type McpProtocolClient } from "./discovery";

const server: McpServerDraft = {
  id: "fixture-1",
  name: "Fixture",
  enabled: true,
  transport: { type: "stdio", command: "node", args: ["fixture.mjs"] },
};

function client(
  tools: readonly {
    name: string;
    description?: string;
    inputSchema: unknown;
  }[],
): McpProtocolClient & { close: ReturnType<typeof vi.fn> } {
  return {
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

describe("discoverMcpServer", () => {
  it("completes discovery, preserves server order, and carries only the exact prior enabled set", async () => {
    const connection = client([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      { name: "new_tool", description: "New", inputSchema: { type: "object" } },
    ]);

    const catalog = await discoverMcpServer({
      server,
      enabledToolNames: ["echo"],
      signal: new AbortController().signal,
      open: async (opened, workspacePath) => {
        expect(opened).toEqual(server);
        expect(workspacePath).toBe("/repo/worktree");
        return connection;
      },
      workspacePath: "/repo/worktree",
    });

    expect(catalog.map(({ name, enabled, error }) => ({ name, enabled, error }))).toEqual([
      { name: "echo", enabled: true, error: null },
      { name: "new_tool", enabled: false, error: null },
    ]);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("shows a bounded reason for each invalid definition without weakening its schema", async () => {
    const connection = client([
      { name: "valid", inputSchema: { type: "object" } },
      { name: "invalid", inputSchema: { type: "string" } },
    ]);

    const catalog = await discoverMcpServer({
      server,
      enabledToolNames: ["invalid"],
      signal: new AbortController().signal,
      open: async () => connection,
      workspacePath: "/repo",
    });

    expect(catalog[0]?.definition?.inputSchema).toEqual({ type: "object" });
    expect(catalog[1]).toMatchObject({
      name: "invalid",
      enabled: false,
      definition: null,
      error: 'input schema root type must be "object"',
    });
  });

  it("fails duplicate names and tool-count overflow clearly and always closes the connection", async () => {
    const duplicate = client([
      { name: "echo", inputSchema: { type: "object" } },
      { name: "echo", inputSchema: { type: "object" } },
    ]);

    await expect(
      discoverMcpServer({
        server,
        enabledToolNames: [],
        signal: new AbortController().signal,
        open: async () => duplicate,
        workspacePath: "/repo",
      }),
    ).rejects.toThrow(/duplicate.*echo/i);
    expect(duplicate.close).toHaveBeenCalledOnce();

    const overflow = client(
      Array.from({ length: MCP_TOOL_COUNT_MAX + 1 }, (_, index) => ({
        name: `tool-${index}`,
        inputSchema: { type: "object" },
      })),
    );
    await expect(
      discoverMcpServer({
        server,
        enabledToolNames: [],
        signal: new AbortController().signal,
        open: async () => overflow,
        workspacePath: "/repo",
      }),
    ).rejects.toThrow(/128-tool limit/i);
    expect(overflow.close).toHaveBeenCalledOnce();
  });

  it("bounds an untrusted duplicate name before it reaches a discovery error", async () => {
    const longName = `${"x".repeat(10_000)}secret-tail`;
    const connection = client([
      { name: longName, inputSchema: { type: "object" } },
      { name: longName, inputSchema: { type: "object" } },
    ]);

    const error = await discoverMcpServer({
      server,
      enabledToolNames: [],
      signal: new AbortController().signal,
      open: async () => connection,
      workspacePath: "/repo",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/duplicate tool/i);
    expect((error as Error).message.length).toBeLessThan(512);
    expect((error as Error).message).not.toContain("secret-tail");
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("closes a partly-opened client when listing fails", async () => {
    const connection = client([]);
    vi.mocked(connection.listTools).mockRejectedValue(new Error("secret token=abc"));

    await expect(
      discoverMcpServer({
        server,
        enabledToolNames: [],
        signal: new AbortController().signal,
        open: async () => connection,
        workspacePath: "/repo",
      }),
    ).rejects.toThrow("Could not discover tools from Fixture.");
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
