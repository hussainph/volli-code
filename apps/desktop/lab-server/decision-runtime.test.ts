import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LabDecisionInput } from "./auto-select-plugin";

const pi = vi.hoisted(() => ({
  getModelOfType: vi.fn<(...args: unknown[]) => unknown>(),
  checkAuth: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  classify: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  owned: vi.fn<() => unknown>(),
}));

// Only model access is replaced. The real Pi classifier and decision service
// still validate the answer, report setup misses, and meter catalog usage.
vi.mock("../../../packages/agent-runtime/src/pi/models", () => ({ piOwnedModelAccess: pi.owned }));

const input: LabDecisionInput = {
  classifier: { providerId: "typesafe", modelId: "jev-latest" },
  request: {
    state: { message: "Fix a typo" },
    questions: {
      pick: { type: "choice", instructions: "Pick", criteria: { a: "Small", b: "Large" } },
    },
  },
};
const answer = {
  stopReason: "stop",
  provider: "typesafe",
  model: "jev-latest",
  answers: {
    pick: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 },
  },
  usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } },
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  pi.getModelOfType.mockReturnValue({ type: "classifier", id: "jev-latest", provider: "typesafe" });
  pi.checkAuth.mockResolvedValue({ type: "api_key" });
  pi.classify.mockResolvedValue(answer);
  pi.owned.mockReturnValue({
    catalogReady: Promise.resolve(),
    models: { getModelOfType: pi.getModelOfType, checkAuth: pi.checkAuth, classify: pi.classify },
  });
});

describe("live lab decision runtime", () => {
  it("does nothing on import and uses the real cloud classifier/service only for decide", async () => {
    const runtime = await import("./decision-runtime");
    expect(pi.owned).not.toHaveBeenCalled();
    const result = await runtime.decide(input, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected answer");
    expect(result.result.answers).toEqual(answer.answers);
    expect(result.result.model).toEqual({
      where: "cloud",
      providerId: "typesafe",
      modelId: "jev-latest",
    });
    expect(result.usage).toEqual([
      {
        cause: "decision",
        providerId: "typesafe",
        modelId: "jev-latest",
        inputTokens: 8,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0002,
        costBasis: "catalog-estimate",
      },
    ]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(pi.classify).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "typesafe", id: "jev-latest" }),
      input.request,
      { signal: expect.any(AbortSignal) },
    );
    await runtime.decide(input, new AbortController().signal);
    expect(pi.owned).toHaveBeenCalledTimes(1);
  });

  it("names the missing catalog classifier without sending a provider call", async () => {
    pi.getModelOfType.mockReturnValue(undefined);
    const { decide } = await import("./decision-runtime");
    const result = await decide(input, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "needs-setup",
        message: expect.stringContaining("typesafe/jev-latest is not in the model catalog"),
      },
      usage: [],
    });
    expect(pi.classify).not.toHaveBeenCalled();
  });

  it("names the provider that needs sign-in and hides auth errors", async () => {
    pi.checkAuth.mockRejectedValue(new Error("Bearer sk-private-auth-provider-body"));
    const { decide } = await import("./decision-runtime");
    const result = await decide(input, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "needs-setup",
        message: expect.stringContaining("typesafe/jev-latest needs its provider signed in"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-private");
    expect(pi.classify).not.toHaveBeenCalled();
  });

  it("never returns provider response bodies or thrown errors, while keeping billed usage", async () => {
    pi.classify.mockResolvedValueOnce({
      ...answer,
      stopReason: "error",
      errorMessage: "Bearer sk-private-response-body",
    });
    const { decide } = await import("./decision-runtime");
    const result = await decide(input, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider-error" },
      usage: [expect.objectContaining({ costUsd: 0.0002 })],
    });
    expect(JSON.stringify(result)).not.toContain("sk-private");
    pi.classify.mockRejectedValueOnce(new Error("Bearer sk-private-throw"));
    const thrown = await decide(input, new AbortController().signal);
    expect(thrown).toMatchObject({ ok: false, error: { code: "provider-error" } });
    expect(JSON.stringify(thrown)).not.toContain("sk-private");
  });

  it("does not forward malformed provider answers", async () => {
    pi.classify.mockResolvedValue({ ...answer, answers: { unsafe: "sk-private-provider-answer" } });
    const { decide } = await import("./decision-runtime");
    const result = await decide(input, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "malformed-answer" } });
    expect(JSON.stringify(result)).not.toContain("sk-private");
  });

  it("sanitizes catalog startup failures and retries on the next explicit action", async () => {
    pi.owned.mockImplementationOnce(() => {
      throw new Error("sk-private-catalog-error");
    });
    const { decide } = await import("./decision-runtime");
    const result = await decide(input, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: "runtime-unavailable" } });
    expect(JSON.stringify(result)).not.toContain("sk-private");
    expect((await decide(input, new AbortController().signal)).ok).toBe(true);
  });
});
