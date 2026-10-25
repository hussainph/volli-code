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

test("never posts unauthenticated: an ingest URL without a token holds the batch", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchFn = vi.fn();
  const delivered = batch([{ callId: "a" }]);
  await consumeUsage(delivered, { USAGE_INGEST_URL: "https://backend.example/usage" }, fetchFn);
  expect(fetchFn).not.toHaveBeenCalled();
  expect(delivered.acked).toBe(false);
  expect(delivered.retried).toEqual({ delaySeconds: 30 });
  expect(error).toHaveBeenCalledWith(expect.stringContaining("without a token"));
});

test("retries the whole batch when the backend refuses or is unreachable", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const refused = batch([{ callId: "a" }]);
  await consumeUsage(
    refused,
    { USAGE_INGEST_URL: "https://backend.example/usage", USAGE_INGEST_TOKEN: "t" },
    async () => new Response("no", { status: 503 }),
  );
  expect(refused.acked).toBe(false);
  expect(refused.retried).toEqual({ delaySeconds: 30 });

  const unreachable = batch([{ callId: "a" }]);
  await consumeUsage(
    unreachable,
    { USAGE_INGEST_URL: "https://backend.example/usage", USAGE_INGEST_TOKEN: "t" },
    async () => {
      throw new TypeError("fetch failed");
    },
  );
  expect(unreachable.retried).toEqual({ delaySeconds: 30 });
  expect(error).toHaveBeenCalledTimes(2);
});
