import type { Api, Model, Models, AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { COMPACTION_SUMMARY_PREFIX } from "@earendil-works/pi-agent-core";
import {
  ANTHROPIC_COMPACT_BETA,
  compactProviderNative,
  nativeCompactionAvailable,
  nativeCompactionRoute,
  nativeCompactionSupport,
  projectAnthropicCompaction,
  projectOpenAICompaction,
  providerCompactionFromDetails,
  readProviderCompaction,
  toAnthropicMessages,
  type NativeRequestObservation,
  type ProviderCompactionState,
} from "./provider-compaction";

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
      expect(readProviderCompaction(details)).toEqual({ kind: "state", state });
    }
  });

  it("reports a malformed checkpoint to a recovering reader instead of throwing at it", () => {
    // The same fact, answered two ways on purpose: the outgoing projection must
    // fail closed, and an attach must be able to rebuild from original history.
    const details = { providerCompaction: { kind: "openai-responses", items: [] } };
    expect(() => providerCompactionFromDetails(details)).toThrow("malformed");
    const read = readProviderCompaction(details);
    expect(read.kind).toBe("malformed");
    if (read.kind !== "malformed") return;
    expect(read.reason).toContain("original history");
    expect(readProviderCompaction({ pi: "whatever Pi wrote" })).toEqual({ kind: "absent" });
    expect(readProviderCompaction(undefined)).toEqual({ kind: "absent" });
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

describe("nativeCompactionAvailable — the route a checkpoint may be replayed on", () => {
  it("accepts the catalog route only when the resolved credential agrees", async () => {
    await expect(
      nativeCompactionAvailable(ANTHROPIC_MODEL, modelsReturningAuth({ apiKey: "sk-ant-api03" })),
    ).resolves.toBe(true);
    // The same catalog model, reached through a subscription: the checkpoint
    // the metered API minted is not replayable there.
    await expect(
      nativeCompactionAvailable(
        ANTHROPIC_MODEL,
        modelsReturningAuth({ apiKey: "sk-ant-oat01-example" }),
      ),
    ).resolves.toBe(false);
    await expect(
      nativeCompactionAvailable(
        ANTHROPIC_MODEL,
        modelsReturningAuth({ apiKey: "sk-ant-api03" }, "Anthropic OAuth"),
      ),
    ).resolves.toBe(false);
    // …and an endpoint override moves it off the public API entirely.
    await expect(
      nativeCompactionAvailable(
        OPENAI_MODEL,
        modelsReturningAuth({ apiKey: "sk-test", baseUrl: "https://gateway.example/v1" }),
      ),
    ).resolves.toBe(false);
  });

  it("is false without a credential, and for a credential that cannot be resolved at all", async () => {
    await expect(
      nativeCompactionAvailable(ANTHROPIC_MODEL, modelsReturningAuth(undefined)),
    ).resolves.toBe(false);
    const throwing = {
      getAuth: vi.fn(async () => {
        throw new Error("keychain locked");
      }),
    } as unknown as Models;
    await expect(nativeCompactionAvailable(ANTHROPIC_MODEL, throwing)).resolves.toBe(false);
  });

  it("never resolves a credential for a model the catalog already rules out", async () => {
    const models = modelsReturningAuth({ apiKey: "sk-test" });
    await expect(
      nativeCompactionAvailable(
        { ...OPENAI_MODEL, baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter" },
        models,
      ),
    ).resolves.toBe(false);
    expect(models.getAuth).not.toHaveBeenCalled();
  });
});

describe("nativeCompactionRoute", () => {
  it("answers the catalog's own refusal rather than restating it", () => {
    // The route check is the catalog check plus the credential. A model the
    // catalog already rules out never gets a second, differently worded no.
    const gateway = { ...OPENAI_MODEL, baseUrl: "https://openrouter.ai/api/v1" };
    expect(nativeCompactionRoute(gateway, { auth: { apiKey: "sk-test" } })).toEqual(
      nativeCompactionSupport(gateway),
    );
    expect(nativeCompactionRoute(OPENAI_MODEL, { auth: { apiKey: "sk-test" } })).toEqual({
      supported: true,
    });
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
            // A partial iteration: the classes it does report add, and the
            // ones it does not leave the running total where it was.
            { type: "compaction", input_tokens: 7 },
          ],
        },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    // Top-level request plus one priced compaction iteration.
    expect(outcome.rawUsage).toMatchObject({
      // Anthropic ledger: input tokens are additive, cache fields separate.
      input: 60_000 + 1_000 + 7,
      output: 150,
      cacheRead: 5_400,
      cacheWrite: 510,
    });
    expect(outcome.usage).toMatchObject({ cause: "compaction" });
  });

  it("keeps a token class the provider did not report absent, never zero", async () => {
    // A provider that charged nothing and a provider that said nothing are
    // different facts, and a Session's bill is the surface that has to keep
    // them apart. Anthropic reports no OpenAI-style cached-input detail here,
    // and `output_tokens` is missing outright.
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      fetch: anthropicFetch({
        stop_reason: "compaction",
        content: [compactionBlock],
        usage: { input_tokens: 60_000, cache_read_input_tokens: 1_000 },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.usage).toMatchObject({
      inputTokens: 60_000,
      cacheReadTokens: 1_000,
      outputTokens: null,
      cacheWriteTokens: null,
    });
    // The Pi shape a durable entry stores has no spelling for absence; it is
    // the only place a missing class becomes a zero.
    expect(outcome.rawUsage).toMatchObject({ output: 0, cacheWrite: 0 });
  });

  it("reports only what OpenAI measured, cached share included and never doubled", async () => {
    // Three shapes the Responses API actually produces: a cached share larger
    // than the prompt it claims to be part of, a detail object carrying no
    // usable cached count, and output with no prompt count beside it.
    const measured = async (usage: unknown) => {
      const outcome = await compactProviderNative({
        model: OPENAI_MODEL,
        models: modelsReturningAuth({ apiKey: "sk-test" }),
        messages: [user("hello")],
        enabled: true,
        fetch: fetchReturning({ output: canonicalWindow, usage }),
      });
      expect(outcome.kind).toBe("compacted");
      return outcome.kind === "compacted" ? outcome.usage : null;
    };
    expect(
      await measured({ input_tokens: 100, input_tokens_details: { cached_tokens: 900 } }),
    ).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 });
    expect(
      await measured({ input_tokens: 100, input_tokens_details: { cached_tokens: "lots" } }),
    ).toMatchObject({ inputTokens: 100, cacheReadTokens: null });
    expect(await measured({ output_tokens: 42 })).toMatchObject({
      inputTokens: null,
      outputTokens: 42,
      cacheReadTokens: null,
    });
  });

  it("reports tokens with no cost when the catalog cannot price the model", async () => {
    // Tokens and dollars are separate claims. A catalog row with no usable
    // price still measured consumption; it just cannot vouch for a basis.
    const unpriced = {
      ...OPENAI_MODEL,
      cost: { input: Number.NaN, output: Number.NaN, cacheRead: 0, cacheWrite: 0 },
    } as Model<Api>;
    const outcome = await compactProviderNative({
      model: unpriced,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetchReturning({
        output: canonicalWindow,
        usage: { input_tokens: 1_000, output_tokens: 50 },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.usage).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 50,
      costUsd: null,
      costBasis: "unavailable",
    });
  });

  it("treats a malformed usage block as no measurement at all", async () => {
    for (const usage of [
      { input_tokens: "lots", output_tokens: Number.NaN },
      { input_tokens: -5, output_tokens: null },
      "unmeasured",
      undefined,
    ]) {
      const outcome = await compactProviderNative({
        model: ANTHROPIC_MODEL,
        models: modelsReturningAuth({ apiKey: "sk-ant" }),
        messages: [user("long context")],
        enabled: true,
        fetch: anthropicFetch({
          stop_reason: "compaction",
          content: [compactionBlock],
          ...(usage === undefined ? {} : { usage }),
        }),
      });
      expect(outcome.kind).toBe("compacted");
      if (outcome.kind !== "compacted") return;
      // Null, not a row of zeroes: an unmeasured operation must not read as a
      // free one on any surface that sums these.
      expect(outcome.usage).toBeNull();
      expect(outcome.rawUsage).toBeUndefined();
    }
  });

  it("reports every native HTTP call to the instrumentation seam it is given", async () => {
    // Native compaction is the one model call that does not go through
    // `streamSimple`, so it reports itself instead of being a hole in the
    // Usage Window read and the attempt envelope.
    const observed: NativeRequestObservation[] = [];
    await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      onNativeRequest: (observation) => observed.push(observation),
      fetch: vi.fn(async (url: URL | RequestInfo) =>
        String(url).endsWith("/count_tokens")
          ? new Response(JSON.stringify({ input_tokens: 60_000 }), {
              headers: {
                "content-type": "application/json",
                "anthropic-ratelimit-unified-status": "allowed",
              },
            })
          : new Response(
              JSON.stringify({ stop_reason: "compaction", content: [compactionBlock] }),
              {
                headers: {
                  "content-type": "application/json",
                  "anthropic-ratelimit-unified-5h-remaining": "42",
                },
              },
            ),
      ) as unknown as typeof fetch,
    });
    expect(observed.map((call) => call.endpoint)).toEqual([
      "anthropic-count-tokens",
      "anthropic-compact",
    ]);
    expect(observed.every((call) => call.status === 200)).toBe(true);
    expect(observed[1]?.headers["anthropic-ratelimit-unified-5h-remaining"]).toBe("42");
    expect(observed.every((call) => Number.isFinite(call.durationMs))).toBe(true);
  });

  it("reports a failed native call to the seam, and survives a seam that throws", async () => {
    const observed: number[] = [];
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      onNativeRequest: (observation) => {
        observed.push(observation.status);
        throw new Error("sink exploded");
      },
      fetch: vi.fn(async () => jsonResponse({ error: "nope" }, 429)) as unknown as typeof fetch,
    });
    expect(observed).toEqual([429]);
    expect(outcome).toMatchObject({ kind: "failed" });
  });

  it("refuses a response body larger than this runtime will read", async () => {
    // A first-party endpoint answering with an unbounded stream must fail this
    // request rather than the process. Half a canonical window is not a smaller
    // canonical window, so the JSON read fails outright rather than truncating.
    const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
    let remaining = 40;
    const oversized = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (remaining-- <= 0) controller.close();
            else controller.enqueue(megabyte);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      fetch: vi.fn(async (url: URL | RequestInfo) =>
        String(url).endsWith("/count_tokens")
          ? jsonResponse({ input_tokens: 60_000 })
          : oversized(),
      ) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("exceeded the size");
  });

  it("quotes a long provider error instead of losing it to the bound", async () => {
    // The opposite call: an error body is only ever read for its first few
    // hundred characters, so an oversized one truncates rather than failing.
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      fetch: vi.fn(
        async () => new Response(`overloaded: ${"x".repeat(64_000)}`, { status: 529 }),
      ) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("529");
    expect(outcome.message).toContain("overloaded");
    expect(outcome.message.length).toBeLessThan(700);
  });

  it("reads a body-less response without pretending it was JSON", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("long context")],
      enabled: true,
      fetch: vi.fn(async (url: URL | RequestInfo) =>
        String(url).endsWith("/count_tokens")
          ? jsonResponse({ input_tokens: 60_000 })
          : new Response(null, { status: 204 }),
      ) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
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
  /** The catalog says what a model can take; images ride only where it does. */
  const VISION_MODEL = { ...ANTHROPIC_MODEL, input: ["text", "image"] } as Model<Api>;
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
    const wire = toAnthropicMessages(
      [
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
      ],
      VISION_MODEL,
    );
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
    const wire = toAnthropicMessages(
      [
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
      ],
      VISION_MODEL,
    );
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
    expect(
      toAnthropicMessages([assistantMessage([{ type: "text", text: "hi" }])], ANTHROPIC_MODEL),
    ).toBe("Conversation must begin with a user message.");
    expect(toAnthropicMessages([], ANTHROPIC_MODEL)).toBe(
      "Conversation must begin with a user message.",
    );
  });

  it("carries signed thinking and redacted thinking back with the tool_use they belong to", () => {
    // Anthropic's documented rule for tool use: the assistant turn goes back
    // complete and unmodified. A `thinking` block keeps its signature, a
    // `redacted_thinking` block keeps its opaque payload, and dropping either
    // out of a turn that also carries `tool_use` is a 400 — which would take
    // the whole compaction with it.
    const wire = toAnthropicMessages(
      [
        user("look it up"),
        assistantMessage(
          [
            { type: "thinking", thinking: "weighing options", thinkingSignature: "sig-abc" },
            {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: "opaque-1",
              redacted: true,
            },
            { type: "text", text: "checking" },
            { type: "toolCall", id: "call_1", name: "ls", arguments: { path: "." } },
          ],
          "toolUse",
        ),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "ls",
          content: [{ type: "text", text: "a.txt" }],
          isError: false,
          timestamp: 4,
        },
      ],
      ANTHROPIC_MODEL,
    );
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "weighing options", signature: "sig-abc" },
        { type: "redacted_thinking", data: "opaque-1" },
        { type: "text", text: "checking" },
        { type: "tool_use", id: "call_1", name: "ls", input: { path: "." } },
      ],
    });
    // Text-only results ride as a plain string, exactly as Pi's own adapter
    // sends them, so the count endpoint measures the request that will be made.
    expect(wire[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", is_error: false, content: "a.txt" }],
    });
  });

  it("downgrades an unsigned thinking block to text and drops an empty one", () => {
    // Anthropic rejects a `thinking` block with no signature; Pi's adapter
    // sends its text instead, and a block with neither text nor signature is
    // nothing to send at all.
    const wire = toAnthropicMessages(
      [
        user("go"),
        assistantMessage([
          { type: "thinking", thinking: "unsigned reasoning", thinkingSignature: "" },
          { type: "thinking", thinking: "   ", thinkingSignature: "" },
          { type: "text", text: "answer" },
        ]),
      ],
      ANTHROPIC_MODEL,
    );
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "unsigned reasoning" },
        { type: "text", text: "answer" },
      ],
    });
  });

  it("keeps an unsigned thinking block for a model that allows empty signatures", () => {
    const wire = toAnthropicMessages(
      [
        user("go"),
        assistantMessage([
          { type: "thinking", thinking: "unsigned reasoning", thinkingSignature: "" },
        ]),
      ],
      { ...ANTHROPIC_MODEL, compat: { allowEmptySignature: true } } as Model<Api>,
    );
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire[1]).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "unsigned reasoning", signature: "" }],
    });
  });

  it("downgrades images the selected model cannot take, in user and tool content", () => {
    // The compaction request is a real request to a real model. A history that
    // carries images a text-only deployment cannot accept would be refused,
    // and the compaction with it.
    const wire = toAnthropicMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image", data: "aaa", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
      ANTHROPIC_MODEL,
    );
    expect(wire).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "text", text: "(image omitted: model does not support images)" },
        ],
      },
    ]);
  });

  it("drops blank text, ignores block types it has no word for, and defaults empty tool input", () => {
    // Anthropic refuses an empty text block, and a content type this build has
    // never heard of is not something to guess a wire shape for. A tool call
    // with no arguments still needs an `input`, which the API requires.
    const wire = toAnthropicMessages(
      [
        { role: "user", content: [{ type: "text", text: "   " }], timestamp: 1 },
        user("go"),
        assistantMessage(
          [
            { type: "text", text: "  " },
            { type: "citation", url: "https://example.test" },
            { type: "toolCall", id: "call_1", name: "ls" },
          ] as unknown as AssistantMessage["content"],
          "toolUse",
        ),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "ls",
          content: [{ type: "image", data: "ccc", mimeType: "image/png" }],
          isError: false,
          timestamp: 4,
        },
      ],
      VISION_MODEL,
    );
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire[0]).toEqual({ role: "user", content: [{ type: "text", text: "go" }] });
    expect(wire[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "ls", input: {} }],
    });
    // An image-only tool result gets Pi's placeholder text block, because
    // Anthropic will not take a content array with no text in it.
    expect(wire[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          is_error: false,
          content: [
            { type: "text", text: "(see attached image)" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "ccc" } },
          ],
        },
      ],
    });
  });

  it("synthesizes a result for a tool call the conversation never answered", () => {
    // The cut can land on a turn whose tool call has no result yet. Anthropic
    // refuses a `tool_use` with no matching `tool_result`, so the prefix that
    // is about to be summarized must not be able to end on one.
    const wire = toAnthropicMessages(
      [
        user("start"),
        assistantMessage(
          [{ type: "toolCall", id: "call_orphan", name: "ls", arguments: {} }],
          "toolUse",
        ),
      ],
      ANTHROPIC_MODEL,
    );
    expect(typeof wire).not.toBe("string");
    if (typeof wire === "string") return;
    expect(wire).toHaveLength(3);
    expect(wire[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_orphan", is_error: true }],
    });
  });
});

const malformed = (providerCompaction: unknown) => () =>
  providerCompactionFromDetails({ providerCompaction });
