import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { COMPACTION_SUMMARY_PREFIX } from "@earendil-works/pi-agent-core";
import {
  ANTHROPIC_COMPACT_MIN_TRIGGER_TOKENS,
  compactProviderNative,
  nativeCompactionSupport,
  projectAnthropicCompaction,
  projectOpenAICompaction,
  providerCompactionFromDetails,
  readProviderCompaction,
  toAnthropicMessages,
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

const GATEWAY_MODEL: Model<Api> = {
  ...OPENAI_MODEL,
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};

const CODEX_MODEL: Model<Api> = {
  ...OPENAI_MODEL,
  provider: "openai-codex",
  api: "openai-codex-responses",
};

function user(text: string) {
  return { role: "user" as const, content: text, timestamp: 1 };
}

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "openai",
    model: OPENAI_MODEL.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 2,
  };
}

/** A Models stub whose getAuth resolves what the test needs. The module reads
 * auth only through `models.getAuth`, so this is the whole auth surface. */
function modelsReturningAuth(auth: { apiKey: string } | undefined): Models {
  return {
    getAuth: vi.fn(async () => (auth === undefined ? undefined : { auth, source: "test" })),
  } as unknown as Models;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function fetchReturning(
  body: unknown,
  status = 200,
): { mock: { calls: [string, RequestInit][] } } & FetchMock {
  const fn = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
    String(_url).endsWith("/count_tokens")
      ? jsonResponse({ input_tokens: 60_000 })
      : jsonResponse(body, status),
  );
  return fn as unknown as { mock: { calls: [string, RequestInit][] } } & FetchMock;
}

describe("nativeCompactionSupport", () => {
  it("accepts first-party OpenAI Responses", () => {
    expect(nativeCompactionSupport(OPENAI_MODEL)).toEqual({ supported: true });
  });

  it("accepts first-party Anthropic Messages", () => {
    expect(nativeCompactionSupport(ANTHROPIC_MODEL)).toEqual({ supported: true });
  });

  it("refuses OpenAI-compatible gateways by host", () => {
    const gateway = { ...OPENAI_MODEL, baseUrl: "https://my-gateway.example/v1" };
    const verdict = nativeCompactionSupport(gateway);
    expect(verdict.supported).toBe(false);
  });

  it("refuses the same API family on a different provider id", () => {
    expect(nativeCompactionSupport({ ...OPENAI_MODEL, provider: "acme-proxy" }).supported).toBe(
      false,
    );
  });

  it("refuses Codex OAuth", () => {
    expect(nativeCompactionSupport(CODEX_MODEL).supported).toBe(false);
  });

  it("refuses unrelated api families", () => {
    expect(nativeCompactionSupport({ ...OPENAI_MODEL, api: "openai-completions" }).supported).toBe(
      false,
    );
  });
});

describe("compactProviderNative — OpenAI", () => {
  const canonicalWindow = [
    { type: "compaction", id: "cpt_1", encrypted_content: "opaque" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "kept tail" }] },
  ];

  it("posts the converted input to /responses/compact and returns the window verbatim", async () => {
    const fetch = fetchReturning({
      output: canonicalWindow,
      usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
    });
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [
        user("hello"),
        {
          ...assistant("hi"),
          content: [
            { type: "text" as const, text: "hi" },
            { type: "toolCall" as const, id: "call_1", name: "ls", arguments: { path: "." } },
          ],
          stopReason: "toolUse" as const,
        },
        {
          role: "toolResult" as const,
          toolCallId: "call_1",
          toolName: "ls",
          content: [{ type: "text" as const, text: "a.txt" }],
          isError: false,
          timestamp: 3,
        },
      ],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted" || outcome.state.kind !== "openai-responses") return;
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses/compact");
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const request = JSON.parse(init.body as string);
    expect(request.model).toBe(OPENAI_MODEL.id);
    expect(request.store).toBeUndefined();
    // The conversation reaches the endpoint as a Responses-API window, not as
    // an array of something. Every turn is present, on the right role, and the
    // tool round is intact — a shape assertion that only says "an array" would
    // pass on an empty one.
    const input = request.input as Record<string, unknown>[];
    expect(input.filter((item) => item["role"] === "user")).toHaveLength(1);
    expect(input.filter((item) => item["role"] === "assistant")).toHaveLength(1);
    expect(input.some((item) => item["type"] === "function_call" && item["name"] === "ls")).toBe(
      true,
    );
    expect(
      input.some(
        (item) => item["type"] === "function_call_output" && JSON.stringify(item).includes("a.txt"),
      ),
    ).toBe(true);
    expect(JSON.stringify(input)).toContain("hello");
    expect(JSON.stringify(input)).toContain("hi");
    // The canonical window is stored verbatim — byte-identical JSON, never
    // re-encoded through a local type.
    expect(JSON.stringify(outcome.state.items)).toBe(JSON.stringify(canonicalWindow));
  });

  it("prices measured tokens in per-million units and does not double-count cached input", async () => {
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetchReturning({
        output: canonicalWindow,
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 400 },
          output_tokens: 50,
        },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.usage).toMatchObject({
      inputTokens: 600,
      cacheReadTokens: 400,
      outputTokens: 50,
      costBasis: "catalog-estimate",
    });
    expect(outcome.usage?.costUsd).toBeCloseTo(0.0009);
  });

  it("extracts a text summary and usage from the response", async () => {
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetchReturning({
        output: canonicalWindow,
        usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
      }),
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.textSummary).toBe("Provider-native context checkpoint.");
    expect(outcome.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 50,
      cause: "compaction",
    });
  });

  it("sanitizes transport failures", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      jsonResponse({ error: { message: "boom internal" } }, 500),
    );
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("500");
    // A provider error carrying a key-shaped secret arrives redacted.
    expect(outcome.message).not.toContain("sk-liveabcdefghij1234567890");
  });

  it("redacts key-shaped secrets from provider error bodies", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      jsonResponse({ error: { message: "bad key sk-liveabcdefghij1234567890 given" } }, 401),
    );
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("[redacted]");
    expect(outcome.message).not.toContain("sk-liveabcdefghij1234567890");
  });

  it("reports aborted through the signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-test" }),
      messages: [user("hello")],
      enabled: true,
      signal: controller.signal,
      fetch: vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse({ output: [] }),
      ) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      message: "provider-native compaction aborted",
    });
  });

  it("refuses to run when disabled or ungated, before any network", async () => {
    const fetch = vi.fn();
    const disabled = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth({ apiKey: "sk" }),
      messages: [user("hello")],
      enabled: false,
      fetch: fetch as unknown as typeof fetch,
    });
    const ungated = await compactProviderNative({
      model: GATEWAY_MODEL,
      models: modelsReturningAuth({ apiKey: "sk" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(disabled).toMatchObject({ kind: "unsupported" });
    expect(ungated).toMatchObject({ kind: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses without resolved auth", async () => {
    const outcome = await compactProviderNative({
      model: OPENAI_MODEL,
      models: modelsReturningAuth(undefined),
      messages: [user("hello")],
      enabled: true,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
  });
});

describe("compactProviderNative — Anthropic", () => {
  const compactionBlock = { type: "compaction", content: "<summary>the task so far</summary>" };

  it("posts the beta request with trigger and pause, and stores the block verbatim", async () => {
    const fetch = fetchReturning({
      stop_reason: "compaction",
      content: [compactionBlock],
      usage: { input_tokens: 60_000, output_tokens: 900 },
    });
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello"), assistant("hi")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted" || outcome.state.kind !== "anthropic-messages") return;
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("compact-2026-01-12");
    expect(headers["x-api-key"]).toBe("sk-ant");
    const body = JSON.parse(init.body as string);
    expect(body.context_management).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: ANTHROPIC_COMPACT_MIN_TRIGGER_TOKENS },
          pause_after_compaction: true,
        },
      ],
    });
    expect(outcome.state.block).toEqual(compactionBlock);
    expect(JSON.stringify(outcome.state.block)).toBe(JSON.stringify(compactionBlock));
    expect(outcome.textSummary).toContain("the task so far");
  });

  it("uses the count endpoint to skip short contexts without generating an answer", async () => {
    const fetch = vi.fn(async () => jsonResponse({ input_tokens: 49_999 }));
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("short")],
      enabled: true,
      fetch,
    });
    expect(outcome.kind).toBe("unsupported");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toBeDefined();
  });

  it("rejects null-content no-op blocks and accounts for compaction iterations separately", async () => {
    for (const content of ["checkpoint", null]) {
      const outcome = await compactProviderNative({
        model: ANTHROPIC_MODEL,
        models: modelsReturningAuth({ apiKey: "sk-ant" }),
        messages: [user("long")],
        enabled: true,
        fetch: fetchReturning({
          stop_reason: "compaction",
          content: [{ type: "compaction", content, encrypted_content: "metadata" }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            iterations: [
              {
                type: "compaction",
                input_tokens: 1000,
                output_tokens: 50,
                cache_read_input_tokens: 400,
              },
            ],
          },
        }),
      });
      expect(outcome.kind).toBe(content === null ? "failed" : "compacted");
      if (outcome.kind === "compacted") {
        expect(outcome.usage).toMatchObject({
          inputTokens: 1000,
          cacheReadTokens: 400,
          outputTokens: 50,
        });
        expect(outcome.usage?.costUsd).toBeCloseTo(0.0013);
      }
    }
  });

  it("reports an answer without a compaction stop as failed, not as success", async () => {
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      messages: [user("hello")],
      enabled: true,
      fetch: fetchReturning({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "just answered" }],
      }),
    });
    expect(outcome).toMatchObject({ kind: "failed" });
  });

  it("refuses conversations that cannot be projected, before any network", async () => {
    const fetch = vi.fn();
    const outcome = await compactProviderNative({
      model: ANTHROPIC_MODEL,
      models: modelsReturningAuth({ apiKey: "sk-ant" }),
      // An assistant reply first: Anthropic requires a leading user message.
      messages: [assistant("hi")],
      enabled: true,
      fetch: fetch as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("projects tool use and results to the wire", () => {
    const wire = toAnthropicMessages(
      [
        user("run it"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "using the tool" },
            { type: "toolCall", id: "call_1", name: "ls", arguments: { path: "." } },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: ANTHROPIC_MODEL.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 3,
        },
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
    expect(wire).toEqual([
      { role: "user", content: [{ type: "text", text: "run it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "using the tool" },
          { type: "tool_use", id: "call_1", name: "ls", input: { path: "." } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", is_error: false, content: "a.txt" },
        ],
      },
    ]);
  });
});

describe("payload projections", () => {
  const summaryUserItem = {
    role: "user",
    content: [{ type: "input_text", text: `${COMPACTION_SUMMARY_PREFIX}the summary</summary>` }],
  };

  const openaiState = {
    kind: "openai-responses",
    items: [{ type: "compaction", id: "cpt_1", encrypted_content: "opaque" }],
    model: "gpt-5.3-codex",
    compactedAt: 1,
  } as const;

  it("replaces the summary item in place and keeps everything else", () => {
    const params = {
      model: "gpt-5.3-codex",
      input: [{ role: "developer", content: "system" }, summaryUserItem, user("next question")],
    };
    const projected = projectOpenAICompaction(params, openaiState);
    expect(projected).toBeDefined();
    expect(projected?.input).toEqual([
      { role: "developer", content: "system" },
      ...openaiState.items,
      user("next question"),
    ]);
  });

  it("leaves payloads without a summary message alone", () => {
    const params = { input: [user("fresh conversation")] };
    expect(projectOpenAICompaction(params, openaiState)).toBeUndefined();
  });

  const anthropicState = {
    kind: "anthropic-messages",
    block: { type: "compaction", summary: "s" },
    model: "claude-opus-5",
    compactedAt: 1,
  } as const;

  const summaryAnthropicMessage = {
    role: "user",
    content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}the summary</summary>` }],
  };

  it("prepends the block when the next message is not an assistant reply", () => {
    const params = {
      messages: [
        summaryAnthropicMessage,
        { role: "user", content: [{ type: "text", text: "go on" }] },
      ],
    };
    const projected = projectAnthropicCompaction(params, anthropicState);
    expect(projected?.messages).toEqual([
      { role: "assistant", content: [anthropicState.block] },
      { role: "user", content: [{ type: "text", text: "go on" }] },
    ]);
  });

  it("merges the block into a following assistant reply instead of stacking two", () => {
    const reply = { role: "assistant", content: [{ type: "text", text: "kept reply" }] };
    const params = {
      messages: [summaryAnthropicMessage, reply, { role: "user", content: "next" }],
    };
    const projected = projectAnthropicCompaction(params, anthropicState);
    expect(projected?.messages).toEqual([
      { role: "assistant", content: [anthropicState.block, { type: "text", text: "kept reply" }] },
      { role: "user", content: "next" },
    ]);
  });

  it("leaves payloads without a summary message alone", () => {
    expect(
      projectAnthropicCompaction(
        { messages: [{ role: "user", content: "fresh" }] },
        anthropicState,
      ),
    ).toBeUndefined();
  });
});

describe("details round trip", () => {
  it("fails closed on a malformed durable checkpoint rather than using its placeholder", () => {
    expect(() =>
      providerCompactionFromDetails({
        providerCompaction: { kind: "openai-responses", items: [] },
      }),
    ).toThrow("malformed");
  });
  it("reads stored state back and rejects foreign details", () => {
    const state: ProviderCompactionState = {
      kind: "openai-responses",
      items: [{ type: "compaction", encrypted_content: "opaque" }],
      model: "gpt-5.3-codex",
      compactedAt: 1,
    };
    const details = { providerCompaction: JSON.parse(JSON.stringify(state)) };
    expect(providerCompactionFromDetails(details)).toEqual(state);
    expect(readProviderCompaction(details)).toEqual({ kind: "state", state });
    expect(readProviderCompaction({ other: true }).kind).toBe("absent");
    expect(readProviderCompaction(undefined).kind).toBe("absent");
    // A Pi-written details object (arbitrary JSON) never reads as native.
    expect(readProviderCompaction({ pi: "whatever Pi wrote" }).kind).toBe("absent");
  });
});
