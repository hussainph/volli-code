import { afterEach, expect, test, vi } from "vite-plus/test";

import { batch } from "../test/support.ts";
import { consumeUsage } from "./usage-consumer.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

test("without an ingest URL the stub logs a count and acknowledges", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const fetchFn = vi.fn();
  const delivered = batch([{ callId: "a", usage: { input: 1 } }, { callId: "b" }]);
  await consumeUsage(delivered, {}, fetchFn);
  expect(delivered.acked).toBe(true);
  expect(fetchFn).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("2 record(s)"));
  expect(JSON.stringify(log.mock.calls)).not.toContain("callId");
});

test("posts the batch to the ingest endpoint with its token and acknowledges on success", async () => {
  const fetchFn = vi.fn(async () => new Response("ok"));
  const delivered = batch([{ callId: "a" }]);
  await consumeUsage(
    delivered,
    { USAGE_INGEST_URL: "https://backend.example/usage", USAGE_INGEST_TOKEN: "t" },
    fetchFn,
  );
  expect(delivered.acked).toBe(true);
  expect(fetchFn).toHaveBeenCalledWith("https://backend.example/usage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ records: [{ callId: "a" }] }),
  });
});

test("posts without a token when none is configured", async () => {
  const fetchFn = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  const delivered = batch([{ callId: "a" }]);
  await consumeUsage(delivered, { USAGE_INGEST_URL: "https://backend.example/usage" }, fetchFn);
  expect(delivered.acked).toBe(true);
  expect(fetchFn.mock.calls[0]![1]!.headers).toEqual({ "content-type": "application/json" });
});

test("retries the whole batch when the backend refuses or is unreachable", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const refused = batch([{ callId: "a" }]);
  await consumeUsage(
    refused,
    { USAGE_INGEST_URL: "https://backend.example/usage" },
    async () => new Response("no", { status: 503 }),
  );
  expect(refused.acked).toBe(false);
  expect(refused.retried).toEqual({ delaySeconds: 30 });

  const unreachable = batch([{ callId: "a" }]);
  await consumeUsage(
    unreachable,
    { USAGE_INGEST_URL: "https://backend.example/usage" },
    async () => {
      throw new TypeError("fetch failed");
    },
  );
  expect(unreachable.retried).toEqual({ delaySeconds: 30 });
  expect(error).toHaveBeenCalledTimes(2);
});
