import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus, platform } from "node:os";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import type { RuntimeObservation } from "@volli/shared";
import { createPiAgentRuntime } from "../../src/pi/runtime.ts";
import { summarize } from "../turn-to-completion/measurement.ts";
import { createDurableSpikeRuntime } from "./runtime.ts";
import { fallback, fixtureModels, fixtureSpec } from "./fixture.ts";

async function bytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return total;
}

describe("VC-497 paired short-turn runtime overhead", () => {
  it("measures current JSONL and Durable SQLite adapter with the same zero-delay read round", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".pi-durable-overhead-"));
    const samples: Record<
      string,
      { open: number[]; turn: number[]; bytes: number[]; observations: number[] }
    > = {
      current: { open: [], turn: [], bytes: [], observations: [] },
      durable: { open: [], turn: [], bytes: [], observations: [] },
    };
    try {
      // 2 paired warmups + 20 paired samples, alternating order to limit cache/order bias.
      for (let sample = -2; sample < 20; sample++)
        for (const arm of sample % 2 ? ["durable", "current"] : ["current", "durable"]) {
          const at = join(directory, `${sample}-${arm}`);
          await import("node:fs/promises").then((fs) => fs.mkdir(at));
          await writeFile(join(at, "input.txt"), "safe read result");
          const emitted: RuntimeObservation[] = [];
          const spec = fixtureSpec(at, async (o) => {
            emitted.push(o);
          });
          let runtime;
          let modelCalls: () => number;
          if (arm === "current") {
            const faux = fauxProvider({
              models: [{ id: "spike", contextWindow: 200_000, maxTokens: 4096 }],
            });
            faux.setResponses([
              fauxAssistantMessage(
                fauxToolCall("read", { path: "input.txt" }, { id: "fixture-call" }),
                { stopReason: "toolUse" },
              ),
              fauxAssistantMessage("observed result: safe read result"),
            ]);
            const models = createModels();
            models.setProvider(faux.provider);
            modelCalls = () => faux.state.callCount;
            runtime = createPiAgentRuntime({
              sessionDataDir: join(at, "execution"),
              models,
              compactionPolicy: () => ({ autoCompaction: false }),
            });
          } else {
            const { models, faux } = fixtureModels("safe");
            modelCalls = () => faux.state.callCount;
            runtime = createDurableSpikeRuntime({
              enabled: true,
              fallback,
              models,
              checkpointPath: () => join(at, "execution", "agent.sqlite"),
            });
          }
          const openedAt = performance.now();
          const handle = await runtime.startSession(spec);
          const opened = performance.now() - openedAt;
          let turn: number;
          try {
            const startedAt = performance.now();
            expect(
              (await handle.submitUserMessage("run safe", "queue", "command-overhead")).kind,
            ).toBe("delivered");
            turn = performance.now() - startedAt;
          } finally {
            await handle.close();
          }
          expect(modelCalls()).toBe(2);
          expect(
            emitted.some(
              (o) =>
                o.kind === "activity" &&
                o.state === "completed" &&
                o.descriptor.nativeToolName === "read" &&
                JSON.stringify(o.output).includes("safe read result"),
            ),
          ).toBe(true);
          expect(
            emitted.some(
              (o) =>
                o.kind === "message-settled" &&
                o.message.text === "observed result: safe read result",
            ),
          ).toBe(true);
          if (sample >= 0) {
            samples[arm].open.push(opened);
            samples[arm].turn.push(turn);
            samples[arm].bytes.push(await bytes(join(at, "execution")));
            samples[arm].observations.push(emitted.length);
          }
        }
      const report = {
        node: process.version,
        platform: platform(),
        arch: process.arch,
        cpu: cpus()[0].model,
        concurrencyHint: process.env.VOLLI_CONCURRENCY_HINT,
        warmups: 2,
        pairedSamples: 20,
        arms: Object.fromEntries(
          Object.entries(samples).map(([arm, s]) => [
            arm,
            {
              openMs: summarize(s.open),
              turnMs: summarize(s.turn),
              closedExecutionBytes: summarize(s.bytes),
              observerCalls: summarize(s.observations),
            },
          ]),
        ),
      };
      console.log(`VC497_OVERHEAD ${JSON.stringify(report)}`);
      expect(samples.current.turn.length).toBe(20);
      expect(samples.durable.turn.length).toBe(20);
      if (process.env.VC497_REPORT)
        await writeFile(process.env.VC497_REPORT, JSON.stringify(report, null, 2));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
