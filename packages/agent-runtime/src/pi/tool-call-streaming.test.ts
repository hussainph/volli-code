import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  parseStreamingJson,
  parseStreamingToolArguments,
} from "@earendil-works/pi-ai/utils/json-parse";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessageEvent, Model, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

/**
 * VC-1074: pi-ai re-parsed a tool call's whole accumulated argument JSON on
 * every streamed delta, so a large `write` cost seconds of synchronous CPU on
 * Electron main. The patch (patches/@earendil-works__pi-ai@1.0.0.patch) keeps
 * small calls parsing on every delta and refreshes large ones geometrically.
 * These cases drive the real Anthropic adapter through the real SDK and SSE
 * codec, with only `fetch` replaced.
 */

const model: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
};

/** File text with the characters a partial parse must survive mid-escape. */
function fileText(chars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < chars; index += 1) {
    const line = `line ${index}: "quoted" \\ back\tslash \u00e9\u4e2d ${"x".repeat(index % 17)}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n").slice(0, chars);
}

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One Anthropic response that streams `json` as `write` arguments, `step` chars per delta. */
function toolCallResponse(json: string, step: number): Response {
  let body = sse("message_start", {
    type: "message_start",
    message: { id: "msg_1", model: model.id, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  body += sse("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "write", input: {} },
  });
  for (let offset = 0; offset < json.length; offset += step) {
    body += sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: json.slice(offset, offset + step) },
    });
  }
  body += sse("content_block_stop", { type: "content_block_stop", index: 0 });
  body += sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 5 },
  });
  body += sse("message_stop", { type: "message_stop" });
  const bytes = new TextEncoder().encode(body);
  // Network-sized reads, so one read carries many deltas back to back.
  const chunk = 16 * 1024;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunk) {
          controller.enqueue(bytes.slice(offset, offset + chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

interface StreamedCall {
  /** Each `toolcall_delta`'s delta and the partial arguments it carried. */
  deltas: Array<{ delta: string; arguments: ToolCall["arguments"] }>;
  final: ToolCall;
  eventTypes: string[];
}

async function streamToolCall(json: string, step = 30): Promise<StreamedCall> {
  const events = anthropicStream(
    model,
    normalizeContext({
      systemPrompt: "",
      messages: [{ role: "user", content: "write it", timestamp: 0 }],
      tools: [],
    }),
    { apiKey: "sk-ant-test", fetch: (async () => toolCallResponse(json, step)) as typeof fetch },
  );
  const deltas: StreamedCall["deltas"] = [];
  const eventTypes: string[] = [];
  let final: ToolCall | undefined;
  for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
    eventTypes.push(event.type);
    if (event.type === "error") throw new Error(event.error.errorMessage);
    if (event.type === "toolcall_delta") {
      const block = event.partial.content[event.contentIndex] as ToolCall;
      deltas.push({ delta: event.delta, arguments: block.arguments });
    }
    if (event.type === "toolcall_end") final = event.toolCall;
  }
  if (final === undefined) throw new Error("the stream ended without a tool call");
  return { deltas, final, eventTypes };
}

describe("streamed tool-call arguments (VC-1074)", () => {
  it("parses every delta of a normal-sized call exactly as upstream did", async () => {
    const args = { path: "small.txt", content: fileText(6 * 1024) };
    const json = JSON.stringify(args);
    const streamed = await streamToolCall(json);

    let prefix = "";
    for (const { delta, arguments: partial } of streamed.deltas) {
      prefix += delta;
      expect(JSON.stringify(partial)).toBe(JSON.stringify(parseStreamingJson(prefix)));
    }
    expect(prefix).toBe(json);
    expect(JSON.stringify(streamed.final.arguments)).toBe(json);
    expect(streamed.final).not.toHaveProperty("partialJson");
  });

  it("streams a 100 KB write with identical events and final arguments, re-parsing linearly", async () => {
    const args = { path: "big.txt", content: fileText(100 * 1024) };
    const json = JSON.stringify(args);
    const streamed = await streamToolCall(json);

    // The event sequence is the one upstream emits: one delta per wire delta.
    const wireDeltas = Math.ceil(json.length / 30);
    expect(streamed.deltas).toHaveLength(wireDeltas);
    expect(streamed.eventTypes.filter((type) => type === "toolcall_delta")).toHaveLength(
      wireDeltas,
    );
    expect(streamed.deltas.map(({ delta }) => delta).join("")).toBe(json);
    expect(streamed.final.arguments).toEqual(args);
    expect(JSON.stringify(streamed.final.arguments)).toBe(json);

    // Each re-parse produces a fresh object. Upstream re-parsed on every delta
    // (3,000+ whole-buffer parses here); now past 8 KiB the buffer must grow
    // by an eighth before the next one, so the count is logarithmic in size.
    const parses = new Set(streamed.deltas.map((entry) => entry.arguments)).size;
    const eagerDeltas = Math.ceil((8 * 1024) / 30);
    expect(parses).toBeLessThan(eagerDeltas + 40);

    // Every partial view is exactly upstream's parse of the prefix it was
    // taken at: stale at most, never different. The last is at most an
    // eighth behind the stream.
    let prefix = "";
    let parsedAt = 0;
    let previous: unknown;
    for (const { delta, arguments: partial } of streamed.deltas) {
      prefix += delta;
      if (partial === previous) continue;
      previous = partial;
      parsedAt = prefix.length;
      expect(JSON.stringify(partial)).toBe(JSON.stringify(parseStreamingJson(prefix)));
    }
    expect(parsedAt).toBeGreaterThan((json.length * 7) / 8);
  });
});

describe("parseStreamingToolArguments", () => {
  it("parses on every call up to the eager bound", () => {
    const block = { arguments: {} as Record<string, unknown> };
    const json = JSON.stringify({ content: "a".repeat(8 * 1024 - 20) });
    for (let end = 1; end <= json.length; end += 500) {
      const partial = json.slice(0, end);
      block.arguments = parseStreamingToolArguments(block, partial);
      expect(block.arguments).toEqual(parseStreamingJson(partial));
    }
  });

  it("past the bound, re-parses only after the buffer grows by an eighth", () => {
    const block = { arguments: {} as Record<string, unknown> };
    const json = JSON.stringify({ content: "b".repeat(64 * 1024) });

    const first = json.slice(0, 16 * 1024);
    block.arguments = parseStreamingToolArguments(block, first);
    expect(block.arguments).toEqual(parseStreamingJson(first));

    const held = block.arguments;
    const tooSoon = json.slice(0, 16 * 1024 + 2 * 1024 - 1);
    expect(parseStreamingToolArguments(block, tooSoon)).toBe(held);

    const due = json.slice(0, 16 * 1024 + 2 * 1024);
    block.arguments = parseStreamingToolArguments(block, due);
    expect(block.arguments).not.toBe(held);
    expect(block.arguments).toEqual(parseStreamingJson(due));
  });

  it("tracks each block on its own and treats empty input as upstream does", () => {
    const json = JSON.stringify({ content: "c".repeat(20 * 1024) });
    const one = { arguments: {} as Record<string, unknown> };
    const two = { arguments: {} as Record<string, unknown> };
    one.arguments = parseStreamingToolArguments(one, json);
    // A fresh block parses its first large buffer even though another block
    // already parsed one of the same length.
    expect(parseStreamingToolArguments(two, json)).toEqual(JSON.parse(json));
    expect(parseStreamingToolArguments({ arguments: {} }, "")).toEqual({});
    expect(parseStreamingToolArguments({ arguments: {} }, undefined)).toEqual({});
  });
});
