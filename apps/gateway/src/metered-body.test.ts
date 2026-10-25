import { expect, test, vi } from "vite-plus/test";

import { sse, streamOf } from "../test/support.ts";
import { MAX_METERED_JSON_BYTES, meteredBody } from "./metered-body.ts";
import { PROVIDER_ADAPTERS, type UsageMeter } from "./providers.ts";

const timing = (times: number[]) => ({ startedAt: 100, now: () => times.shift() ?? 999 });

test("streams the upstream bytes through unchanged and meters SSE usage", async () => {
  const body = sse([
    {
      event: "message_start",
      data: { type: "message_start", message: { model: "m", usage: { input_tokens: 2 } } },
    },
    { event: "ping", data: "not json" },
    { event: "message_delta", data: { type: "message_delta", usage: { output_tokens: 7 } } },
  ]);
  const meter = PROVIDER_ADAPTERS["anthropic-messages"].meter();
  const metered = meteredBody(
    streamOf([body.slice(0, 40), body.slice(40)]),
    "text/event-stream; charset=utf-8",
    meter,
    timing([130]),
  );
  expect(await new Response(metered.body).text()).toBe(body);
  expect(await metered.outcome).toEqual({ finished: true, ttftMs: 30 });
  expect(meter.usage).toEqual({ input: 2, output: 7 });
});

test("meters a JSON body at its end", async () => {
  const meter = PROVIDER_ADAPTERS["openai-responses"].meter();
  const metered = meteredBody(
    streamOf(['{"model":"gpt-5","usage":', '{"input_tokens":4,"output_tokens":1}}']),
    "application/json",
    meter,
    timing([101]),
  );
  await new Response(metered.body).text();
  expect(await metered.outcome).toEqual({ finished: true, ttftMs: 1 });
  expect(meter.usage).toEqual({ input: 4, output: 1 });
});

test("a JSON body that is not JSON, or too large, is relayed unmetered", async () => {
  const meter = PROVIDER_ADAPTERS["openai-responses"].meter();
  const bad = meteredBody(streamOf(["{"]), "application/json", meter, timing([]));
  expect(await new Response(bad.body).text()).toBe("{");
  expect(meter.complete).toBe(false);

  const json = vi.fn();
  const big = new Uint8Array(MAX_METERED_JSON_BYTES + 1).fill(32);
  const huge = meteredBody(
    new ReadableStream({
      start: (c) => (c.enqueue(big), c.enqueue(new Uint8Array([32])), c.close()),
    }),
    "application/json",
    { json, event: vi.fn(), complete: false, usage: {}, modelId: undefined },
    timing([]),
  );
  expect((await new Response(huge.body).arrayBuffer()).byteLength).toBe(MAX_METERED_JSON_BYTES + 2);
  expect(json).not.toHaveBeenCalled();
});

test("other content types pass through without metering", async () => {
  const meter = PROVIDER_ADAPTERS["anthropic-messages"].meter();
  const metered = meteredBody(streamOf(["plain"]), "text/plain", meter, timing([]));
  expect(await new Response(metered.body).text()).toBe("plain");
  expect((await metered.outcome).finished).toBe(true);
});

test("a downstream cancel cancels the upstream read and settles unfinished", async () => {
  const cancel = vi.fn();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          sse([{ data: { type: "message_start", message: { usage: { input_tokens: 9 } } } }]),
        ),
      );
    },
    cancel,
  });
  const meter = PROVIDER_ADAPTERS["anthropic-messages"].meter();
  const metered = meteredBody(upstream, "text/event-stream", meter, timing([105]));
  const reader = metered.body.getReader();
  await reader.read();
  await reader.cancel("runner stopped");
  expect(cancel).toHaveBeenCalledWith("runner stopped");
  expect(await metered.outcome).toEqual({ finished: false, ttftMs: 5 });
  expect(meter.usage).toEqual({ input: 9 });
});

test("an upstream failure errors the body and settles unfinished, once", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("reset"));
    },
  });
  const metered = meteredBody(
    upstream,
    "text/event-stream",
    PROVIDER_ADAPTERS["anthropic-messages"].meter(),
    timing([]),
  );
  await expect(new Response(metered.body).text()).rejects.toThrow("reset");
  expect(await metered.outcome).toEqual({ finished: false });
});

test("a meter that throws never fails the call", async () => {
  const meter: UsageMeter = {
    event: () => {
      throw new Error("meter bug");
    },
    json: () => {},
    complete: false,
    usage: {},
    modelId: undefined,
  };
  const throwingEnd = meteredBody(
    streamOf(["data: {}\n\n"]),
    "text/event-stream",
    meter,
    timing([]),
  );
  expect(await new Response(throwingEnd.body).text()).toBe("data: {}\n\n");
  expect((await throwingEnd.outcome).finished).toBe(true);

  // A tail event dispatched at end() throws inside sink.end().
  const tail = meteredBody(streamOf(["data: {}"]), "text/event-stream", meter, timing([]));
  expect(await new Response(tail.body).text()).toBe("data: {}");
  expect((await tail.outcome).finished).toBe(true);
});

test("a cancel while a read is pending settles once and leaves the stream quiet", async () => {
  let release!: () => void;
  const upstream = new ReadableStream<Uint8Array>({
    pull: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const metered = meteredBody(
    upstream,
    "text/event-stream",
    PROVIDER_ADAPTERS["anthropic-messages"].meter(),
    timing([]),
  );
  const reader = metered.body.getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reader.cancel("stop");
  release();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(await metered.outcome).toEqual({ finished: false });
});

test("an upstream read that fails after a cancel settles only once", async () => {
  let fail!: (error: Error) => void;
  const failing = {
    getReader: () => ({
      read: () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
          fail = reject;
        }),
      cancel: async () => {},
    }),
  } as unknown as ReadableStream<Uint8Array>;
  const metered = meteredBody(
    failing,
    "text/event-stream",
    PROVIDER_ADAPTERS["anthropic-messages"].meter(),
    timing([]),
  );
  const reader = metered.body.getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reader.cancel("stop");
  fail(new Error("late"));
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(await metered.outcome).toEqual({ finished: false });
});
