import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  boundedFetch,
  createMcpProtocolClientOpener,
  MCP_HTTP_MESSAGE_MAX_BYTES,
  MCP_STDIO_BUFFER_MAX_BYTES,
  openMcpProtocolClient,
} from "./client";
import { MemoryMcpCredentialStore } from "./credential-store";
import { McpCredentialRejectedError, McpProtocolEraError } from "./credentials";
import type { McpProtocolClient } from "./discovery";

const opened: McpProtocolClient[] = [];
const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((client) => client.close()));
  await Promise.allSettled(closing.splice(0).map((close) => close()));
});

describe("real MCP transport fixtures", () => {
  // The servers here are built on the official SDK 2.0 — the most common MCP
  // server stack — so these also pin that pi-mcp's 2025-11-25 handshake is
  // accepted by a dual-era server (VC-470).
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
      expect.objectContaining({ name: "fixture_env" }),
      expect.objectContaining({ name: "fixture_large" }),
      expect.objectContaining({ name: "fixture_too_large" }),
      expect.objectContaining({ name: "fixture_exit" }),
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

/** A one-route HTTP server answering every POST with a fixed status and body. */
async function answering(status: number, body: string) {
  const seen: (string | undefined)[] = [];
  const http = createServer((request, response) => {
    seen.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closing.push(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not listen");
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
}

describe("refusals the client names (VC-470)", () => {
  it("names a server that speaks only the 2026-07-28 revision instead of failing opaquely", async () => {
    const fixture = await answering(
      400,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: ["2026-07-28"], requested: "2025-11-25" },
        },
      }),
    );

    await expect(
      openMcpProtocolClient(
        {
          id: "modern",
          name: "Modern only",
          enabled: true,
          transport: { type: "streamable-http", url: fixture.url },
        },
        process.cwd(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(McpProtocolEraError);
  });

  it("calls a 401 to a server carrying the person's own Authorization header a rejected credential, not a sign-in", async () => {
    const fixture = await answering(401, "nope");
    const open = createMcpProtocolClientOpener({
      sources: () => ({ store: new MemoryMcpCredentialStore(), environment: { KEY: "k-value" } }),
    });

    const failure = await open(
      {
        id: "keyed",
        name: "Keyed",
        enabled: true,
        transport: {
          type: "streamable-http",
          url: fixture.url,
          headers: [
            { name: "Authorization", source: { kind: "reference", template: "Bearer ${KEY}" } },
          ],
        },
      },
      process.cwd(),
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpCredentialRejectedError);
    expect((failure as Error).message).toContain("header Authorization");
    expect((failure as Error).message).not.toContain("k-value");
    expect(fixture.seen).toEqual(["Bearer k-value"]);
  });

  it("stops a handshake the caller cancels", async () => {
    const http = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    closing.push(
      () =>
        new Promise<void>((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    );
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("fixture did not listen");
    const controller = new AbortController();
    const opening = openMcpProtocolClient(
      {
        id: "silent",
        name: "Silent",
        enabled: true,
        transport: { type: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` },
      },
      process.cwd(),
      controller.signal,
    );
    controller.abort(new Error("stopped by caller"));

    await expect(opening).rejects.toThrow("stopped by caller");
  });
});

describe("message size bounds (VC-469's 8 MiB outer bound, on pi-mcp)", () => {
  it("accepts one stdio message of about 1.1 MB, past VC-8's old 1 MiB limit", async () => {
    expect(MCP_STDIO_BUFFER_MAX_BYTES).toBeGreaterThanOrEqual(8 * 1_024 * 1_024);
    const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
    const client = await openMcpProtocolClient(
      {
        id: "large",
        name: "Large",
        enabled: true,
        transport: { type: "stdio", command: process.execPath, args: [fixture] },
      },
      process.cwd(),
      new AbortController().signal,
    );
    opened.push(client);

    const result = await client.callTool({
      name: "fixture_large",
      arguments: {},
      signal: new AbortController().signal,
    });

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toHaveLength(1_100_000);
  });

  it("caps a JSON response body, declared or not, and leaves an SSE stream to its per-event bound", async () => {
    expect(MCP_HTTP_MESSAGE_MAX_BYTES).toBeGreaterThanOrEqual(8 * 1_024 * 1_024);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "y".repeat(2_000) } });
    const respond = (headers: Record<string, string>) =>
      vi.fn(async () => new Response(body, { status: 200, headers }));

    const declared = boundedFetch(
      respond({ "content-type": "application/json", "content-length": String(body.length) }),
      1_000,
    );
    await expect(declared("http://127.0.0.1/mcp")).rejects.toThrow(
      "larger than the 1000-byte limit",
    );

    const chunked = boundedFetch(
      vi.fn(
        async () =>
          new Response(new Blob([body]).stream(), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      1_000,
    );
    await expect((await chunked("http://127.0.0.1/mcp")).text()).rejects.toThrow(
      "larger than the 1000-byte limit",
    );

    const small = boundedFetch(respond({ "content-type": "application/json" }), 10_000);
    await expect((await small("http://127.0.0.1/mcp")).json()).resolves.toMatchObject({ id: 1 });

    const stream = boundedFetch(respond({ "content-type": "text/event-stream" }), 1_000);
    await expect((await stream("http://127.0.0.1/mcp")).text()).resolves.toHaveLength(body.length);

    // An error answer labelled as an event stream is read whole by the
    // transport, so it is bounded like any body.
    const erroring = boundedFetch(
      vi.fn(
        async () =>
          new Response(new Blob([body]).stream(), {
            status: 500,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
      1_000,
    );
    await expect((await erroring("http://127.0.0.1/mcp")).text()).rejects.toThrow(
      "larger than the 1000-byte limit",
    );

    const empty = boundedFetch(async () => new Response(null, { status: 202 }), 1);
    expect((await empty("http://127.0.0.1/mcp")).status).toBe(202);
  });

  it("carries a tool's outputSchema through the catalog read for discovery to judge", async () => {
    const outputSchema = { type: "object", properties: { count: { type: "number" } } };
    const http = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method: string;
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "schema-fixture", version: "1" },
              }
            : { tools: [{ name: "typed", inputSchema: { type: "object" }, outputSchema }] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    closing.push(
      () =>
        new Promise<void>((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    );
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("fixture did not listen");
    const client = await openMcpProtocolClient(
      {
        id: "typed",
        name: "Typed",
        enabled: true,
        transport: { type: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` },
      },
      process.cwd(),
      new AbortController().signal,
    );
    opened.push(client);

    const [tool] = await client.listTools(new AbortController().signal);
    expect((tool as unknown as { outputSchema?: unknown }).outputSchema).toEqual(outputSchema);
  });
});
