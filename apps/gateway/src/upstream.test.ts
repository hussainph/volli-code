import { describe, expect, test } from "vite-plus/test";

import {
  forwardedRequestHeaders,
  parseUpstreamBase,
  relayedResponseHeaders,
  upstreamUrl,
} from "./upstream.ts";

describe("parseUpstreamBase", () => {
  test.each([
    "https://api.anthropic.com",
    "https://openrouter.ai/api/v1",
    "https://llm.team.example:8443/v1/",
  ])("accepts %s", (up) => {
    expect(parseUpstreamBase(up)?.toString()).toBe(new URL(up).toString());
  });

  test.each([
    "not a url",
    "http://api.anthropic.com",
    "https://user:pass@api.anthropic.com",
    "https://api.anthropic.com/?q=1",
    "https://api.anthropic.com/#x",
    "https://127.0.0.1",
    "https://10.0.0.8/v1",
    "https://[::1]/",
    "https://localhost",
    "https://intranet",
    "https://gateway.localhost",
    "https://litellm.internal",
    "https://box.local",
    "https://router.home.arpa",
  ])("refuses %s", (up) => {
    expect(parseUpstreamBase(up)).toBeNull();
  });
});

const base = (up: string) => parseUpstreamBase(up)!;

describe("upstreamUrl", () => {
  test("appends the SDK's path and query to the base", () => {
    expect(
      upstreamUrl(base("https://api.anthropic.com"), "/v1/messages", "?beta=true")?.toString(),
    ).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(upstreamUrl(base("https://api.openai.com/v1/"), "/responses", "")?.toString()).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(upstreamUrl(base("https://openrouter.ai/api/v1"), "", "")?.toString()).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  test("refuses a path that climbs out of the base", () => {
    expect(
      upstreamUrl(base("https://openrouter.ai/api/v1"), "/%2e%2e/%2e%2e/admin", ""),
    ).toBeNull();
    expect(upstreamUrl(base("https://openrouter.ai/api/v1"), "1/x", "")).toBeNull();
  });

  test("refuses a path that changes the origin", () => {
    expect(upstreamUrl(base("https://api.anthropic.com"), "@evil.example/x", "")).toBeNull();
  });
});

test("forwarded request headers drop every grant carrier, hop-by-hop and edge header", () => {
  const out = forwardedRequestHeaders(
    new Headers({
      authorization: "Bearer grant",
      "x-api-key": "grant",
      "x-goog-api-key": "grant",
      cookie: "c",
      "content-length": "10",
      "accept-encoding": "gzip",
      connection: "keep-alive",
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "x-volli-call-id": "id",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching",
      "content-type": "application/json",
      session_id: "s",
    }),
  );
  expect(Object.fromEntries(out)).toEqual({
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "prompt-caching",
    "content-type": "application/json",
    session_id: "s",
  });
});

test("relayed response headers drop encoding, length, cookies and hop-by-hop headers", () => {
  const out = relayedResponseHeaders(
    new Headers({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": "5",
      "set-cookie": "a=b",
      "retry-after": "3",
      "request-id": "req_1",
    }),
  );
  expect(Object.fromEntries(out)).toEqual({
    "content-type": "text/event-stream",
    "retry-after": "3",
    "request-id": "req_1",
  });
});
