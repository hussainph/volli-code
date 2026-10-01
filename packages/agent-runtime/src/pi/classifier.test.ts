import { createModels, type Models } from "@earendil-works/pi-ai";
import type { DecisionRequest, DecisionTarget } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  confidentAnswer,
  fakeLlamaServer,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  FIXTURE_SECRET,
  fixtureModels,
} from "../decision/fixture.test-support";
import {
  classifierUsage,
  decisionTargetReady,
  inspectDecisionModels,
  LOCAL_DECISION_PROVIDER_ID,
  localClassifierModel,
  piDecisionClassifier,
  safeProviderDetail,
  testDecisionConnection,
} from "./classifier";

const CLOUD: DecisionTarget = {
  where: "cloud",
  providerId: FIXTURE_PROVIDER,
  modelId: FIXTURE_MODEL,
};
const LOCAL: DecisionTarget = {
  where: "local",
  server: "llama-cpp",
  baseUrl: "http://127.0.0.1:8080",
  modelId: "qwen3-4b",
};

const REQUEST: DecisionRequest = {
  state: { page: { title: "Sign in", fields: ["email", "password"] } },
  questions: {
    page: {
      type: "choice",
      instructions: "Which page is this?",
      criteria: { login: "A sign-in form", inbox: "A message list" },
    },
    filled: {
      type: "score",
      instructions: "How far is the form filled in?",
      criteria: ["empty", "partly", "complete"],
    },
    blocked: {
      type: "bool",
      instructions: "Is the person blocked by an error?",
      criteria: { true: "An error blocks them", false: "Nothing blocks them" },
    },
  },
};

const signal = (): AbortSignal => new AbortController().signal;

describe("the cloud path, through Pi's own provider dispatch", () => {
  it("classifies with the provider's own credential and bills the catalog estimate", async () => {
    const seen: NonNullable<Parameters<typeof fixtureModels>[0]>["seen"] = [];
    const result = await piDecisionClassifier(fixtureModels({ seen })).classify(CLOUD, REQUEST, {
      signal: signal(),
    });
    expect(result).toEqual({
      ok: true,
      answers: expect.objectContaining({ blocked: { type: "bool", probability: 0.92 } }),
      usage: {
        cause: "decision",
        providerId: FIXTURE_PROVIDER,
        modelId: FIXTURE_MODEL,
        inputTokens: 420,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0000176,
        costBasis: "catalog-estimate",
      },
    });
    // Pi resolved the key and handed it to the provider; nothing above saw it.
    expect(seen?.[0]?.apiKey).toBe(FIXTURE_SECRET);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_SECRET);
  });

  it("names the person's fix when the provider has no credential, before sending anything", async () => {
    const seen: unknown[] = [];
    const result = await piDecisionClassifier(
      fixtureModels({ signedIn: false, seen: seen as never }),
    ).classify(CLOUD, REQUEST, { signal: signal() });
    expect(result).toEqual({
      ok: false,
      usage: null,
      miss: { status: "unavailable", reason: "needs-setup", message: expect.any(String) },
    });
    expect(!result.ok && result.miss.message).toMatch(/signed in under Settings → Models/);
    expect(seen).toEqual([]);
  });

  it("treats an auth check that throws as no credential", async () => {
    const models = fixtureModels();
    const throwing = {
      ...models,
      getModelOfType: models.getModelOfType.bind(models),
      checkAuth: () => Promise.reject(new Error("store unreadable")),
    } as unknown as Models;
    const result = await piDecisionClassifier(throwing).classify(CLOUD, REQUEST, {
      signal: signal(),
    });
    expect(!result.ok && result.miss.reason).toBe("needs-setup");
  });

  it("says a model gone from the catalog needs a new choice", async () => {
    const result = await piDecisionClassifier(fixtureModels()).classify(
      { ...CLOUD, modelId: "retired" },
      REQUEST,
      { signal: signal() },
    );
    expect(!result.ok && result.miss).toMatchObject({
      reason: "needs-setup",
      message: expect.stringMatching(/not in the model catalog/),
    });
  });

  it("never hands on a provider's error text", async () => {
    const result = await piDecisionClassifier(
      fixtureModels({
        answer: () => ({
          stopReason: "error",
          errorMessage: `401 bad key ${FIXTURE_SECRET}`,
        }),
      }),
    ).classify(CLOUD, REQUEST, { signal: signal() });
    expect(result).toEqual({
      ok: false,
      usage: null,
      miss: {
        status: "error",
        reason: "provider-error",
        message: "The cloud decision model fixture/jev-fixture could not answer.",
      },
    });
  });

  it("reports an aborted call as withdrawn", async () => {
    const result = await piDecisionClassifier(
      fixtureModels({ answer: () => ({ stopReason: "aborted" }) }),
    ).classify(CLOUD, REQUEST, { signal: signal() });
    expect(!result.ok && result.miss.reason).toBe("aborted");
  });
});

describe("the local path, through Pi's llama.cpp classifier", () => {
  it("classifies every question type from next-token probabilities, and costs nothing", async () => {
    const seen: string[] = [];
    const result = await piDecisionClassifier(createModels(), {
      fetch: fakeLlamaServer(0.9, seen),
    }).classify(LOCAL, REQUEST, { signal: signal() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answers = result.answers as Record<string, Record<string, unknown>>;
    expect(answers["blocked"]).toEqual({ type: "bool", probability: expect.closeTo(0.9, 5) });
    expect(answers["page"]).toMatchObject({ type: "choice", choice: "login" });
    expect(answers["filled"]).toMatchObject({ type: "score", score: expect.closeTo(1.94, 1) });
    expect(result.usage).toEqual({
      cause: "decision",
      providerId: LOCAL_DECISION_PROVIDER_ID,
      modelId: "qwen3-4b",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0,
      costBasis: "catalog-estimate",
    });
    // The three llama-server endpoints, and only those.
    expect(new Set(seen)).toEqual(new Set(["/tokenize", "/apply-template", "/completion"]));
  });

  it("reaches the server through the process's own fetch when none is injected", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", fakeLlamaServer(0.6, seen));
    try {
      const result = await piDecisionClassifier(createModels()).classify(LOCAL, REQUEST, {
        signal: signal(),
      });
      expect(result.ok).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the server when it cannot be reached", async () => {
    const result = await piDecisionClassifier(createModels(), {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    }).classify(LOCAL, REQUEST, { signal: signal() });
    expect(!result.ok && result.miss.message).toBe(
      "The local llama.cpp server at http://127.0.0.1:8080 could not answer.",
    );
  });

  it("describes a local model as Pi's llama.cpp classifier reads it", () => {
    expect(
      localClassifierModel(LOCAL as Extract<DecisionTarget, { where: "local" }>),
    ).toMatchObject({
      type: "classifier",
      api: "llama-cpp-classify",
      provider: LOCAL_DECISION_PROVIDER_ID,
      id: "qwen3-4b",
      baseUrl: "http://127.0.0.1:8080",
    });
  });
});

describe("usage", () => {
  it("is an unpriced request when a cloud service reports none, and drops a non-finite cost", () => {
    expect(classifierUsage({ provider: "p", model: "m" }, "cloud")).toMatchObject({
      costUsd: null,
      costBasis: "unavailable",
      inputTokens: null,
    });
    expect(
      classifierUsage(
        {
          provider: "p",
          model: "m",
          usage: {
            input: Number.NaN,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN },
          },
        },
        "cloud",
      ),
    ).toMatchObject({ inputTokens: null, costUsd: null, costBasis: "unavailable" });
  });
});

describe("safeProviderDetail", () => {
  it("keeps the first line, capped, with secrets removed", () => {
    expect(safeProviderDetail(undefined)).toBeNull();
    expect(safeProviderDetail("   \nsecond")).toBeNull();
    expect(safeProviderDetail("llama.cpp returned 404\n<html>")).toBe("llama.cpp returned 404");
    expect(
      safeProviderDetail(`401: Bearer abc.def apiKey=${FIXTURE_SECRET} sk-live_123 x`),
    ).not.toMatch(/abc\.def|SECRET|sk-live/);
    expect(safeProviderDetail("x".repeat(300))?.length).toBe(160);
  });
});

describe("the connection test", () => {
  it("asks one real question end to end", async () => {
    let now = 1_000;
    const result = await testDecisionConnection(createModels(), LOCAL, {
      signal: signal(),
      fetch: fakeLlamaServer(0.97, []),
      now: () => (now += 40),
    });
    expect(result).toEqual({ ok: true, elapsedMs: 40, probability: expect.closeTo(0.97, 5) });
  });

  it("names a cloud model's missing sign-in", async () => {
    const result = await testDecisionConnection(fixtureModels({ signedIn: false }), CLOUD, {
      signal: signal(),
    });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/signed in/) });
  });

  it("shows a person the provider's status line, never a secret", async () => {
    const failing = await testDecisionConnection(
      fixtureModels({
        answer: () => ({
          stopReason: "error",
          errorMessage: `Fixture returned 401 ${FIXTURE_SECRET}`,
        }),
      }),
      CLOUD,
      { signal: signal() },
    );
    expect(failing).toMatchObject({
      ok: false,
      message: expect.stringMatching(/did not answer: Fixture returned 401/),
    });
    expect(JSON.stringify(failing)).not.toContain("SECRET");
    const silent = await testDecisionConnection(
      fixtureModels({ answer: () => ({ stopReason: "error" }) }),
      CLOUD,
      { signal: signal() },
    );
    expect(silent).toMatchObject({
      ok: false,
      message: expect.stringMatching(/did not answer\.$/),
    });
  });

  it("refuses an answer that is not a yes/no probability", async () => {
    const result = await testDecisionConnection(
      fixtureModels({
        answer: () => ({ answers: { approves: { type: "score", score: 1, confidence: 1 } } }),
      }),
      CLOUD,
      { signal: signal() },
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not with a yes\/no/),
    });
    const empty = await testDecisionConnection(
      fixtureModels({ answer: () => ({ answers: {} }) }),
      CLOUD,
      { signal: signal() },
    );
    expect(empty.ok).toBe(false);
  });
});

describe("readiness at Session birth", () => {
  it("is ready for a local server and a signed-in cloud model, and not otherwise", async () => {
    expect(await decisionTargetReady(createModels(), LOCAL, signal())).toBe(true);
    expect(await decisionTargetReady(fixtureModels(), CLOUD, signal())).toBe(true);
    expect(await decisionTargetReady(fixtureModels({ signedIn: false }), CLOUD, signal())).toBe(
      false,
    );
  });
});

describe("the decision model catalog", () => {
  it("lists every classifier Pi knows, with whether this profile can reach it", async () => {
    expect(await inspectDecisionModels(fixtureModels())).toEqual([
      {
        providerId: FIXTURE_PROVIDER,
        providerLabel: "Fixture Cloud",
        modelId: FIXTURE_MODEL,
        label: "Jev Fixture",
        state: "available",
        inputUsdPerMillion: 0.042,
        contextWindow: 32_000,
      },
    ]);
    expect(await inspectDecisionModels(fixtureModels({ signedIn: false }))).toMatchObject([
      { state: "needs-setup" },
    ]);
  });

  it("reads an availability check that throws as needs-setup, and sorts by provider then name", async () => {
    const models = fixtureModels();
    const jev = models.getModelOfType("classifier", FIXTURE_PROVIDER, FIXTURE_MODEL)!;
    const listed = [
      { ...jev, provider: "zeta", id: "b", name: "B", cost: { ...jev.cost, input: Number.NaN } },
      { ...jev, provider: "alpha", id: "z", name: "Z" },
      { ...jev, provider: "alpha", id: "a", name: "A" },
    ];
    const scripted = {
      getModelsOfType: () => listed,
      getProvider: (id: string) => (id === "alpha" ? { name: "Alpha" } : undefined),
      getAvailableOfType: () => Promise.reject(new Error("no")),
    } as unknown as Models;
    const controller = new AbortController();
    const entries = await inspectDecisionModels(scripted, { signal: controller.signal });
    expect(entries.map((entry) => [entry.providerLabel, entry.label, entry.state])).toEqual([
      ["Alpha", "A", "needs-setup"],
      ["Alpha", "Z", "needs-setup"],
      ["zeta", "B", "needs-setup"],
    ]);
    expect(entries[2]?.inputUsdPerMillion).toBe(0);
  });

  it("answers every question type the fixture is scripted for", async () => {
    // The shared fixture's own contract, which the service tests lean on.
    const partial = await confidentAnswer(
      { state: {}, questions: REQUEST.questions as never },
      undefined,
    );
    expect(Object.keys(partial.answers ?? {})).toEqual(["page", "filled", "blocked"]);
  });
});
