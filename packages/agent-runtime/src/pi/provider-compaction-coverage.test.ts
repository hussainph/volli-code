import type { Api, Model, Models, AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ANTHROPIC_COMPACT_BETA,
  compactProviderNative,
  isProviderCompactionDetails,
  nativeCompactionSupport,
  projectAnthropicCompaction,
  projectOpenAICompaction,
  providerCompactionFromDetails,
  toAnthropicMessages,
  type ProviderCompactionState,
} from "./provider-compaction";

const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

const OPENAI_MODEL: Model<Api> = {
  id: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 128_000,
};

const ANTHROPIC_MODEL: Model<Api> = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

function user(text: string) {
  return { role: "user" as const, content: text, timestamp: 1 };
}

function summaryMessage(summary: string) {
  return {
    role: "compactionSummary" as const,
    summary,
    tokensBefore: 90_000,
    timestamp: 1,
  };
}

function modelsReturningAuth(
  auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, unknown> } | undefined,
  source = "test",
): Models {
  return {
    getAuth: vi.fn(async () => (auth === undefined ? undefined : { auth, source })),
  } as unknown as Models;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Count endpoint answers 60k (above the beta minimum); everything else gets `body`. */
function fetchReturning(
  body: unknown,
  status = 200,
): { mock: { calls: [string, RequestInit][] } } & typeof fetch {
  const fn = vi.fn(async (url: URL | RequestInfo) =>
    String(url).endsWith("/count_tokens")
      ? jsonResponse({ input_tokens: 60_000 })
      : jsonResponse(body, status),
  );
  return fn as unknown as { mock: { calls: [string, RequestInit][] } } & typeof fetch;
}

const canonicalWindow = [
  { type: "compaction", id: "cpt_1", encrypted_content: "opaque" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "kept tail" }] },
];

const compactionBlock = { type: "compaction", content: "<summary>the task so far</summary>" };

describe("nativeCompactionSupport — URL grammar", () => {
  it("accepts the bare origin and the /v1/ spelling", () => {
    expect(nativeCompactionSupport({ ...OPENAI_MODEL, baseUrl: "https://api.openai.com" })).toEqual(
      { supported: true },
    );
    expect(
      nativeCompactionSupport({ ...OPENAI_MODEL, baseUrl: "https://api.openai.com/v1/" }),
    ).toEqual({ supported: true });
    expect(
      nativeCompactionSupport({ ...ANTHROPIC_MODEL, baseUrl: "https://api.anthropic.com/v1/" }),
    ).toEqual({ supported: true });
  });

  it("rejects unusable URLs outright", () => {
    expect(nativeCompactionSupport({ ...OPENAI_MODEL, baseUrl: "not a url" }).supported).toBe(
      false,
    );
  });

  it("rejects plaintext, credentialed, queried and deep-path endpoints", () => {
    for (const baseUrl of [
      "http://api.openai.com/v1",
      "https://user:pass@api.openai.com/v1",
      "https://api.openai.com/v1?flag=1",
      "https://api.openai.com/v1#frag",
      "https://api.openai.com/v1beta",
    ]) {
      expect(nativeCompactionSupport({ ...OPENAI_MODEL, baseUrl }).supported).toBe(false);
    }
  });

  it("applies the dated-suffix and family whitelist to Claude models", () => {
    expect(
      nativeCompactionSupport({ ...ANTHROPIC_MODEL, id: "claude-opus-5-20260101" }).supported,
    ).toBe(true);
    expect(nativeCompactionSupport({ ...ANTHROPIC_MODEL, id: "claude-mythos-5-1" }).supported).toBe(
      true,
    );
    expect(nativeCompactionSupport({ ...ANTHROPIC_MODEL, id: "claude-3-5-haiku" }).supported).toBe(
      false,
    );
    expect(
      nativeCompactionSupport({ ...ANTHROPIC_MODEL, id: "claude-opus-5-extra" }).supported,
    ).toBe(false);
  });
});

describe("providerCompactionFromDetails — validation", () => {
  const openaiState: ProviderCompactionState = {
    kind: "openai-responses",
    items: [{ type: "compaction", encrypted_content: "opaque" }],
    model: "gpt-5.3-codex",
    compactedAt: 1,
  };
  const anthropicState: ProviderCompactionState = {
    kind: "anthropic-messages",
    block: { type: "compaction", content: "s" },
    model: "claude-opus-5",
    compactedAt: 2,
  };

  it("round-trips both state kinds through JSON details", () => {
    for (const state of [openaiState, anthropicState]) {
      const details = { providerCompaction: JSON.parse(JSON.stringify(state)) };
      expect(providerCompactionFromDetails(details)).toEqual(state);
      expect(isProviderCompactionDetails(details)).toBe(true);
    }
  });

  it("fails closed on every shape that is not a trustworthy checkpoint", () => {
    // Not an object, or details of the wrong shape entirely.
    expect(malformed(undefined)).toThrow("malformed");
    expect(malformed([1, 2])).toThrow("malformed");
    expect(providerCompactionFromDetails(null)).toBeUndefined();
    expect(providerCompactionFromDetails([1])).toBeUndefined();
    // Missing or non-scalar metadata.
    expect(malformed({ kind: "openai-responses", items: openaiState.items })).toThrow("malformed");
    expect(
      malformed({ ...openaiState, model: 3, compactedAt: Number.NaN, items: openaiState.items }),
    ).toThrow("malformed");
    // An OpenAI window without a real encrypted compaction item is not a checkpoint.
    expect(malformed({ ...openaiState, items: [] })).toThrow("malformed");
    expect(malformed({ ...openaiState, items: [{ type: "message" }] })).toThrow("malformed");
    expect(
      malformed({ ...openaiState, items: [{ type: "compaction", encrypted_content: "" }] }),
    ).toThrow("malformed");
    // A null-content Anthropic block is a no-op compaction, never a checkpoint.
    expect(malformed({ ...anthropicState, block: { type: "compaction", content: null } })).toThrow(
      "malformed",
    );
    expect(malformed({ ...anthropicState, block: { type: "other", content: "s" } })).toThrow(
      "malformed",
    );
    // A kind whose payload does not match its declared family.
    expect(
      malformed({
        ...anthropicState,
        kind: "openai-responses",
        items: undefined,
        block: undefined,
      }),
    ).toThrow("malformed");
  });
});

describe("compactProviderNative — endpoint and auth gating", () => {
  it("refuses a credential that re-points the model at an unsupported gateway", async () => {
    const fetch = vi.fn();
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test", baseUrl: "https://proxy.example/v1" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({
      kind: "unsupported",
      reason:
        "Native compaction requires the supported public API endpoint and API-key authentication.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses OAuth-resolved credentials", async () => {
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }, "codex-oauth-token"),
      messages: [user("hello")],
      enabled: true,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "unsupported" });
  });

  it("refuses Anthropic OAuth access tokens (sk-ant-oat…)", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant-oat01-example" }),
      messages: [user("hello")],
      enabled: true,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "unsupported" });
  });

  it("refuses a checkpoint that belongs to another model or another API", async () => {
    const fetch = vi.fn();
    const base = {
      model: OPENAI_MODEL as Model<Api>,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    };
    const otherModel = await compactProviderNative({
      ...base,
      messages: [user("hello")],
      previousState: { ...openaiCheckpoint, model: "gpt-5-mini" },
    });
    const otherApi = await compactProviderNative({
      ...base,
      messages: [user("hello")],
      previousState: {
        kind: "anthropic-messages",
        block: { type: "compaction", content: "s" },
        model: OPENAI_MODEL.id,
        compactedAt: 1,
      },
    });
    expect(otherModel).toMatchObject({
      kind: "unsupported",
      reason: "Native checkpoint belongs to another model.",
    });
    expect(otherApi).toMatchObject({
      kind: "unsupported",
      reason: "Native checkpoint belongs to another model.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails with a clear message when no authentication resolves", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth(undefined),
      messages: [user("hello")],
      enabled: true,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      message: "No resolved provider authentication for compaction.",
    });
  });

  it("propagates non-Error throwables from auth resolution as sanitized failures", async () => {
    const models = {
      getAuth: vi.fn(async () => {
        throw "auth exploded";
      }),
    } as unknown as Models;
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models,
      messages: [user("hello")],
      enabled: true,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed", message: "auth exploded" });
  });
});

const openaiCheckpoint: ProviderCompactionState = {
  kind: "openai-responses",
  items: [{ type: "compaction", id: "cpt_1", encrypted_content: "opaque" }],
  model: OPENAI_MODEL.id,
  compactedAt: 1,
};

describe("compactProviderNative — OpenAI request shaping", () => {
  it("joins system prompt and custom instructions and keeps store out of the schema", async () => {
    const fetch = fetchReturning({
      output: canonicalWindow,
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      systemPrompt: "be terse",
      customInstructions: "focus on decisions",
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    const init = fetch.mock.calls[0]![1] as RequestInit;
    const request = JSON.parse(init.body as string);
    expect(request.instructions).toBe("be terse\n\nfocus on decisions");
    expect(request.store).toBeUndefined();
    expect(request.tools).toBeUndefined();
  });

  it("merges model and auth headers lowercased, drops non-string values, and defaults to Bearer auth", async () => {
    const model = {
      ...OPENAI_MODEL,
      headers: { "X-Model": "model-value", "Skip-Me": 42 },
    } as unknown as Model<Api>;
    const fetch = fetchReturning({
      output: canonicalWindow,
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const outcome = await compactProviderNative({
      model,
      models: modelsReturningAuth({
        apiKey: "sk-test",
        headers: { "X-Custom": "auth-value", "Skip-Me-Too": { nested: true } },
      }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    const headers = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-model"]).toBe("model-value");
    expect(headers["x-custom"]).toBe("auth-value");
    expect(headers["skip-me"]).toBeUndefined();
    expect(headers["skip-me-too"]).toBeUndefined();
    expect(headers["authorization"]).toBe("Bearer sk-test");
  });

  it("keeps a header-supplied Authorization instead of Bearer-ing the raw key", async () => {
    const fetch = fetchReturning({
      output: canonicalWindow,
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({
        apiKey: "sk-test",
        headers: { Authorization: "Bearer pre-authorized" },
      }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    const headers = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer pre-authorized");
  });

  it("honors a credential endpoint override that still points at the first-party origin", async () => {
    const fetch = fetchReturning({
      output: canonicalWindow,
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test", baseUrl: "https://api.openai.com" }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses/compact");
  });

  it("chains a previous checkpoint by replacing the compaction summary in the input", async () => {
    const fetch = fetchReturning({
      output: canonicalWindow,
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [summaryMessage("earlier work"), user("next question")],
      previousState: openaiCheckpoint,
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    const request = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(request.input).toEqual([
      ...openaiCheckpoint.items,
      { role: "user", content: [{ type: "input_text", text: "next question" }] },
    ]);
  });

  it("fails when a previous checkpoint cannot be projected because the summary is gone", async () => {
    const fetch = fetchReturning({ output: canonicalWindow });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("plain conversation")],
      previousState: openaiCheckpoint,
      enabled: true,
      fetch,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      message: "Previous native checkpoint is missing from compaction input.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails with usage when the response carries no valid compaction window", async () => {
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetchReturning({
        output: [{ type: "message", role: "assistant" }],
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("no valid compaction window");
    expect(outcome.rawUsage).toMatchObject({ input: 10 });
  });

  it("fails on a non-object response body", async () => {
    const fetch = vi.fn(async () => new Response("null", { status: 200 }));
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("no valid compaction window");
  });

  it("reports null usage when the response has no readable usage object", async () => {
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetchReturning({ output: canonicalWindow, usage: "garbage" }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.rawUsage).toBeUndefined();
    expect(outcome.usage).toBeNull();
  });

  it("truncates oversized provider error bodies in the failure message", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: "x".repeat(900) } }, 502));
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("502");
    expect(outcome.message.length).toBeLessThan(600);
  });

  it("passes a live abort signal through to the wire request", async () => {
    const controller = new AbortController();
    const seen: RequestInit[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonResponse({
        output: canonicalWindow,
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      signal: controller.signal,
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("compacted");
    expect((seen[0]!.signal as AbortSignal).aborted).toBe(false);
  });

  it("falls back to globalThis.fetch when no fetch is supplied", async () => {
    const fetchSpy = vi.fn(async (_url: URL | RequestInfo) =>
      jsonResponse({ output: canonicalWindow, usage: { input_tokens: 10, output_tokens: 1 } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const outcome = await compactProviderNative({
        model: OPENAI_MODEL,
        models: modelsReturningAuth({ apiKey: "sk-test" }),
        messages: [user("hello")],
        enabled: true,
      });
      expect(outcome.kind).toBe("compacted");
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/responses/compact");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a mid-flight abort as aborted", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new Error("The operation was aborted");
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      signal: controller.signal,
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      message: "provider-native compaction aborted",
    });
  });

  it("sanitizes thrown errors even when a live signal is attached", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      throw new Error("socket exploded");
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      signal: controller.signal,
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed", message: "socket exploded" });
  });
});

describe("compactProviderNative — Anthropic request shaping", () => {
  function anthropicFetch(
    messagesBody: unknown,
    countOverride?: { body: unknown; status?: number },
  ): { mock: { calls: [string, RequestInit][] } } & typeof fetch {
    const fn = vi.fn(async (url: URL | RequestInfo) =>
      String(url).endsWith("/count_tokens")
        ? jsonResponse(
            countOverride?.body ?? { input_tokens: 60_000 },
            countOverride?.status ?? 200,
          )
        : jsonResponse(messagesBody),
    );
    return fn as unknown as { mock: { calls: [string, RequestInit][] } } & typeof fetch;
  }

  const compactedResponse = {
    stop_reason: "compaction",
    content: [compactionBlock],
    usage: { input_tokens: 60_000, output_tokens: 900 },
  };

  it("maps system prompt and tools into the count/compaction request", async () => {
    const fetch = anthropicFetch(compactedResponse);
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello"), { ...user("tool") }],
      systemPrompt: "be terse",
      tools: [{ name: "ls", description: "list files", parameters: { type: "object" } } as never],
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    const request = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(request.system).toBe("be terse");
    expect(request.tools).toEqual([
      { name: "ls", description: "list files", input_schema: { type: "object" } },
    ]);
  });

  it("keeps a header-supplied Authorization and skips x-api-key, still sending the beta header", async () => {
    const fetch = anthropicFetch(compactedResponse);
    await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({
        headers: { Authorization: "Bearer pre-authorized" },
      }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    const headers = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer pre-authorized");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_COMPACT_BETA);
  });

  it("preserves a caller-supplied beta alongside the compaction beta", async () => {
    const fetch = anthropicFetch(compactedResponse);
    await compactProviderNative({
      model: { ...ANTHROPIC_MODEL, headers: { "anthropic-beta": "other-beta" } },
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    const headers = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe(`other-beta,${ANTHROPIC_COMPACT_BETA}`);
  });

  it("sets x-api-key when no header credential exists", async () => {
    const fetch = anthropicFetch(compactedResponse);
    await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    const headers = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("threads custom instructions into the compaction edit", async () => {
    const fetch = anthropicFetch(compactedResponse);
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      customInstructions: "preserve the migration plan",
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    const body = JSON.parse((fetch.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(Math.min(16_384, ANTHROPIC_MODEL.maxTokens));
    expect(body.context_management.edits[0].instructions).toContain("preserve the migration plan");
    expect(body.context_management.edits[0].pause_after_compaction).toBe(true);
  });

  it("chains a previous checkpoint into the follow-up request", async () => {
    const fetch = anthropicFetch(compactedResponse);
    const previousState: ProviderCompactionState = {
      kind: "anthropic-messages",
      block: { type: "compaction", content: "earlier" },
      model: ANTHROPIC_MODEL.id,
      compactedAt: 1,
    };
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [summaryMessage("earlier"), user("next")],
      previousState,
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("compacted");
    const body = JSON.parse((fetch.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: "assistant", content: [previousState.block] });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "next" }],
    });
  });

  it("fails when a previous checkpoint cannot be projected", async () => {
    const fetch = anthropicFetch(compactedResponse);
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("no summary here")],
      previousState: {
        kind: "anthropic-messages",
        block: { type: "compaction", content: "earlier" },
        model: ANTHROPIC_MODEL.id,
        compactedAt: 1,
      },
      enabled: true,
      fetch,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      message: "Previous native checkpoint is missing from compaction input.",
    });
  });

  it("fails when the token count request errors", async () => {
    const fetch = anthropicFetch(compactedResponse, { body: { error: "down" }, status: 500 });
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("Anthropic token counting failed with 500");
  });

  it("fails when the compaction call itself errors", async () => {
    const fetch = vi.fn(async (url: URL | RequestInfo) =>
      String(url).endsWith("/count_tokens")
        ? jsonResponse({ input_tokens: 60_000 })
        : jsonResponse({ error: "overloaded" }, 529),
    );
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("Anthropic compaction failed with 529");
  });

  it("fails when the token count is not a finite number", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch: anthropicFetch(compactedResponse, { body: { input_tokens: "many" } }),
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("invalid token count");
  });

  it("skips the generating call when the context is below the trigger", async () => {
    const fetch = anthropicFetch(compactedResponse, { body: { input_tokens: 49_999 } });
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("short")],
      enabled: true,
      fetch,
    });
    expect(outcome).toMatchObject({
      kind: "unsupported",
      reason: "Context is below Anthropic's minimum compaction trigger.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/count_tokens");
  });

  it("fails when Anthropic answers instead of compacting", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch: anthropicFetch({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }),
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("did not return a successful compaction block");
  });

  it("ignores non-compaction content blocks when looking for the checkpoint", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch: anthropicFetch({
        stop_reason: "compaction",
        content: [{ type: "text", text: "preamble" }, compactionBlock],
        usage: { input_tokens: 60_000, output_tokens: 900 },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted" || outcome.state.kind !== "anthropic-messages") return;
    expect(outcome.state.block).toEqual(compactionBlock);
    expect(outcome.textSummary).toBe("<summary>the task so far</summary>");
  });

  it("prices compaction iterations and skips malformed iteration entries", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      fetch: anthropicFetch({
        stop_reason: "compaction",
        content: [compactionBlock],
        usage: {
          input_tokens: 60_000,
          output_tokens: 100,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 500,
          iterations: [
            "garbage",
            { type: "regeneration", input_tokens: 999_999, output_tokens: 999 },
            {
              type: "compaction",
              input_tokens: 1_000,
              output_tokens: 50,
              cache_read_input_tokens: 400,
              cache_creation_input_tokens: 10,
            },
          ],
        },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    // Top-level request plus one priced compaction iteration.
    expect(outcome.rawUsage).toMatchObject({
      // Anthropic ledger: input tokens are additive, cache fields separate.
      input: 60_000 + 1_000,
      output: 150,
      cacheRead: 5_400,
      cacheWrite: 510,
    });
    expect(outcome.usage).toMatchObject({ cause: "compaction" });
  });

  it("reports a non-object compaction response body as failed", async () => {
    const fetch = vi.fn(async (url: URL | RequestInfo) =>
      String(url).endsWith("/count_tokens")
        ? jsonResponse({ input_tokens: 60_000 })
        : new Response("null", { status: 200 }),
    );
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("did not return a successful compaction block");
  });
});

describe("payload projections — edges", () => {
  const openaiState = openaiCheckpoint;
  const anthropicState: ProviderCompactionState = {
    kind: "anthropic-messages",
    block: { type: "compaction", summary: "s" },
    model: ANTHROPIC_MODEL.id,
    compactedAt: 1,
  };

  it("returns undefined when the OpenAI input is not an array", () => {
    expect(projectOpenAICompaction({ input: "nope" }, openaiState)).toBeUndefined();
  });

  it("keeps sibling blocks that share the summary user item, OpenAI side", () => {
    const params = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `${COMPACTION_SUMMARY_PREFIX}s</summary>` },
            { type: "input_text", text: "and also look at this" },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: "later" }] },
      ],
    };
    const projected = projectOpenAICompaction(params, openaiState);
    expect(projected?.input).toEqual([
      ...openaiState.items,
      { role: "user", content: [{ type: "input_text", text: "and also look at this" }] },
      { role: "user", content: [{ type: "input_text", text: "later" }] },
    ]);
  });

  it("returns undefined when the Anthropic messages are not an array", () => {
    expect(projectAnthropicCompaction({ messages: "nope" }, anthropicState)).toBeUndefined();
  });

  it("keeps blocks after the summary inside the same user message, Anthropic side", () => {
    const summary = {
      role: "user",
      content: [
        { type: "text", text: `${COMPACTION_SUMMARY_PREFIX}s</summary>` },
        { type: "image", data: "aaa", mimeType: "image/png" },
      ],
    };
    const projected = projectAnthropicCompaction({ messages: [summary] }, anthropicState);
    expect(projected?.messages).toEqual([
      { role: "assistant", content: [anthropicState.block] },
      {
        role: "user",
        content: [{ type: "image", data: "aaa", mimeType: "image/png" }],
      },
    ]);
  });

  it("does not stack a new assistant message onto an existing one", () => {
    const summary = {
      role: "user",
      content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}s</summary>` }],
    };
    const reply = { role: "assistant", content: [{ type: "text", text: "kept" }] };
    const projected = projectAnthropicCompaction({ messages: [summary, reply] }, anthropicState);
    expect(projected?.messages).toEqual([
      { role: "assistant", content: [anthropicState.block, { type: "text", text: "kept" }] },
    ]);
  });
});

describe("toAnthropicMessages — visible-message conversion", () => {
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistantMessage = (
    content: AssistantMessage["content"],
    stopReason: "stop" | "error" | "aborted" | "deferred" | "toolUse" = "stop",
  ): AssistantMessage => ({
    role: "assistant" as const,
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: ANTHROPIC_MODEL.id,
    usage,
    stopReason,
    timestamp: 2,
  });

  it("coalesces consecutive user messages and converts images", () => {
    const wire = toAnthropicMessages([
      user("first"),
      {
        role: "user",
        content: [
          { type: "text", text: "see attachment" },
          { type: "image", data: "aaa", mimeType: "image/png" },
        ],
        timestamp: 2,
      },
      user("third"),
    ]);
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "see attachment" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aaa" },
          },
          { type: "text", text: "third" },
        ],
      },
    ]);
  });

  it("skips failed assistants, empty text, and sanitizes tool call ids", () => {
    const wire = toAnthropicMessages([
      user("go"),
      assistantMessage([{ type: "text", text: "boom" }], "error"),
      assistantMessage([{ type: "text", text: "" }], "aborted"),
      assistantMessage(
        [
          { type: "text", text: "running" },
          { type: "toolCall", id: "call.1 x", name: "ls", arguments: { path: "." } },
        ],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: "call.1 x",
        toolName: "ls",
        content: [
          { type: "text", text: "out" },
          { type: "image", data: "bbb", mimeType: "image/jpeg" },
        ],
        isError: true,
        timestamp: 4,
      },
      assistantMessage([{ type: "text", text: "done" }], "deferred"),
    ]);
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "call_1_x", name: "ls", input: { path: "." } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1_x",
            is_error: true,
            content: [
              { type: "text", text: "out" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "bbb" },
              },
            ],
          },
        ],
      },
    ]);
  });

  it("refuses conversations that do not start with a user message", () => {
    expect(toAnthropicMessages([assistantMessage([{ type: "text", text: "hi" }])])).toBe(
      "Conversation must begin with a user message.",
    );
    expect(toAnthropicMessages([])).toBe("Conversation must begin with a user message.");
  });
});

const malformed = (providerCompaction: unknown) => () =>
  providerCompactionFromDetails({ providerCompaction });
