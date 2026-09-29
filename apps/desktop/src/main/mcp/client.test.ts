import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import { MCP_CALL_TIMEOUT_MS, MCP_CONNECTION_TIMEOUT_MS } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isMcpTransportFailure,
  mcpLaunchEnvironment,
  protocolClientForConnectedClient,
  type CloseableMcpClient,
} from "./client";
import { McpTransportFailure } from "./discovery";

let close: (() => Promise<void>) | null = null;
afterEach(async () => close?.());

describe("MCP client — in-process fixture", () => {
  it("reads tools and calls the exact MCP name with the exact arguments", async () => {
    const received: unknown[] = [];
    const server = new Server(
      { name: "fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "fixture/exact-name",
          description: "Fixture echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    }));
    server.setRequestHandler("tools/call", async (request) => {
      received.push(request.params);
      return { content: [{ type: "text", text: "hello" }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const sdk = new Client({ name: "volli-test", version: "1" });
    await sdk.connect(clientTransport);
    const client = protocolClientForConnectedClient(sdk as CloseableMcpClient);
    close = async () => {
      await client.close();
      await server.close();
    };

    expect(await client.listTools(new AbortController().signal)).toEqual([
      expect.objectContaining({ name: "fixture/exact-name", description: "Fixture echo" }),
    ]);
    expect(
      await client.callTool({
        name: "fixture/exact-name",
        arguments: { text: "hello", nested: { exact: true } },
        signal: new AbortController().signal,
      }),
    ).toEqual(expect.objectContaining({ content: [{ type: "text", text: "hello" }] }));
    expect(received).toEqual([
      { name: "fixture/exact-name", arguments: { text: "hello", nested: { exact: true } } },
    ]);
  });
});

describe("MCP client limits", () => {
  it("applies fixed discovery and call deadlines at the SDK boundary", async () => {
    const listTools = vi.fn<CloseableMcpClient["listTools"]>(async () => ({ tools: [] }));
    const callTool = vi.fn<CloseableMcpClient["callTool"]>(async () => ({ content: [] }));
    const client = protocolClientForConnectedClient({
      listTools,
      callTool,
      close: async () => undefined,
    });
    const signal = new AbortController().signal;

    await client.listTools(signal);
    await client.callTool({ name: "echo", arguments: { exact: true }, signal });

    expect(listTools).toHaveBeenCalledWith(undefined, {
      signal,
      timeout: MCP_CONNECTION_TIMEOUT_MS,
      maxTotalTimeout: MCP_CONNECTION_TIMEOUT_MS,
    });
    expect(callTool).toHaveBeenCalledWith(
      { name: "echo", arguments: { exact: true } },
      { signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS },
    );
  });
});

describe("MCP transport failure classification (VC-454)", () => {
  it("counts only a lost, refused, ended or unanswered connection as a transport failure", () => {
    expect(isMcpTransportFailure(new SdkError(SdkErrorCode.ConnectionClosed, "closed"))).toBe(true);
    expect(isMcpTransportFailure(new SdkError(SdkErrorCode.NotConnected, "gone"))).toBe(true);
    expect(isMcpTransportFailure(new SdkError(SdkErrorCode.SendFailed, "send"))).toBe(true);
    // The whole call deadline passed with the caller still waiting.
    expect(isMcpTransportFailure(new SdkError(SdkErrorCode.RequestTimeout, "silent"))).toBe(true);
    for (const status of [400, 404]) {
      expect(
        isMcpTransportFailure(
          new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "session ended", { status }),
        ),
      ).toBe(true);
    }
    expect(isMcpTransportFailure(new TypeError("fetch failed"))).toBe(true);

    // The server answered, or the connection is still usable.
    expect(
      isMcpTransportFailure(new ProtocolError(ProtocolErrorCode.InvalidParams, "bad args")),
    ).toBe(false);
    expect(isMcpTransportFailure(new SdkError(SdkErrorCode.InvalidResult, "malformed"))).toBe(
      false,
    );
    for (const status of [429, 500, 502, 503, 401, 403]) {
      expect(
        isMcpTransportFailure(
          new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "answered", { status }),
        ),
      ).toBe(false);
    }
  });

  it("wraps a transport failure and passes every other rejection through unchanged", async () => {
    const answered = new ProtocolError(ProtocolErrorCode.InvalidParams, "bad args");
    const failures: unknown[] = [new SdkError(SdkErrorCode.ConnectionClosed, "closed"), answered];
    const client = protocolClientForConnectedClient({
      listTools: async () => ({ tools: [] }),
      callTool: async () => Promise.reject(failures.shift()),
      close: async () => undefined,
    });
    const signal = new AbortController().signal;

    const transport = await client
      .callTool({ name: "one", arguments: {}, signal })
      .catch((error: unknown) => error);
    expect(transport).toBeInstanceOf(McpTransportFailure);
    expect((transport as Error).cause).toBeInstanceOf(SdkError);
    await expect(client.callTool({ name: "two", arguments: {}, signal })).rejects.toBe(answered);
  });

  it("never reports a caller's own abort as a transport failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const sdkRejection = new SdkError(SdkErrorCode.RequestTimeout, "stopped");
    const client = protocolClientForConnectedClient({
      listTools: async () => ({ tools: [] }),
      callTool: async () => Promise.reject(sdkRejection),
      close: async () => undefined,
    });

    const error = await client
      .callTool({ name: "one", arguments: {}, signal: controller.signal })
      .catch((caught: unknown) => caught);
    // The SDK's own rejection, passed through untouched: never reclassified
    // and never turned into a result.
    expect(error).toBe(sdkRejection);
    expect(error).not.toBeInstanceOf(McpTransportFailure);
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
