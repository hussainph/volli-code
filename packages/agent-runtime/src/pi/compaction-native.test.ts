import {
  DEFAULT_COMPACTION_SETTINGS,
  MemorySessionRepo,
  type Entry,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { compactSession, compactionPathForModel } from "./compaction";
import { compactProviderNative } from "./provider-compaction";
import { piContext } from "./pi-context";

vi.mock("./provider-compaction", async (original) => ({
  ...(await original<typeof import("./provider-compaction")>()),
  compactProviderNative: vi.fn(),
}));
const native = vi.mocked(compactProviderNative);
const models = createModels();
const faux = fauxProvider({
  api: "openai-responses",
  provider: "openai",
  models: [{ id: "gpt-5" }],
});
models.setProvider(faux.provider);
const model = { ...models.getModel("openai", "gpt-5")!, baseUrl: "https://api.openai.com/v1" };
const measured: Usage = {
  input: 100,
  output: 10,
  cacheRead: 20,
  cacheWrite: 0,
  totalTokens: 130,
  cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.13 },
};
const state = {
  kind: "openai-responses" as const,
  items: [{ type: "compaction", encrypted_content: "opaque" }],
  model: "gpt-5",
  compactedAt: 10,
};
function path(): Entry[] {
  return [
    {
      type: "message",
      id: "m1",
      seq: 1,
      parentId: null,
      timestamp: 1,
      message: { role: "user", content: "original context to preserve", timestamp: 1 },
    },
    {
      type: "compaction",
      id: "c1",
      seq: 2,
      parentId: "m1",
      timestamp: 10,
      summary: "native placeholder",
      retainedTail: [],
      tokensBefore: 200_000,
      details: { providerCompaction: state },
      fromHook: false,
    },
    {
      type: "message",
      id: "m2",
      seq: 3,
      parentId: "c1",
      timestamp: 11,
      message: { role: "user", content: "later request", timestamp: 11 },
    },
  ];
}
function summary(stopReason: "stop" | "error", usage: Usage | undefined): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "portable summary" }],
    stopReason,
    usage: usage as Usage,
    timestamp: 20,
  };
}
async function run(usage: Usage | undefined, stopReason: "stop" | "error" = "stop") {
  const sent: unknown[] = [];
  const local = {
    completeSimple: vi.fn(async (_model, context) => {
      sent.push(context);
      return summary(stopReason, usage);
    }),
  } as unknown as typeof models;
  const sidecar = await new MemorySessionRepo().create({}, piContext());
  const outcome = await compactSession({
    sidecar,
    path: path(),
    models: local,
    model,
    settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
  });
  return { outcome, sent };
}

describe("native compaction fallback", () => {
  it("expands opaque state from the original history and sums both bills", async () => {
    native.mockResolvedValue({
      kind: "failed",
      message: "invalid native checkpoint",
      rawUsage: measured,
    });
    const { outcome, sent } = await run(measured);
    expect(JSON.stringify(sent)).toContain("original context to preserve");
    expect(JSON.stringify(sent)).not.toContain("native placeholder");
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.usage).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0.26 });
    expect(outcome.entry.details).not.toHaveProperty("providerCompaction");
  });

  it("retains the metered native attempt when local summary usage is absent or local summary fails", async () => {
    native.mockResolvedValue({
      kind: "failed",
      message: "invalid native checkpoint",
      rawUsage: measured,
    });
    const missing = await run(undefined);
    expect(missing.outcome.kind).toBe("compacted");
    if (missing.outcome.kind === "compacted") expect(missing.outcome.usage?.inputTokens).toBe(100);
    const failed = await run(undefined, "error");
    expect(failed.outcome).toMatchObject({
      kind: "failed",
      usage: { inputTokens: 100, costUsd: 0.13 },
    });
  });

  it("keeps native output and the caller-independent tail with a durable usage block", async () => {
    native.mockResolvedValue({
      kind: "compacted",
      state,
      textSummary: "",
      rawUsage: measured,
      usage: null,
    });
    const { outcome } = await run(measured);
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.entry.summary).toBe("Provider-native context checkpoint.");
    expect(outcome.entry.usage).toEqual(measured);
    expect(outcome.entry.details).toEqual({ providerCompaction: state });
  });

  it("does not fall through to a local request after cancellation", async () => {
    const controller = new AbortController();
    native.mockImplementation(async () => {
      controller.abort();
      return { kind: "failed", message: "aborted" };
    });
    const sidecar = await new MemorySessionRepo().create({}, piContext());
    const outcome = await compactSession({
      sidecar,
      path: path(),
      models,
      model,
      settings: DEFAULT_COMPACTION_SETTINGS,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: "failed", message: "Compaction aborted." });
  });

  it("does not resurrect an opaque checkpoint on another API, model or gateway", () => {
    for (const selected of [
      { ...model, id: "gpt-5.4" },
      { ...model, api: "openai-completions" },
      { ...model, baseUrl: "https://gateway.example/v1" },
    ]) {
      expect(compactionPathForModel(path(), selected).map((entry) => entry.id)).toEqual([
        "m1",
        "m2",
      ]);
    }
  });
});
