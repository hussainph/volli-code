import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "pi-durable-ai/models";
import { fauxAssistantMessage, fauxProvider } from "pi-durable-ai/providers/faux";
import { expect, it } from "vite-plus/test";
import { summarize } from "../turn-to-completion/measurement.ts";

it("prices raw SQLite with no watcher, watchEvents, and two Chord clients", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".pi-durable-watch-"));
  const context = BACKGROUND_CONTEXT;
  const arms: Record<string, unknown> = {};
  try {
    for (const arm of ["none", "events", "two-structural-clients"]) {
      const durations: number[] = [];
      let callbacks = 0;
      let opBytes = 0;
      for (let sample = -2; sample < 20; sample++) {
        const faux = fauxProvider({ models: [{ id: "spike" }] });
        faux.setResponses([fauxAssistantMessage("zero-delay answer")]);
        const models = createModels();
        models.setProvider(faux.provider);
        const harness = await Harness.open(
          await openNodeSqliteStorage(join(directory, `${arm}-${sample}.sqlite`)),
          { models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
          context,
        );
        const root = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "spike" } },
        });
        const stops: (() => Promise<unknown>)[] = [];
        if (arm === "events") {
          const events = await watchEvents(harness, root.id, context);
          events.start(async (batch) => {
            if (sample >= 0) callbacks++;
            expect(batch.length).toBeGreaterThan(0);
          });
          stops.push(() => events.stop());
        } else if (arm !== "none") {
          for (let client = 0; client < 2; client++) {
            const watch = await root.watch(context);
            expect(watch.value.conversation.id).toBe(root.id);
            watch.start(async (_value, ops) => {
              if (sample >= 0) {
                callbacks++;
                opBytes += JSON.stringify(ops).length;
              }
            });
            stops.push(() => watch.stop());
          }
        }
        const at = performance.now();
        await (
          await root.submit({ type: "input", content: "hello", requestId: "one-command" }, context)
        ).wait(context);
        if (sample >= 0) durations.push(performance.now() - at);
        // Let already queued delivery frames drain before stopping these fast fixture listeners.
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const stop of stops) await stop();
        const later = await root.watch(context);
        expect(later.value.entries.some((e) => e.kind === "pi.assistant")).toBe(true);
        await later.stop();
        await harness.close(context);
      }
      arms[arm] = { turnMs: summarize(durations), callbacks, structuralOpJsonChars: opBytes };
    }
    console.log(`VC497_WATCH ${JSON.stringify(arms)}`);
    if (process.env.VC497_WATCH_REPORT)
      await writeFile(process.env.VC497_WATCH_REPORT, JSON.stringify(arms, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
