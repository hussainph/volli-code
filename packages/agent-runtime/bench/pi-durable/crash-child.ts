/** Spawned by the bench; the parent SIGKILLs only this owned child. */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RuntimeObservationTranslator,
  type TranslatedObservation,
} from "../../../session-engine/src/observation-translation.ts";
import { createDurableSpikeRuntime } from "./runtime.ts";
import { fallback, fixtureModels, fixtureSpec } from "./fixture.ts";

const [directory, scenario, phase] = process.argv.slice(2);
const first = phase === "first";
const { models, faux } = fixtureModels(scenario, first);
const translator = new RuntimeObservationTranslator({
  namespace: "pi-durable-spike",
  sessionId: "session-497",
  attachmentId: "attachment-497",
  now: () => 0,
});
const facts: TranslatedObservation[] = [];
const eventTypes: string[] = [];
let marked = false;
const mark = () => {
  if (marked) return;
  marked = true;
  process.send?.({ type: "checkpoint" });
};
const runtime = createDurableSpikeRuntime({
  enabled: true,
  fallback,
  models,
  checkpointPath: () => join(directory, "execution.sqlite"),
  onEvents: (types) => {
    eventTypes.push(...types);
    if (first && scenario === "stream" && types.includes("message_update")) mark();
  },
  probe: {
    beforeEffect: async (name) => {
      await appendFile(join(directory, "invocations.txt"), `${name}\n`);
    },
    afterEffect: async (_name, publish) => {
      await publish(); // details() awaits committed output, not merely a buffered chunk
      if (first) {
        mark();
        await new Promise<void>(() => {});
      }
    },
  },
});
const spec = fixtureSpec(directory, async (observation) => {
  await translator.translate(observation, async (fact) => {
    facts.push(fact);
    await appendFile(join(directory, `product-${phase}.jsonl`), `${JSON.stringify(fact)}\n`);
  });
});
const handle = await runtime.startSession(spec);
await handle.submitUserMessage(`run ${scenario}`, "queue", "command-497");
const once = await handle.reconcile(null);
const again = await handle.reconcile(once.cursor);
// Simulate an accepted Command whose receipt reply was lost; same key MUST not ask twice.
const before = faux.state.callCount;
await handle.submitUserMessage(`run ${scenario}`, "queue", "command-497");
const retriedModelCalls = faux.state.callCount - before;
await handle.close();
let invocations = "";
try {
  invocations = await readFile(join(directory, "invocations.txt"), "utf8");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
await writeFile(
  join(directory, "result.json"),
  JSON.stringify({ once, again, facts, eventTypes, invocations, retriedModelCalls }, null, 2),
);
process.send?.({ type: "finished" });
process.disconnect?.();
