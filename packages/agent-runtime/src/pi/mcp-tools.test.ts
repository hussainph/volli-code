import { describe, expect, it, vi } from "vite-plus/test";
import {
  MCP_RESULT_MAX_CHARS,
  mcpProviderToolName,
  type McpToolDefinition,
  type RuntimeMcpPort,
} from "@volli/shared";

import { createSessionTools } from "./tools";

function definition(): McpToolDefinition {
  return {
    serverId: "fixture-1",
    toolName: "fixture/exact-name",
    providerName: mcpProviderToolName("fixture-1", "Fixture", "fixture/exact-name"),
    description: "Echo data from the fixture",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

function tool(port: RuntimeMcpPort) {
  const registered = createSessionTools(
    { tools: { tools: [], mcp: [definition()] }, mcp: port },
    {} as never,
  );
  expect(registered).toHaveLength(1);
  return registered[0]!;
}

describe("MCP Pi tool wrapper", () => {
  it("uses the frozen provider definition and maps exact identity and arguments through the port", async () => {
    const call = vi.fn<RuntimeMcpPort["call"]>(async () => ({
      content: [
        { type: "text", text: "server text" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "unsupported", text: "[resource link: docs://guide]" },
      ],
      structuredContent: { z: 1, a: { two: true } },
      isError: false,
    }));
    const registered = tool({ call });

    expect(registered.name).toBe(definition().providerName);
    expect(registered.description).toContain("untrusted data");
    expect(registered.description).toContain(definition().description);
    expect(registered.parameters).toEqual(definition().inputSchema);

    const result = await registered.execute(
      "call-1",
      { text: "exact", nested: { value: 1 } },
      new AbortController().signal,
    );

    expect(call).toHaveBeenCalledWith(
      {
        serverId: "fixture-1",
        toolName: "fixture/exact-name",
        arguments: { text: "exact", nested: { value: 1 } },
        toolCallId: "call-1",
      },
      expect.any(AbortSignal),
    );
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("untrusted data") }),
      { type: "text", text: "server text" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "[resource link: docs://guide]" },
      { type: "text", text: 'Structured content (untrusted data): {"a":{"two":true},"z":1}' },
    ]);
    expect(JSON.stringify(result.details)).not.toContain("aGVsbG8=");
    expect(result.details).toEqual({ structuredContent: '{"a":{"two":true},"z":1}' });
  });

  it("turns isError into a failed, model-readable result and never leaks thrown host detail", async () => {
    const failed = tool({
      call: async () => ({
        content: [{ type: "text", text: "The fixture refused this value." }],
        isError: true,
      }),
    });
    await expect(failed.execute("call-2", {}, new AbortController().signal)).rejects.toThrow(
      /untrusted data.*fixture refused/s,
    );

    const broken = tool({ call: async () => Promise.reject(new Error("token=secret")) });
    await expect(broken.execute("call-3", {}, new AbortController().signal)).rejects.toThrow(
      "The MCP tool call failed without a safe result.",
    );
  });

  it("returns empty details without structured content and bounds structured content", async () => {
    const plain = tool({
      call: async () => ({ content: [{ type: "text", text: "plain" }], isError: false }),
    });
    await expect(plain.execute("call-plain", {}, new AbortController().signal)).resolves.toEqual(
      expect.objectContaining({ details: {} }),
    );

    const oversized = tool({
      call: async () => ({
        content: [],
        structuredContent: ["x".repeat(MCP_RESULT_MAX_CHARS)],
        isError: false,
      }),
    });
    const result = await oversized.execute("call-oversized", {}, new AbortController().signal);
    expect(result.details.structuredContent).toHaveLength(MCP_RESULT_MAX_CHARS);
    expect(result.details.structuredContent).toMatch(/…$/);
  });

  it("honors both attachment and turn cancellation", async () => {
    const attachment = new AbortController();
    const turn = new AbortController();
    const call = vi.fn<RuntimeMcpPort["call"]>(async (_request, signal) => {
      turn.abort();
      expect(signal.aborted).toBe(true);
      throw signal.reason;
    });
    const registered = createSessionTools(
      { tools: { tools: [], mcp: [definition()] }, mcp: { call }, signal: attachment.signal },
      {} as never,
    )[0]!;

    await expect(registered.execute("call-4", {}, turn.signal)).rejects.toBeDefined();
    expect(call).toHaveBeenCalledOnce();

    const cancelledBeforeCall = new AbortController();
    cancelledBeforeCall.abort(new Error("attachment closed"));
    const preAbortedCall = vi.fn<RuntimeMcpPort["call"]>(async (_request, signal) => {
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toEqual(new Error("attachment closed"));
      throw signal.reason;
    });
    const preAborted = createSessionTools(
      {
        tools: { tools: [], mcp: [definition()] },
        mcp: { call: preAbortedCall },
        signal: cancelledBeforeCall.signal,
      },
      {} as never,
    )[0]!;

    await expect(
      preAborted.execute("call-pre-aborted", {}, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(preAbortedCall).toHaveBeenCalledOnce();
  });
});
