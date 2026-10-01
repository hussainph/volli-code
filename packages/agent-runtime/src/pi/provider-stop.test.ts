import { describe, expect, it } from "vite-plus/test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderStopCapture, finalStopDetail, safeStopMessage } from "./provider-stop";
import { isTransientTransportFailure } from "./transcript";

const message = (extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  timestamp: 0,
  ...extra,
});

describe("provider stop facts", () => {
  it.each([
    ["refusal", "provider-refused"],
    ["sensitive", "provider-refused"],
    ["SAFETY", "provider-refused"],
    ["overloaded_error", "provider-overloaded"],
    ["rate_limit_error", "rate-limited"],
    ["usage_limit_reached", "rate-limited"],
    ["insufficient_quota", "rate-limited"],
    ["authentication_error", "auth-failed"],
    ["invalid_request_error", "bad-request"],
    ["context_length_exceeded", "context-overflow"],
    ["ECONNRESET", "network"],
    ["volli.stream-stalled", "runtime-stopped"],
    ["new_provider_code", "unknown"],
    ["__proto__", "unknown"],
  ])("maps %s from a provider field, not its sentence", (type, category) => {
    const capture = new ProviderStopCapture();
    capture.event({ type: "error", error: { type, message: "neutral sentence" } });
    expect(capture.detail(message())).toMatchObject({
      category,
      providerType: type,
      message: "neutral sentence",
    });
  });

  it.each([
    [401, "auth-failed"],
    [403, "auth-failed"],
    [429, "rate-limited"],
    [529, "provider-overloaded"],
    [503, "provider-overloaded"],
    [400, "bad-request"],
    [422, "bad-request"],
    [502, "unknown"],
  ])("uses the actual HTTP %s", (status, category) => {
    const capture = new ProviderStopCapture();
    capture.response({ status: status as number, headers: { authorization: "private" } }, 0);
    expect(capture.detail(message())).toMatchObject({ category, httpStatus: status });
    expect(JSON.stringify(capture.detail(message()))).not.toContain("private");
  });

  it("reads stream-native error envelopes and explicit stop reasons", () => {
    const capture = new ProviderStopCapture();
    capture.event({
      type: "response.failed",
      response: {
        error: { code: "usage_limit_reached", message: "Limit used", resets_at: 1800000000 },
      },
    });
    expect(capture.detail(message())).toMatchObject({
      category: "rate-limited",
      resetsAt: 1800000000000,
    });
    const anthropic = new ProviderStopCapture();
    anthropic.event({
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: { explanation: "Declined" } },
    });
    expect(anthropic.detail(message())).toMatchObject({
      category: "provider-refused",
      message: "Declined",
    });
    const openai = new ProviderStopCapture();
    openai.event({ type: "response.refusal.done", refusal: "Declined" });
    expect(openai.detail(message({ stopReason: "stop" }))).toMatchObject({
      category: "provider-refused",
      message: "Declined",
    });
    const incomplete = new ProviderStopCapture();
    incomplete.event({ response: { incomplete_details: { reason: "content_filter" } } });
    expect(incomplete.detail(message())).toMatchObject({ category: "provider-refused" });
  });

  it("parses SDK JSON envelopes, never classifies plain English or echoed request fields", () => {
    const capture = new ProviderStopCapture();
    expect(
      capture.detail(
        message({
          errorMessage:
            '401 {"error":{"type":"invalid_request_error","message":"Wrong key"},"request":{"secret":"private"}}',
        }),
      ),
    ).toMatchObject({ category: "auth-failed", httpStatus: 401, message: "Wrong key" });
    expect(
      new ProviderStopCapture().detail(
        message({ errorMessage: "refusal overload auth network context_length_exceeded 429" }),
      ),
    ).toMatchObject({ category: "unknown", httpStatus: null });
    expect(
      new ProviderStopCapture().detail(
        message({ errorMessage: '{"error":{},"request":{"secret":"private"}}' }),
      ).message,
    ).toBe("Provider error (no message stated).");
    expect(new ProviderStopCapture().detail(message({ errorMessage: "{oops}" })).category).toBe(
      "unknown",
    );
  });

  it("accepts direct SDK error bodies and Google's status field", () => {
    const direct = new ProviderStopCapture();
    direct.event({ type: "authentication_error", message: "Wrong key" });
    expect(direct.detail(message())).toMatchObject({
      category: "auth-failed",
      message: "Wrong key",
    });
    const google = new ProviderStopCapture();
    google.event({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many" } });
    expect(google.detail(message())).toMatchObject({
      category: "rate-limited",
      message: "Too many",
    });
  });

  it("records structured network diagnostics and does not keep their stacks", () => {
    const detail = new ProviderStopCapture().detail(
      message({
        diagnostics: [
          {
            type: "provider_transport_failure",
            timestamp: 0,
            error: { code: "ECONNRESET", message: "reset", stack: "private" },
          },
        ],
      }),
    );
    expect(detail.category).toBe("network");
    expect(JSON.stringify(detail)).not.toContain("private");
  });

  it("bounds and redacts message and type before storage", () => {
    const capture = new ProviderStopCapture();
    capture.event({
      error: {
        type: "a".repeat(100),
        message: `authorization: Bearer short token=secret123 cookie=abc api_key=tiny https://host/path?key=private sk-credential ${"x".repeat(500)}`,
      },
    });
    const detail = capture.detail(message());
    expect(detail.message!.length).toBeLessThanOrEqual(401);
    expect(detail.providerType!.length).toBeLessThanOrEqual(80);
    for (const secret of ["short", "secret123", "tiny", "abc", "private", "sk-credential"])
      expect(detail.message).not.toContain(secret);
    expect(safeStopMessage("a plain brace { in text")).toBe("a plain brace { in text");
  });

  it("keeps only provider-stated retry instants and current-request facts", () => {
    const capture = new ProviderStopCapture();
    capture.response({ status: 429, headers: { "retry-after": "60" } }, 1000);
    expect(capture.detail(message()).resetsAt).toBe(61000);
    capture.response(
      { status: 429, headers: { "retry-after": "Wed, 01 Jan 2031 00:00:00 GMT" } },
      1000,
    );
    expect(capture.detail(message()).resetsAt).toBe(Date.parse("2031-01-01T00:00:00Z"));
    capture.response({ status: 429, headers: { "retry-after": "not a date" } }, 1000);
    expect(capture.detail(message()).resetsAt).toBeNull();
    expect(new ProviderStopCapture().detail(message()).resetsAt).toBeNull();
  });

  it("preserves provider cause beside actual retry exhaustion, with an honest unknown fallback", () => {
    const unknown = new ProviderStopCapture().detail(message());
    expect(finalStopDetail(unknown, 0, null)).toMatchObject({
      category: "unknown",
      retry: "not-retried",
    });
    expect(finalStopDetail(unknown, 3, null)).toMatchObject({
      category: "retries-exhausted",
      retry: "exhausted",
    });
    const known = new ProviderStopCapture().detail(message({ rawStopReason: "overloaded_error" }));
    expect(finalStopDetail(known, 3, 1000)).toMatchObject({
      category: "provider-overloaded",
      retry: "exhausted",
      resetsAt: 1000,
    });
  });

  it("never automatically retries refusals or quotas just because their prose says retry", () => {
    for (const type of [
      "refusal",
      "usage_limit_reached",
      "insufficient_quota",
      "quota_exceeded",
      "authentication_error",
      "invalid_request_error",
      "context_length_exceeded",
    ]) {
      const stopDetail = new ProviderStopCapture().detail(message({ rawStopReason: type }));
      expect(
        isTransientTransportFailure({
          reason: "model",
          message: "You can retry your request",
          stopDetail,
        }),
      ).toBe(false);
    }
    for (const type of ["overloaded_error", "ECONNRESET", "volli.stream-stalled"]) {
      const stopDetail = new ProviderStopCapture().detail(message({ rawStopReason: type }));
      expect(isTransientTransportFailure({ reason: "model", message: "neutral", stopDetail })).toBe(
        true,
      );
    }
  });
});

it("captures actual HTTP JSON and reset before an SDK discards them, without consuming its body", async () => {
  const body = {
    error: { type: "usage_limit_reached", message: "Limit used", resets_at: 1800000000 },
    request: { private: "never record" },
  };
  const capture = new ProviderStopCapture();
  const response = new Response(JSON.stringify(body), { status: 429 });
  const fetch = capture.fetch(
    async () => response,
    () => 1000,
  );
  const returned = await fetch("https://fixture.invalid");
  expect(await returned.json()).toEqual(body);
  expect(capture.detail(message({ errorMessage: "friendly text with no code" }))).toMatchObject({
    category: "rate-limited",
    providerType: "usage_limit_reached",
    message: "Limit used",
    resetsAt: 1800000000000,
  });
  expect(JSON.stringify(capture.detail(message()))).not.toContain("never record");
});

it("bounds unknown HTTP bodies and keeps network failures as structured codes", async () => {
  for (const body of ["not JSON", "x".repeat(9000)]) {
    const capture = new ProviderStopCapture();
    await capture.fetch(
      async () => new Response(body, { status: 502 }),
      () => 1000,
    )("https://fixture.invalid");
    expect(capture.detail(message()).category).toBe("unknown");
  }
  const capture = new ProviderStopCapture();
  const error = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  await expect(
    capture.fetch(
      async () => {
        throw error;
      },
      () => 0,
    )("https://fixture.invalid"),
  ).rejects.toBe(error);
  expect(capture.detail(message()).category).toBe("network");
  let attempt = 0;
  const fetch = capture.fetch(
    async () =>
      ++attempt === 1
        ? new Response('{"error":{"type":"overloaded_error","message":"busy"}}', { status: 529 })
        : new Response("not JSON", { status: 500 }),
    () => 0,
  );
  await fetch("https://fixture.invalid");
  await fetch("https://fixture.invalid");
  expect(capture.detail(message())).toMatchObject({
    category: "unknown",
    providerType: null,
    message: null,
    httpStatus: 500,
  });
});
