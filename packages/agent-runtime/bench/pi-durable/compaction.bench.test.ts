import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  CompactionEntry,
  CompactionTask,
  createRegistry,
  defineExtension,
  Harness,
  hook,
  LiveDoc,
  MemoryStorage,
  watchEvents,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { estimateMessageTokens as durableEstimate } from "@earendil-works/pi-ai/utils/estimate";
import { describe, expect, it } from "vite-plus/test";
import { estimateMessageTokens as volliEstimate } from "../../src/pi/token-counting.ts";
import { longContextFixture } from "../parallel-tools/runtime-cost-report.ts";

const context = BACKGROUND_CONTEXT;
describe("VC-497 compaction parity probes", () => {
  it("keeps manual compaction behind the busy-turn boundary and preserves stored history", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
    faux.setResponses([
      fauxAssistantMessage("answer ".repeat(200)),
      fauxAssistantMessage("answer ".repeat(200)),
      async () => {
        await held;
        return fauxAssistantMessage("final answer");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "fixed-summary",
        hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "fixture summary" }) })],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: { compaction: { enabled: false, keepRecentTokens: 100, backgroundTokens: 0 } },
      },
      context,
    );
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "tiny" } },
      });
      for (let i = 0; i < 2; i++)
        await (
          await root.submit({ type: "input", content: `question ${i}` }, context)
        ).wait(context);
      const busy = await root.submit({ type: "input", content: "held question" }, context);
      const task = await root.compact("keep exact instructions", context);
      const { state } = await harness.waitForTask(task, context);
      expect(state.outcome.status).toBe("completed");
      if (state.outcome.status !== "completed" || !state.outcome.result.submissionId)
        throw new Error("Missing summary placement");
      const placement = await harness.submission(state.outcome.result.submissionId, context);
      expect((await placement!.status(context)).status).toBe("queued");
      release();
      await busy.wait(context);
      await placement!.wait(context);
      const view = await root.context(context);
      expect(CompactionEntry.is(view.head)).toBe(true);
      const stored = (await root.entries({}, 100, undefined, context)).items;
      expect(stored.length).toBeGreaterThan(view.entries.length);
      console.log(
        `VC497_COMPACTION ${JSON.stringify({ manualPlacement: "queued-then-done", storedEntries: stored.length, activeEntries: view.entries.length })}`,
      );
    } finally {
      release();
      await harness.close(context);
    }
  });

  it("starts background compaction and inserts its summary without deleting history", async () => {
    const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
    faux.setResponses(
      Array.from({ length: 20 }, () => fauxAssistantMessage("answer ".repeat(200))),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "fixed-summary",
        hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "background summary" }) })],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: {
          compaction: { reserveTokens: 1000, keepRecentTokens: 100, backgroundTokens: 800 },
        },
      },
      context,
    );
    let background = 0;
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "tiny" } },
    });
    const events = await watchEvents(harness, root.id, context);
    events.start(async (batch) => {
      background += batch.filter((e) => e.type === "compaction_start" && !e.blocking).length;
    });
    try {
      for (let i = 0; i < 7; i++) {
        await (
          await root.submit({ type: "input", content: `question ${i}` }, context)
        ).wait(context);
        for (const status of (await harness.snapshot(LiveDoc, root.id, context))?.compactions ?? [])
          await harness.waitForTask(status.taskId, context);
      }
      await events.stop();
      expect(background).toBeGreaterThan(0);
      expect(
        (await root.entries({}, 100, undefined, context)).items.some((e) => CompactionEntry.is(e)),
      ).toBe(true);
      console.log(`VC497_BACKGROUND ${JSON.stringify({ compactionsStarted: background })}`);
    } finally {
      await harness.close(context);
    }
  });

  it("exposes the stock chars/4 versus model-aware estimateMessage mismatch", () => {
    const { model } = longContextFixture();
    const content = "你好世界，代码路径不可重复执行。".repeat(200);
    const message = { role: "user" as const, content, timestamp: 0 };
    const durable = durableEstimate(message);
    const volli = volliEstimate(message, model);
    expect(durable).toBe(Math.ceil(content.length / 4));
    expect(volli).toBeGreaterThan(durable);
    console.log(
      `VC497_ESTIMATE ${JSON.stringify({ fixture: "CJK x200", durable, volli, ratio: volli / durable })}`,
    );
  });
});
