import {
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  type JsonRpcMessage,
  type McpRequestOptions,
} from "@earendil-works/pi-mcp";
import {
  createInMemoryTransportPair,
  type InMemoryTransport,
} from "@earendil-works/pi-mcp/testing";
import { MCP_CALL_TIMEOUT_MS, MCP_CONNECTION_TIMEOUT_MS } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  classifyMcpConnectionError,
  isMcpTransportFailure,
  MCP_LIST_MAX_PAGES,
  mcpLaunchEnvironment,
  protocolClientForConnectedClient,
  type CloseableMcpClient,
} from "./client";
import {
  McpCredentialMissingError,
  McpProtocolEraError,
  McpSignInRequiredError,
} from "./credentials";
import { McpTransportFailure } from "./discovery";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

type Handler = (method: string, params: Record<string, unknown>) => unknown;

/**
 * A server answering over pi-mcp's in-memory pair: enough of the protocol to
 * run the real `McpClient` through the port without a process or a socket.
 */
function inMemoryServer(handler: Handler): InMemoryTransport {
  const { client, server } = createInMemoryTransportPair();
  server.onMessage((message: JsonRpcMessage) => {
    if (!("id" in message) || !("method" in message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    let reply: JsonRpcMessage;
    if (message.method === "initialize") {
      reply = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: params["protocolVersion"],
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      };
    } else {
      try {
        reply = { jsonrpc: "2.0", id: message.id, result: handler(message.method, params) };
      } catch (error) {
        reply = {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : "failed" },
        };
      }
    }
    void server.send(reply);
  });
  void server.start();
  return client;
}

async function connected(handler: Handler) {
  const sdk = new McpClient({ name: "volli-test", version: "1" });
  await sdk.connect(inMemoryServer(handler));
  const client = protocolClientForConnectedClient(sdk);
  close = () => client.close();
  return { sdk, client };
}

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
});

describe("MCP client — in-process fixture", () => {
  it("negotiates the 2025-11-25 revision, reads tools and calls the exact MCP name with the exact arguments", async () => {
    const received: unknown[] = [];
    const { sdk, client } = await connected((method, params) => {
      if (method === "tools/list") return { tools: [tool("fixture/exact-name")] };
      received.push(params);
      return { content: [{ type: "text", text: "hello" }], structuredContent: { ok: true } };
    });

    expect(sdk.protocolVersion).toBe("2025-11-25");
    expect(await client.listTools(new AbortController().signal)).toEqual([
      expect.objectContaining({
        name: "fixture/exact-name",
        description: "fixture/exact-name tool",
      }),
    ]);
    expect(
      await client.callTool({
        name: "fixture/exact-name",
        arguments: { text: "hello", nested: { exact: true } },
        signal: new AbortController().signal,
      }),
    ).toEqual({ content: [{ type: "text", text: "hello" }], structuredContent: { ok: true } });
    expect(received).toEqual([
      { name: "fixture/exact-name", arguments: { text: "hello", nested: { exact: true } } },
    ]);
  });

  it("follows cursors, and refuses a repeated cursor rather than looping", async () => {
    const { client } = await connected((_method, params) =>
      params["cursor"] === undefined
        ? { tools: [tool("one")], nextCursor: "page-2" }
        : params["cursor"] === "page-2"
          ? { tools: [tool("two")], nextCursor: "page-2" }
          : { tools: [] },
    );

    await expect(client.listTools(new AbortController().signal)).rejects.toThrow(
      /cursor it had already returned/,
    );
  });

  it(`stops after ${MCP_LIST_MAX_PAGES} pages instead of following a server forever`, async () => {
    let pages = 0;
    const { client } = await connected(() => {
      pages += 1;
      return { tools: [], nextCursor: `page-${pages}` };
    });

    await expect(client.listTools(new AbortController().signal)).rejects.toThrow(
      new RegExp(`exceeded ${MCP_LIST_MAX_PAGES} pages`),
    );
    expect(pages).toBe(MCP_LIST_MAX_PAGES);
  });

  it.each([
    [{ tools: "nope" }, "Invalid MCP tools/list result"],
    [{ tools: [{ name: 1, inputSchema: {} }] }, "Invalid entry"],
    [{ tools: [{ name: "x", inputSchema: {}, description: 7 }] }, "Invalid entry"],
    [{ tools: [], nextCursor: 3 }, "cursor"],
  ])("refuses a malformed catalog page %#", async (page, message) => {
    const { client } = await connected(() => page);
    await expect(client.listTools(new AbortController().signal)).rejects.toThrow(message);
  });
});

describe("MCP client limits", () => {
  it("applies fixed discovery and call deadlines at the client boundary", async () => {
    const request = vi.fn(
      async (_method: string, _params?: Record<string, unknown>, _options?: McpRequestOptions) => ({
        tools: [],
      }),
    );
    const callTool = vi.fn<CloseableMcpClient["callTool"]>(async () => ({ content: [] }));
    const client = protocolClientForConnectedClient({
      request: request as unknown as CloseableMcpClient["request"],
      callTool,
      close: async () => undefined,
    });
    const signal = new AbortController().signal;

    await client.listTools(signal);
    await client.callTool({ name: "echo", arguments: { exact: true }, signal });

    expect(request).toHaveBeenCalledWith("tools/list", undefined, {
      signal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
    });
    const [, , listOptions] = request.mock.calls[0]!;
    expect(listOptions?.timeoutMs).toBeLessThanOrEqual(MCP_CONNECTION_TIMEOUT_MS);
    expect(listOptions?.timeoutMs).toBeGreaterThan(MCP_CONNECTION_TIMEOUT_MS - 1_000);
    expect(callTool).toHaveBeenCalledWith(
      "echo",
      { exact: true },
      { signal, timeoutMs: MCP_CALL_TIMEOUT_MS },
    );
  });

  it("aborts a catalog read when the caller's signal does", async () => {
    const request = vi.fn(
      (_method: string, _params?: Record<string, unknown>, options?: McpRequestOptions) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const client = protocolClientForConnectedClient({
      request: request as unknown as CloseableMcpClient["request"],
      callTool: vi.fn(),
      close: async () => undefined,
    });
    const controller = new AbortController();
    const reading = client.listTools(controller.signal);
    controller.abort(new Error("stop"));

    await expect(reading).rejects.toThrow("aborted");
  });

  it("closes the underlying client once", async () => {
    const closeClient = vi.fn(async () => undefined);
    const client = protocolClientForConnectedClient({
      request: vi.fn(),
      callTool: vi.fn(),
      close: closeClient,
    });

    await client.close();
    await client.close();
    expect(closeClient).toHaveBeenCalledOnce();
  });
});

describe("MCP transport failure classification (VC-454, on pi-mcp)", () => {
  it("counts only a lost, refused, ended or unanswered connection as a transport failure", () => {
    expect(isMcpTransportFailure(new McpConnectionClosedError())).toBe(true);
    // The whole call deadline passed with the caller still waiting.
    expect(isMcpTransportFailure(new McpTimeoutError(30_000))).toBe(true);
    expect(isMcpTransportFailure(new McpSessionExpiredError())).toBe(true);
    expect(isMcpTransportFailure(new McpHttpError(400, "session ended"))).toBe(true);
    expect(isMcpTransportFailure(new TypeError("fetch failed"))).toBe(true);

    // The server answered, or the connection is still usable.
    expect(isMcpTransportFailure(new McpError(-32602, "bad args"))).toBe(false);
    expect(isMcpTransportFailure(new McpError(-32600, "Invalid MCP tools/call result"))).toBe(
      false,
    );
    expect(isMcpTransportFailure(new McpAbortError())).toBe(false);
    for (const status of [429, 500, 502, 503, 403]) {
      expect(isMcpTransportFailure(new McpHttpError(status, "answered"))).toBe(false);
    }
    // Refusals a person answers (VC-470): the connection stays.
    expect(
      isMcpTransportFailure(new McpAuthRequiredError(new Response(null, { status: 401 }))),
    ).toBe(false);
    expect(isMcpTransportFailure(new McpSignInRequiredError("X", false))).toBe(false);
    expect(isMcpTransportFailure(new McpCredentialMissingError("X", ["header A"]))).toBe(false);
  });

  it("wraps a transport failure and passes every other rejection through unchanged", async () => {
    const answered = new McpError(-32602, "bad args");
    const failures: unknown[] = [new McpConnectionClosedError(), answered];
    const client = protocolClientForConnectedClient({
      request: vi.fn() as unknown as CloseableMcpClient["request"],
      callTool: async () => Promise.reject(failures.shift()),
      close: async () => undefined,
    });
    const signal = new AbortController().signal;

    const transport = await client
      .callTool({ name: "one", arguments: {}, signal })
      .catch((error: unknown) => error);
    expect(transport).toBeInstanceOf(McpTransportFailure);
    expect((transport as Error).cause).toBeInstanceOf(McpConnectionClosedError);
    await expect(client.callTool({ name: "two", arguments: {}, signal })).rejects.toBe(answered);
  });

  it("never reports a caller's own abort as a transport failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const rejection = new McpConnectionClosedError();
    const client = protocolClientForConnectedClient({
      request: vi.fn() as unknown as CloseableMcpClient["request"],
      callTool: async () => Promise.reject(rejection),
      close: async () => undefined,
    });

    const error = await client
      .callTool({ name: "one", arguments: {}, signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBe(rejection);
    expect(error).not.toBeInstanceOf(McpTransportFailure);
  });
});

function versionErrorBody(error: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, error, ...extra });
}

describe("structural protocol-era refusals (VC-479)", () => {
  const server = {
    name: "Fixture",
    transport: { type: "stdio" as const, command: "unused", args: [] },
  };
  const data = { supported: ["2026-07-28"], requested: "2025-11-25" };
  const rpcError = { code: -32022, message: "Version refused", data };

  it("recognizes a stdio version error regardless of its prose", () => {
    const error = new McpError(-32022, "Version refused", data);
    expect(classifyMcpConnectionError(error, server)).toBeInstanceOf(McpProtocolEraError);
  });

  it.each([1, "request", null, undefined])(
    "recognizes an HTTP 400 version error with id %s",
    (id) => {
      const error = new McpHttpError(400, "Bad request", versionErrorBody(rpcError, { id }));
      expect(classifyMcpConnectionError(error, server)).toBeInstanceOf(McpProtocolEraError);
    },
  );

  it.each([
    undefined,
    null,
    "2026-07-28",
    {},
    { supported: "2026-07-28" },
    { supported: [] },
    { supported: ["2026-07-28", 1] },
    { supported: ["2026-07-28", null] },
    { supported: ["2026-07-28-extra"] },
    { supported: ["2025-11-25"], requested: "2026-07-28" },
    ...["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].map((version) => ({
      supported: ["2026-07-28", version],
    })),
  ])("does not infer modern-only support from invalid or compatible data %#", (invalidData) => {
    for (const error of [
      new McpError(-32022, "2026-07-28", invalidData),
      new McpHttpError(400, "Bad request", versionErrorBody({ ...rpcError, data: invalidData })),
    ]) {
      expect(classifyMcpConnectionError(error, server)).toBe(error);
    }
  });

  it.each([-32601, -32602, -32000, -32020, -32021])(
    "does not guess from a different code %s",
    (code) => {
      for (const error of [
        new McpError(code, "2026-07-28", data),
        new McpHttpError(400, "Bad request", versionErrorBody({ ...rpcError, code })),
      ]) {
        expect(classifyMcpConnectionError(error, server)).toBe(error);
      }
    },
  );

  it.each([
    "2026-07-28",
    "{invalid json 2026-07-28",
    JSON.stringify(null),
    JSON.stringify([rpcError]),
    JSON.stringify(rpcError),
    versionErrorBody(rpcError, { jsonrpc: "1.0" }),
    versionErrorBody(rpcError, { id: {} }),
    versionErrorBody(rpcError, { result: {} }),
    versionErrorBody(rpcError, { method: "initialize" }),
    versionErrorBody({ ...rpcError, message: null }),
    versionErrorBody({ ...rpcError, code: "-32022" }),
  ])("leaves a malformed or non-JSON-RPC HTTP body unchanged %#", (invalidBody) => {
    const error = new McpHttpError(400, "Bad request", invalidBody);
    expect(classifyMcpConnectionError(error, server)).toBe(error);
  });

  it.each([401, 403, 404, 429, 500])(
    "does not interpret HTTP %s as version negotiation",
    (status) => {
      const error = new McpHttpError(status, "Refused", versionErrorBody(rpcError));
      expect(classifyMcpConnectionError(error, server)).toBe(error);
    },
  );

  it("leaves plain version mentions and existing problems unchanged", () => {
    for (const error of [new Error("2026-07-28"), new McpProtocolEraError(server.name)]) {
      expect(classifyMcpConnectionError(error, server)).toBe(error);
    }
  });
});

describe("mcpLaunchEnvironment", () => {
  it("keeps launch essentials and excludes provider keys, Volli tokens, and observability variables", () => {
    expect(
      mcpLaunchEnvironment({
        PATH: "/bin",
        HOME: "/home/ada",
        TMPDIR: "/tmp",
        OPENAI_API_KEY: "provider-secret",
        VOLLI_AGENT_TOKEN: "session-secret",
        OTEL_EXPORTER_OTLP_HEADERS: "telemetry-secret",
        RANDOM_APP_SECRET: "other-secret",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/ada", TMPDIR: "/tmp" });
  });
});
