import { describe, expect, it, vi } from "vite-plus/test";
import { mcpProviderToolName, type McpServerDraft, type McpToolDefinition } from "@volli/shared";

import type { McpProtocolClient } from "./discovery";
import { McpSessionHost, serversForFrozenMcpTools } from "./session-host";

const server: McpServerDraft = {
  id: "server-1",
  name: "Fixture",
  enabled: true,
  transport: { type: "stdio", command: "fixture", args: [] },
};

function client(callTool: McpProtocolClient["callTool"]): McpProtocolClient {
  return { listTools: async () => [], callTool, close: vi.fn(async () => undefined) };
}

describe("McpSessionHost", () => {
  it("binds only servers required by frozen definitions and refuses a missing server before attach", () => {
    const definition: McpToolDefinition = {
      serverId: server.id,
      toolName: "exact/name",
      providerName: mcpProviderToolName(server.id, server.name, "exact/name"),
      description: "Exact",
      inputSchema: { type: "object" },
    };

    expect(serversForFrozenMcpTools([{ ...server, enabled: false }], [definition])).toEqual([
      server,
    ]);
    expect(() => serversForFrozenMcpTools([], [definition])).toThrow(
      /required MCP server.*restore.*retry/i,
    );
  });

  it("opens one lazy client per server, reuses it for exact calls, and closes it with the attachment", async () => {
    const protocol = client(async ({ name, arguments: arguments_ }) => ({
      content: [{ type: "text", text: `${name}:${String(arguments_.value)}` }],
      isError: false,
    }));
    const open = vi.fn(async () => protocol);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const signal = new AbortController().signal;

    await expect(
      host.port.call(
        {
          serverId: "server-1",
          toolName: "exact/name",
          arguments: { value: 1 },
          toolCallId: "one",
        },
        signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "exact/name:1" }], isError: false });
    await host.port.call(
      { serverId: "server-1", toolName: "exact/name", arguments: { value: 2 }, toolCallId: "two" },
      signal,
    );

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(server, "/workspace", expect.any(AbortSignal));
    await host.close();
    expect(protocol.close).toHaveBeenCalledOnce();
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "exact/name", arguments: {}, toolCallId: "three" },
        signal,
      ),
    ).rejects.toThrow("MCP attachment is closed");
  });

  it("converts text, images, resources, structured output, and error status without retaining blobs", async () => {
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () =>
        client(async () => ({
          content: [
            { type: "text", text: "hello" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            { type: "resource_link", uri: "docs://guide", name: "Guide" },
            { type: "resource", resource: { uri: "docs://large", blob: "secret-blob" } },
          ],
          structuredContent: { result: true },
          isError: true,
        })),
    });

    const result = await host.port.call(
      { serverId: "server-1", toolName: "mixed", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "unsupported", text: "[resource link: Guide — docs://guide]" },
        { type: "unsupported", text: "[embedded resource: docs://large]" },
      ],
      structuredContent: { result: true },
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-blob");
  });

  it("rejects disabled or unknown servers and oversize results using safe errors", async () => {
    const huge = "x".repeat(300_000);
    const open = vi.fn(async () =>
      client(async () => ({ content: [{ type: "text", text: huge }] })),
    );
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server, { ...server, id: "disabled", enabled: false }],
      open,
    });

    for (const serverId of ["missing", "disabled"]) {
      await expect(
        host.port.call(
          { serverId, toolName: "one", arguments: {}, toolCallId: "one" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("MCP server is unavailable for this Session");
    }
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "large", arguments: {}, toolCallId: "one" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("MCP result exceeded the safe size limit");
  });

  it("turns protocol failures into a safe failed result naming only the configured server", async () => {
    const protocol = client(async () => Promise.reject(new Error("token=secret")));
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => protocol,
    });

    const result = await host.port.call(
      { serverId: server.id, toolName: "one", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "MCP server Fixture call failed." }],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(protocol.close).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight call when its attachment closes", async () => {
    const seen: AbortSignal[] = [];
    const protocol = client(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          seen.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => protocol,
    });
    const invocation = host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await host.close();

    expect(seen[0]?.aborted).toBe(true);
    await expect(invocation).rejects.toThrow("MCP attachment closed");
  });

  it("forwards cancellation and retires clients whose calls fail", async () => {
    const seen: AbortSignal[] = [];
    const clients = [
      client(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            seen.push(signal);
            signal.addEventListener("abort", () => reject(new Error("token=secret")), {
              once: true,
            });
          }),
      ),
      client(async () => ({ content: [{ type: "text", text: "recovered" }] })),
    ];
    const open = vi.fn(async () => clients.shift()!);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const controller = new AbortController();
    const invocation = host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      controller.signal,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort("stopped");

    await expect(invocation).rejects.not.toThrow("secret");
    expect(seen[0]?.aborted).toBe(true);
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "two" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "recovered" }], isError: false });
    expect(open).toHaveBeenCalledTimes(2);
  });
});
