import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import {
  StreamingJsonParser,
  ToolCallArgumentsStream,
} from "@earendil-works/pi-ai/utils/streaming-json";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessageEvent, Model, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

/**
 * VC-1074: pi-ai re-parsed a tool call's whole accumulated argument JSON on
 * every streamed delta, so a large `write` cost seconds of synchronous CPU on
 * Electron main. Pi 1.5's upstream incremental parser replaces our geometric
 * re-parse patch: each delta is read once, with one full parse at block end.
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

function pieces(json: string, step = 30): string[] {
  const deltas: string[] = [];
  for (let offset = 0; offset < json.length; offset += step) {
    deltas.push(json.slice(offset, offset + step));
  }
  return deltas;
}

/** Independent prefix oracle for these compact `{path, content}` fixtures. */
function expectedWritePrefix(prefix: string): ToolCall["arguments"] {
  const expected = parseStreamingJson<ToolCall["arguments"]>(prefix);
  // Unlike the old partial-json fallback, Pi 1.5 correctly keeps trailing
  // spaces inside an open string. Compact fixture JSON has no other raw spaces.
  if (typeof expected.content === "string") {
    expected.content += / +$/.exec(prefix)?.[0] ?? "";
  }
  return expected;
}

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Interleaved tool blocks; Anthropic indices deliberately differ from content indices. */
function toolCallResponse(calls: string[][]): Response {
  let body = sse("message_start", {
    type: "message_start",
    message: { id: "msg_1", model: model.id, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  for (let index = 0; index < calls.length; index += 1) {
    body += sse("content_block_start", {
      type: "content_block_start",
      index: index * 2 + 1,
      content_block: { type: "tool_use", id: `toolu_${index + 1}`, name: "write", input: {} },
    });
  }
  const rounds = Math.max(...calls.map((deltas) => deltas.length));
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < calls.length; index += 1) {
      const delta = calls[index][round];
      if (delta === undefined) continue;
      body += sse("content_block_delta", {
        type: "content_block_delta",
        index: index * 2 + 1,
        delta: { type: "input_json_delta", partial_json: delta },
      });
    }
  }
  for (let index = 0; index < calls.length; index += 1) {
    body += sse("content_block_stop", { type: "content_block_stop", index: index * 2 + 1 });
  }
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

interface StreamedCalls {
  /** References, not copies: post-stream assertions also catch mutated partial views. */
  deltas: Array<{ contentIndex: number; delta: string; arguments: ToolCall["arguments"] }>;
  finals: ToolCall[];
  eventTypes: string[];
}

async function streamToolCalls(calls: string[][]): Promise<StreamedCalls> {
  const events = anthropicStream(
    model,
    normalizeContext({
      systemPrompt: "",
      messages: [{ role: "user", content: "write it", timestamp: 0 }],
      tools: [],
    }),
    { apiKey: "sk-ant-test", fetch: (async () => toolCallResponse(calls)) as typeof fetch },
  );
  const deltas: StreamedCalls["deltas"] = [];
  const finals: ToolCall[] = [];
  const eventTypes: string[] = [];
  for await (const event of events as AsyncIterable<AssistantMessageEvent>) {
    eventTypes.push(event.type);
    if (event.type === "error") throw new Error(event.error.errorMessage);
    if (event.type === "toolcall_delta") {
      const block = event.partial.content[event.contentIndex] as ToolCall;
      deltas.push({
        contentIndex: event.contentIndex,
        delta: event.delta,
        arguments: block.arguments,
      });
    }
    if (event.type === "toolcall_end") finals.push(event.toolCall);
  }
  expect(finals).toHaveLength(calls.length);
  return { deltas, finals, eventTypes };
}

function singleCallEventTypes(deltaCount: number): string[] {
  return [
    "start",
    "toolcall_start",
    ...Array(deltaCount).fill("toolcall_delta"),
    "toolcall_end",
    "done",
  ];
}

describe("streamed tool-call arguments (VC-1074)", () => {
  it("shows the exact prefix at every delta of a normal-sized call", async () => {
    const args = { path: "small.txt", content: fileText(6 * 1024) };
    const json = JSON.stringify(args);
    const streamed = await streamToolCalls([pieces(json)]);

    let prefix = "";
    for (const { delta, arguments: partial } of streamed.deltas) {
      prefix += delta;
      expect(partial).toEqual(expectedWritePrefix(prefix));
    }
    expect(prefix).toBe(json);
    expect(streamed.eventTypes).toEqual(singleCallEventTypes(pieces(json).length));
    expect(JSON.stringify(streamed.finals[0].arguments)).toBe(json);
    expect(streamed.finals[0]).not.toHaveProperty("partialJson");
    expect(streamed.finals[0]).not.toHaveProperty("argumentsError");
  });

  it("streams a 100 KB write with identical events and final arguments, reading each delta once", async () => {
    const args = { path: "big.txt", content: fileText(100 * 1024) };
    const json = JSON.stringify(args);
    const wireDeltas = pieces(json);
    const append = vi.spyOn(StreamingJsonParser.prototype, "append");
    const finish = vi.spyOn(ToolCallArgumentsStream.prototype, "finish");
    try {
      const streamed = await streamToolCalls([wireDeltas]);

      expect(streamed.deltas.map(({ delta }) => delta)).toEqual(wireDeltas);
      expect(streamed.eventTypes).toEqual(singleCallEventTypes(wireDeltas.length));
      expect(streamed.finals[0].arguments).toEqual(args);
      expect(JSON.stringify(streamed.finals[0].arguments)).toBe(json);
      expect(streamed.finals[0]).not.toHaveProperty("partialJson");
      expect(streamed.finals[0]).not.toHaveProperty("argumentsError");

      // Observe the installed parser through the real provider, not a test-only
      // feeder. Old accumulated prefixes would process O(n²) characters here.
      // Incremental parsing must receive precisely the wire deltas, once each,
      // on one parser, followed by one full final parse. No timing thresholds.
      expect(append.mock.calls.map(([delta]) => delta)).toEqual(wireDeltas);
      expect(append.mock.calls.reduce((sum, [delta]) => sum + delta.length, 0)).toBe(json.length);
      expect(new Set(append.mock.contexts).size).toBe(1);
      expect(finish).toHaveBeenCalledTimes(1);

      // A large string now stays fresh rather than coalescing geometrically.
      // Sample exact, immutable views beyond the old 8 KiB eager bound without
      // making this regression test itself re-parse O(n²) characters.
      for (const index of [300, Math.floor(wireDeltas.length / 2), wireDeltas.length - 1]) {
        const prefix = json.slice(0, Math.min((index + 1) * 30, json.length));
        expect(streamed.deltas[index].arguments).toEqual(expectedWritePrefix(prefix));
      }
    } finally {
      append.mockRestore();
      finish.mockRestore();
    }
  });

  it("keeps nested partial views immutable across split escapes and scalar tokens", async () => {
    const deltas = [
      '{"edits":[{"text":"first ',
      "\\",
      "u00",
      "e9\\n",
      'line"},{"text":"second',
      '"}],"meta":{"ok":t',
      'rue,"count":1',
      "2}}",
    ];
    const streamed = await streamToolCalls([deltas]);
    const first = { text: "first é\nline" };
    const edits = [first, { text: "second" }];
    expect(streamed.deltas.map((entry) => entry.arguments)).toEqual([
      { edits: [{ text: "first " }] },
      { edits: [{ text: "first " }] },
      { edits: [{ text: "first " }] },
      { edits: [{ text: "first é\n" }] },
      { edits },
      { edits, meta: { ok: true } },
      { edits, meta: { ok: true, count: 1 } },
      { edits, meta: { ok: true, count: 12 } },
    ]);
    expect(streamed.finals[0].arguments).toEqual(JSON.parse(deltas.join("")));
  });

  it("tracks interleaved tool blocks independently", async () => {
    const one = { path: "one.txt", content: "a".repeat(20 * 1024) };
    const two = { path: "two.txt", content: "b".repeat(20 * 1024) };
    const calls = [pieces(JSON.stringify(one), 1024), pieces(JSON.stringify(two), 1024)];
    const streamed = await streamToolCalls(calls);

    expect(streamed.finals.map((call) => call.arguments)).toEqual([one, two]);
    expect(streamed.finals.map((call) => call.id)).toEqual(["toolu_1", "toolu_2"]);
    for (let contentIndex = 0; contentIndex < calls.length; contentIndex += 1) {
      const deltas = streamed.deltas.filter((entry) => entry.contentIndex === contentIndex);
      expect(deltas.map((entry) => entry.delta)).toEqual(calls[contentIndex]);
      let prefix = "";
      for (const { delta, arguments: partial } of deltas) {
        prefix += delta;
        expect(partial).toEqual(expectedWritePrefix(prefix));
      }
    }
  });

  it.each([
    { name: "no deltas", deltas: [] },
    { name: "an empty delta", deltas: [""] },
    { name: "whitespace", deltas: [" \t\r\n "] },
    { name: "an empty object", deltas: ["{}"] },
  ])("accepts $name as empty arguments", async ({ deltas }) => {
    const streamed = await streamToolCalls([deltas]);
    expect(streamed.eventTypes).toEqual(singleCallEventTypes(deltas.length));
    expect(streamed.deltas.map((entry) => entry.arguments)).toEqual(deltas.map(() => ({})));
    expect(streamed.finals[0].arguments).toEqual({});
    expect(streamed.finals[0]).not.toHaveProperty("argumentsError");
  });

  it.each(['{"path":"unfinished.txt","content":"partial', "[]", "null", "42"])(
    "reports malformed final arguments instead of executing a partial prefix: %s",
    async (json) => {
      const streamed = await streamToolCalls([pieces(json)]);
      expect(streamed.eventTypes).toEqual(singleCallEventTypes(pieces(json).length));
      expect(streamed.finals[0].arguments).toEqual({});
      expect(streamed.finals[0].argumentsError).toContain(`Received arguments:\n${json}`);
      if (json.startsWith("{")) {
        expect(streamed.deltas.at(-1)?.arguments).toEqual({
          path: "unfinished.txt",
          content: "partial",
        });
      }
    },
  );
});
