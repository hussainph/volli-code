import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { openMcpProtocolClient } from "./client";
import { McpSessionHost } from "./session-host";
import type { McpProtocolClient } from "./discovery";

const opened: McpProtocolClient[] = [];
const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((client) => client.close()));
  await Promise.allSettled(closing.splice(0).map((close) => close()));
});

describe("real MCP transport fixtures", () => {
  it("discovers and calls a v2 server over stdio, then closes the child transport", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
    const client = await openMcpProtocolClient(
      {
        id: "stdio-fixture",
        name: "stdio fixture",
        enabled: true,
        transport: { type: "stdio", command: process.execPath, args: [fixture] },
      },
      process.cwd(),
      new AbortController().signal,
    );
    opened.push(client);

    await expect(client.listTools(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({
        name: "fixture_echo",
        description: "Echo from a real stdio fixture",
      }),
      expect.objectContaining({ name: "fixture_large" }),
    ]);
    await expect(
      client.callTool({
        name: "fixture_echo",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "stdio fixture response" }],
        structuredContent: { transport: "stdio" },
      }),
    );

    await client.close();
    opened.pop();
  });

  it("carries a result over a megabyte through the real stdio transport and session host (VC-469)", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
    const server = {
      id: "stdio-fixture",
      name: "stdio fixture",
      enabled: true,
      transport: { type: "stdio" as const, command: process.execPath, args: [fixture] },
    };
    const host = new McpSessionHost({ workspacePath: process.cwd(), servers: [server] });
    closing.push(() => host.close());

    const result = await host.port.call(
      { serverId: server.id, toolName: "fixture_large", arguments: {}, toolCallId: "large" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(Buffer.byteLength(text)).toBeGreaterThan(1_100_000);
    expect(text.endsWith(`row 19999 ${"-".repeat(45)}`)).toBe(true);
  });

  it("discovers and calls a local unauthenticated Streamable HTTP server", async () => {
    const handler = createMcpHandler(
      () => {
        const fixture = new McpServer({ name: "volli-http-fixture", version: "1.0.0" });
        fixture.registerTool(
          "fixture_http",
          { description: "Reply from a real Streamable HTTP fixture" },
          async () => ({
            content: [{ type: "text", text: "HTTP fixture response" }],
            structuredContent: { transport: "streamable-http" },
          }),
        );
        return fixture;
      },
      { responseMode: "json" },
    );
    const http = createServer(toNodeHandler(handler));
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    closing.push(
      async () =>
        new Promise<void>((resolve, reject) => {
          void handler.close().finally(() => {
            http.close((error) => (error === undefined ? resolve() : reject(error)));
          });
        }),
    );
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("fixture did not listen");

    const client = await openMcpProtocolClient(
      {
        id: "http-fixture",
        name: "HTTP fixture",
        enabled: true,
        transport: { type: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` },
      },
      process.cwd(),
      new AbortController().signal,
    );
    opened.push(client);

    await expect(client.listTools(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({
        name: "fixture_http",
        description: "Reply from a real Streamable HTTP fixture",
      }),
    ]);
    await expect(
      client.callTool({
        name: "fixture_http",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "HTTP fixture response" }],
        structuredContent: { transport: "streamable-http" },
      }),
    );
  });
});
