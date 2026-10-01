import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  MCP_RESULT_INLINE_MAX_BYTES,
  MCP_RESULT_MAX_BYTES,
  mcpProviderToolName,
  type McpToolDefinition,
  type RuntimeMcpPort,
} from "@volli/shared";

import sharp from "sharp";
import { MAX_READ_IMAGE_BASE64_BYTES } from "./read-image-processor";
import { ToolOutputStore } from "./tool-output";
import { createSessionTools, MCP_UNTRUSTED_DATA_WARNING, SAVED_TOOL_OUTPUT_WARNING } from "./tools";

function definition(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
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
    ...overrides,
  };
}

function tool(
  port: RuntimeMcpPort,
  options: { output?: ToolOutputStore; tool?: McpToolDefinition } = {},
) {
  const registered = createSessionTools(
    { tools: { tools: [], mcp: [options.tool ?? definition()] }, mcp: port },
    {} as never,
    options.output,
  );
  expect(registered).toHaveLength(1);
  return registered[0]!;
}

function store(): ToolOutputStore {
  const root = mkdtempSync(join(tmpdir(), "volli-mcp-output-"));
  return new ToolOutputStore({
    directory: join(root, "session.tool-output"),
    workspacePath: join(root, "worktree"),
  });
}

const notice = { type: "text", text: MCP_UNTRUSTED_DATA_WARNING };

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
    expect("outputSchema" in registered).toBe(false);

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
    // The model reads the server's blocks behind the notice, and nothing else:
    // the structured half travels natively instead of as a line of text.
    expect(result).toEqual({
      content: [
        notice,
        { type: "text", text: "server text" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "[resource link: docs://guide]" },
      ],
      details: {},
      structuredContent: { z: 1, a: { two: true } },
    });
  });

  it("declares the frozen output schema, which the model is never sent", () => {
    const outputSchema = { type: "object", properties: { z: { type: "number" } } } as const;
    const registered = tool(
      { call: async () => ({ content: [], isError: false }) },
      { tool: definition({ outputSchema }) },
    );
    expect(registered.outputSchema).toEqual(outputSchema);
  });

  it("returns isError as an error result that keeps the server's structured data", async () => {
    const failed = tool({
      call: async () => ({
        content: [{ type: "text", text: "An issue with that title already exists." }],
        structuredContent: { code: "duplicate", existing: 6 },
        isError: true,
      }),
    });

    await expect(failed.execute("call-2", {}, new AbortController().signal)).resolves.toEqual({
      content: [notice, { type: "text", text: "An issue with that title already exists." }],
      details: {},
      structuredContent: { code: "duplicate", existing: 6 },
      isError: true,
    });
  });

  it("gives a silent error a sentence, and shows a content-less result its structured data", async () => {
    const silent = tool({ call: async () => ({ content: [], isError: true }) });
    await expect(silent.execute("call-silent", {}, new AbortController().signal)).resolves.toEqual({
      content: [
        notice,
        { type: "text", text: "The MCP server reported an error and sent no message." },
      ],
      details: {},
      isError: true,
    });

    const imageOnly = tool({
      call: async () => ({
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        isError: true,
      }),
    });
    const imageResult = await imageOnly.execute("call-image", {}, new AbortController().signal);
    expect(imageResult.content.at(-1)).toEqual({
      type: "text",
      text: "The MCP server reported an error and sent no message.",
    });

    const structuredOnly = tool({
      call: async () => ({ content: [], structuredContent: { z: 1, a: [true] }, isError: false }),
    });
    await expect(
      structuredOnly.execute("call-structured", {}, new AbortController().signal),
    ).resolves.toEqual({
      content: [notice, { type: "text", text: '{"a":[true],"z":1}' }],
      details: {},
      structuredContent: { z: 1, a: [true] },
    });
  });

  it("never leaks thrown host detail", async () => {
    const broken = tool({ call: async () => Promise.reject(new Error("token=secret")) });
    await expect(broken.execute("call-3", {}, new AbortController().signal)).rejects.toThrow(
      "The MCP tool call failed without a safe result.",
    );
  });

  it("cuts a 1 MB result in the middle for the model and saves the whole of it (VC-469)", async () => {
    const lines = Array.from({ length: 16_384 }, (_, index) => `line ${index} ${"x".repeat(56)}`);
    const whole = lines.join("\n");
    expect(Buffer.byteLength(whole)).toBeGreaterThan(1_000_000);
    const output = store();
    const registered = tool(
      {
        call: async () => ({
          content: [{ type: "text", text: whole }],
          structuredContent: { rows: 16_384 },
          isError: false,
        }),
      },
      { output },
    );

    const result = await registered.execute("call/1 MB", {}, new AbortController().signal);

    const shown = (result.content[1] as { text: string }).text;
    expect(result.content[0]).toEqual(notice);
    expect(Buffer.byteLength(shown)).toBeLessThan(MCP_RESULT_INLINE_MAX_BYTES + 1_024);
    expect(shown).toMatch(
      /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: 16384\n\nline 0 /u,
    );
    expect(shown).toMatch(/…\d+ chars truncated…/u);
    expect(shown).toContain("line 16383 ");
    const path = result.details.output?.fullOutputPath;
    expect(path).toEqual(expect.stringContaining(join("session.tool-output", "call_1_MB.")));
    expect(shown).toContain(
      `[Full output: ${path} (read it with offset/limit; the output starts at line 3)]`,
    );
    expect(shown).not.toContain("Some lines");
    expect(result.details).toEqual({
      output: {
        totalBytes: Buffer.byteLength(whole),
        totalLines: 16_384,
        removedChars: expect.any(Number),
        fullOutputPath: path,
        savedBytes: Buffer.byteLength(whole),
      },
    });
    // The structured half is untouched by the cut.
    expect(result.structuredContent).toEqual({ rows: 16_384 });
    // The file holds the whole text, behind a line that says what it is.
    const saved = readFileSync(path!, "utf8");
    expect(
      saved.startsWith(`${SAVED_TOOL_OUTPUT_WARNING} Tool: ${definition().providerName}.`),
    ).toBe(true);
    expect(saved.endsWith(`\n\n${whole}`)).toBe(true);
  });

  it("still cuts when there is nowhere to save, and says so", async () => {
    const registered = tool({
      call: async () => ({
        content: [
          { type: "text", text: "a".repeat(MCP_RESULT_INLINE_MAX_BYTES) },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "text", text: "b".repeat(10) },
        ],
        isError: false,
      }),
    });
    const result = await registered.execute("call-unsaved", {}, new AbortController().signal);

    // One joined text block, then the image, behind the notice.
    expect(result.content.map((block) => block.type)).toEqual(["text", "text", "image"]);
    expect((result.content[1] as { text: string }).text).toContain(
      "[The full output could not be saved: this Session has no storage for it.]",
    );
    expect(result.details.output).toMatchObject({ fullOutputPath: null, savedBytes: 0 });
  });

  it("leaves off structured content over the outer bound, and says how large it was", async () => {
    const huge = { blob: "x".repeat(MCP_RESULT_MAX_BYTES) };
    const registered = tool({
      call: async () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: huge,
        isError: false,
      }),
    });
    const result = await registered.execute("call-huge", {}, new AbortController().signal);

    const bytes = Buffer.byteLength(JSON.stringify(huge));
    expect("structuredContent" in result).toBe(false);
    expect(result.details).toEqual({ structuredContentOmittedBytes: bytes });
    expect(result.content).toEqual([
      notice,
      { type: "text", text: "ok" },
      {
        type: "text",
        text: "[The structured content (8.0 MiB of JSON) is over the 8.0 MiB limit on one result and is not kept with it.]",
      },
    ]);
  });

  it("passes a small image untouched and fits one over read's bound the way read does", async () => {
    const big = await sharp({
      create: { width: 3_000, height: 3_000, channels: 3, background: "#3a7" },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(big.toString("base64").length).toBeGreaterThan(MAX_READ_IMAGE_BASE64_BYTES);
    const registered = tool({
      call: async () => ({
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "image", data: big.toString("base64"), mimeType: "image/png" },
          {
            type: "image",
            data: "x".repeat(MAX_READ_IMAGE_BASE64_BYTES + 4),
            mimeType: "image/png",
          },
        ],
        isError: false,
      }),
    });
    const result = await registered.execute("call-images", {}, new AbortController().signal);

    expect(result.content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    const fitted = result.content[2] as { type: string; data: string; mimeType: string };
    expect(fitted).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(fitted.data.length).toBeLessThanOrEqual(MAX_READ_IMAGE_BASE64_BYTES);
    expect(result.content.slice(3)).toEqual([
      { type: "text", text: "[Image recompressed as JPEG to fit provider limits.]" },
      { type: "text", text: expect.stringMatching(/^\[Image: original 3000x3000, displayed at /u) },
      { type: "text", text: "[Image omitted: could not make a provider-safe copy.]" },
    ]);
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
