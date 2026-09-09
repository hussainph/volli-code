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
async function run(
  usage: Usage | undefined,
  stopReason: "stop" | "error" = "stop",
  /** Whether the resolved credential can still replay the stored checkpoint. */
  replayable = false,
) {
  const sent: unknown[] = [];
  const local = {
    completeSimple: vi.fn(async (_model, context) => {
      sent.push(context);
      return summary(stopReason, usage);
    }),
    ...(replayable
      ? { getAuth: async () => ({ auth: { apiKey: "sk-test" }, source: "env" }) }
      : {}),
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
    // The compaction succeeded, so there is no failure to put in front of the
    // person — but a Session silently running on the lossier local mechanism
    // must still be able to say why when someone asks.
    expect(outcome.nativeFailure).toBe("invalid native checkpoint");
    expect(outcome.entry.details).toMatchObject({
      nativeCompactionFailure: "invalid native checkpoint",
    });
  });

  it("reconstructs original history when a REPLAYABLE checkpoint's native call fails", async () => {
    // The harder half of the same rule. Here the credential still can replay
    // the checkpoint, so the path filter keeps it and the local summarizer is
    // handed a history whose prefix is an empty native placeholder. Summarizing
    // that would throw the conversation away and keep the placeholder; the
    // fallback re-expands the original entries instead.
    native.mockResolvedValue({
      kind: "failed",
      message: "the provider refused the compaction",
      rawUsage: measured,
    });
    const { outcome, sent } = await run(measured, "stop", true);
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(JSON.stringify(sent)).toContain("original context to preserve");
    expect(JSON.stringify(sent)).not.toContain("native placeholder");
    expect(outcome.entry.details).not.toHaveProperty("providerCompaction");
    expect(outcome.nativeFailure).toBe("the provider refused the compaction");
  });

  it("records no native failure when native compaction was never applicable", async () => {
    native.mockResolvedValue({ kind: "unsupported", reason: "not a supported endpoint" });
    const { outcome } = await run(measured);
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.nativeFailure).toBeUndefined();
    expect(outcome.entry.details).not.toHaveProperty("nativeCompactionFailure");
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
    // The retained tail appears in the new context exactly once. A native
    // success that both wrote the tail into the entry AND left the original
    // messages after it would duplicate every kept turn on every later
    // request, which reads as a working compaction until the bill arrives.
    const kept = outcome.entry.retainedTail;
    expect(kept.length).toBeGreaterThan(0);
    for (const message of kept) {
      const occurrences = outcome.messages.filter((held) => held === message).length;
      expect(occurrences).toBe(1);
    }
    // …and the summary that replaced the prefix is the only one there is.
    expect(outcome.messages.filter((held) => held.role === "compactionSummary")).toHaveLength(1);
    expect(outcome.messages).toHaveLength(1 + kept.length);
  });

  it("stops before the local request only when the supplied signal aborted", async () => {
    // The same native failure, twice, differing only in whether the caller's
    // signal aborted. Without that difference the assertion would pass on an
    // implementation that never read the signal at all.
    const attempt = async (abort: boolean) => {
      const controller = new AbortController();
      const local = {
        completeSimple: vi.fn(async () => summary("stop", measured)),
      } as unknown as typeof models;
      native.mockImplementation(async () => {
        if (abort) controller.abort();
        return { kind: "failed", message: "native unavailable" };
      });
      const sidecar = await new MemorySessionRepo().create({}, piContext());
      const outcome = await compactSession({
        sidecar,
        path: path(),
        models: local,
        model,
        settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
        signal: controller.signal,
      });
      return { outcome, localCalls: vi.mocked(local.completeSimple).mock.calls.length };
    };
    const aborted = await attempt(true);
    expect(aborted.outcome).toEqual({ kind: "failed", message: "Compaction aborted." });
    expect(aborted.localCalls).toBe(0);
    // An unaborted signal takes the fallback, so the abort is what stopped it.
    const carriedOn = await attempt(false);
    expect(carriedOn.outcome.kind).toBe("compacted");
    expect(carriedOn.localCalls).toBeGreaterThan(0);
  });

  it("does not resurrect an opaque checkpoint on another API, model or route", () => {
    // The route argument is the resolved one, not the catalog's claim: a
    // Session whose credential became an OAuth subscription or an endpoint
    // override rebuilds from original history exactly as a model switch does.
    for (const [selected, route] of [
      [{ ...model, id: "gpt-5.4" }, true],
      [{ ...model, api: "openai-completions" }, true],
      [{ ...model, baseUrl: "https://gateway.example/v1" }, true],
      [model, false],
    ] as const) {
      const resolved = compactionPathForModel(path(), selected, route);
      expect(resolved.path.map((entry) => entry.id)).toEqual(["m1", "m2"]);
      expect(resolved.discarded).toEqual([]);
    }
    // The same model on the route that minted it keeps the checkpoint.
    const kept = compactionPathForModel(path(), model, true);
    expect(kept.path.map((entry) => entry.id)).toEqual(["m1", "c1", "m2"]);
  });

  it("recovers from original history when a durable checkpoint cannot be read", () => {
    // Fail-closed belongs on the outgoing projection. Here the history the
    // checkpoint replaced is still on disk, so the Session is recoverable and
    // an unreadable entry must not be able to make it unattachable.
    const corrupted = path();
    for (const entry of corrupted) {
      if (entry.type !== "compaction") continue;
      entry.details = { providerCompaction: { kind: "openai-responses", items: [] } };
    }
    const resolved = compactionPathForModel(corrupted, model, true);
    expect(resolved.path.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(resolved.discarded).toHaveLength(1);
    expect(resolved.discarded[0]).toContain("original history");
  });
});
