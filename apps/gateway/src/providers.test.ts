import { describe, expect, test } from "vite-plus/test";

import { PROVIDER_ADAPTERS } from "./providers.ts";

describe("anthropic-messages", () => {
  const adapter = PROVIDER_ADAPTERS["anthropic-messages"];

  test("sends the key as x-api-key, relays only model endpoints and leaves the body alone", () => {
    expect(adapter.authHeaders("k")).toEqual({ "x-api-key": "k" });
    expect(adapter.endpoints).toEqual({
      "/v1/messages": "POST",
      "/v1/messages/count_tokens": "POST",
      "/v1/models": "GET",
    });
    expect(adapter.editBody).toBeUndefined();
  });

  test("reads message_start, then the cumulative message_delta", () => {
    const meter = adapter.meter();
    meter.event({
      type: "message_start",
      message: {
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 2000,
          output_tokens: 1,
        },
      },
    });
    expect(meter.complete).toBe(false);
    meter.event({ type: "content_block_delta", delta: { text: "hi" } });
    meter.event({ type: "message_delta", usage: { output_tokens: 42 } });
    expect(meter.complete).toBe(true);
    expect(meter.modelId).toBe("claude-sonnet-4-5");
    expect(meter.usage).toEqual({ input: 12, output: 42, cacheRead: 2000, cacheWrite: 100 });
  });

  test("a message_delta that restates input counts wins field by field", () => {
    const meter = adapter.meter();
    meter.event({
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 1 } },
    });
    meter.event({
      type: "message_delta",
      usage: { input_tokens: 6, output_tokens: 9, cache_read_input_tokens: -1 },
    });
    expect(meter.usage).toEqual({ input: 6, output: 9 });
  });

  test("ignores events without usage and malformed payloads", () => {
    const meter = adapter.meter();
    meter.event(null);
    meter.event({ type: "message_start", message: { model: "" } });
    meter.event({ type: "message_delta" });
    expect(meter.complete).toBe(false);
    expect(meter.modelId).toBeUndefined();
    expect(meter.usage).toEqual({});
  });

  test("reads a non-streaming message", () => {
    const meter = adapter.meter();
    meter.json({ model: "claude-haiku-4-5", usage: { input_tokens: 3, output_tokens: 4 } });
    expect(meter.complete).toBe(true);
    expect(meter.usage).toEqual({ input: 3, output: 4 });
    const empty = adapter.meter();
    empty.json({ type: "error" });
    expect(empty.complete).toBe(false);
  });
});

describe("openai-responses", () => {
  const adapter = PROVIDER_ADAPTERS["openai-responses"];

  test("sends a bearer key, relays only model endpoints and leaves the body alone", () => {
    expect(adapter.authHeaders("k")).toEqual({ authorization: "Bearer k" });
    expect(adapter.endpoints).toEqual({ "/responses": "POST", "/models": "GET" });
    expect(adapter.editBody).toBeUndefined();
  });

  test.each(["response.completed", "response.incomplete", "response.failed"])(
    "reads %s",
    (type) => {
      const meter = adapter.meter();
      meter.event({ type: "response.created", response: { model: "gpt-5" } });
      meter.event({ type: "response.output_text.delta", delta: "x" });
      expect(meter.complete).toBe(false);
      meter.event({
        type,
        response: {
          model: "gpt-5-2026",
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 800 },
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 30 },
          },
        },
      });
      expect(meter.complete).toBe(true);
      expect(meter.modelId).toBe("gpt-5-2026");
      expect(meter.usage).toEqual({ input: 200, output: 50, cacheRead: 800, reasoning: 30 });
    },
  );

  test("a terminal event without usage stays incomplete", () => {
    const meter = adapter.meter();
    meter.event({ type: "response.completed", response: {} });
    expect(meter.complete).toBe(false);
  });

  test("reads a non-streaming response", () => {
    const meter = adapter.meter();
    meter.json({ model: "gpt-5", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(meter.usage).toEqual({ input: 10, output: 2 });
  });
});

describe("openai-completions", () => {
  const adapter = PROVIDER_ADAPTERS["openai-completions"];
  const editBody = (body: unknown) => adapter.editBody!(body);

  test("sends a bearer key and relays only model endpoints", () => {
    expect(adapter.authHeaders("k")).toEqual({ authorization: "Bearer k" });
    expect(adapter.endpoints).toEqual({ "/chat/completions": "POST", "/models": "GET" });
  });

  test("asks a stream for its usage, keeping other stream options", () => {
    expect(editBody({ model: "m", stream: true })).toEqual({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(editBody({ stream: true, stream_options: { include_obfuscation: false } })).toEqual({
      stream: true,
      stream_options: { include_obfuscation: false, include_usage: true },
    });
  });

  test("leaves a body alone when it already asks, or does not stream", () => {
    expect(editBody({ stream: true, stream_options: { include_usage: true } })).toBeNull();
    expect(editBody({ stream: false })).toBeNull();
    expect(editBody("not an object")).toBeNull();
  });

  test("reads the final usage chunk, OpenRouter's cost and cache writes included", () => {
    const meter = adapter.meter();
    meter.event({
      model: "anthropic/claude-sonnet-4.5",
      choices: [{ delta: { content: "x" } }],
      usage: null,
    });
    expect(meter.complete).toBe(false);
    meter.event({
      model: "anthropic/claude-sonnet-4.5",
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
        completion_tokens_details: { reasoning_tokens: 5 },
        cost: 0.0123,
      },
    });
    expect(meter.complete).toBe(true);
    expect(meter.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(meter.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 600,
      cacheWrite: 300,
      reasoning: 5,
      upstreamCostUsd: 0.0123,
    });
  });

  test("drops counts that are not non-negative integers", () => {
    const meter = adapter.meter();
    meter.json({ usage: { prompt_tokens: 1.5, completion_tokens: 3, cost: -1 } });
    expect(meter.usage).toEqual({ output: 3 });
  });

  test("never reports negative uncached input", () => {
    const meter = adapter.meter();
    meter.json({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } });
    expect(meter.usage).toEqual({ input: 0, cacheRead: 20 });
  });
});
