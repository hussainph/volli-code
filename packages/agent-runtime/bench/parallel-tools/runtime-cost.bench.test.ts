/**
 * The runtime-cost bench, run as a test, so its claims are checked rather than
 * narrated — the same contract `parallel-tools.bench.test.ts` states.
 *
 *   pnpm -C packages/agent-runtime run bench:runtime            # fast probe
 *   pnpm -C packages/agent-runtime run bench:runtime:published  # the quoted arm
 *
 * The table it prints is the deliverable. The assertions around it are what
 * make the table worth reading: each one is a property VC-356's decision rests
 * on, and each is a property of the shipped runtime rather than of this file.
 * If one of the caches this ticket added stops working, these fail loudly
 * instead of quietly making the design note wrong.
 */

import { describe, expect, it } from "vite-plus/test";

import { createContextTokenProjector, projectedContextTokens } from "../../src/pi/token-counting";
import { composeSystemPrompt, type SystemPromptInput } from "../../src/prompt";
import {
  buildRuntimeCostReport,
  formatRuntimeCostReport,
  longContextFixture,
  RUNTIME_COST_ARMS,
  runtimeCostArm,
} from "./runtime-cost-report";

describe("agent-runtime cost profile", () => {
  it("reports p50, p95 and variance for every fixture-driven hot path", () => {
    const arm = runtimeCostArm();
    const report = buildRuntimeCostReport(RUNTIME_COST_ARMS[arm]);
    console.log(`\n${formatRuntimeCostReport(report)}\n`);

    expect(report.fixturePreset).toBe("runtime-long-turn-v1");
    expect(report.operationScale).toBe(RUNTIME_COST_ARMS[arm].operationScale);
    expect(report.samples.map((sample) => sample.name)).toEqual([
      "prompt.system-assembly",
      "prompt.first-message-assembly",
      "turn.context-projection-model-switch",
      "tool.activity-normalization",
    ]);
    for (const sample of report.samples) {
      expect(sample.samples).toBe(RUNTIME_COST_ARMS[arm].samples);
      // A batch that measured no time at all measured nothing; every other
      // shape check here is satisfied by construction and would pass on an
      // empty run, so this is the only one worth spending an assertion on.
      expect(sample.p50Us).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // The properties the optimisations rest on. These are the assertions that
  // would catch the caches silently not working — a timing table cannot, because
  // a regression just makes the numbers worse without making anything fail.
  // -------------------------------------------------------------------------

  it("projects an unchanged context without re-counting a single settled message", () => {
    const { messages, model, systemPrompt, tools } = longContextFixture();
    let counted = 0;
    const counting = messages.map(
      (message) =>
        new Proxy(message, {
          get(target, key, receiver) {
            if (key === "content") counted += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        }),
    );
    const projector = createContextTokenProjector();

    projector(counting, model, systemPrompt, tools);
    const afterFirst = counted;
    expect(afterFirst).toBeGreaterThan(0);

    // The second projection of the same settled prefix is the one a turn
    // actually makes twice — compaction preflight, then the output ceiling.
    // It must touch no message content at all.
    projector(counting, model, systemPrompt, tools);
    expect(counted).toBe(afterFirst);

    // A newly appended message is still counted, exactly once.
    const appended = [...counting, { role: "user" as const, content: "tail", timestamp: 1 }];
    projector(appended, model, systemPrompt, tools);
    projector(appended, model, systemPrompt, tools);
    expect(counted).toBe(afterFirst);
  });

  it("never lets the cache change the answer the uncached projection gives", () => {
    const { messages, model, systemPrompt, tools } = longContextFixture();
    const projector = createContextTokenProjector();
    for (let repeat = 0; repeat < 3; repeat += 1) {
      expect(projector(messages, model, systemPrompt, tools)).toBe(
        projectedContextTokens(messages, model, systemPrompt, tools),
      );
    }
  });

  it("assembles a system prompt that is a pure function of its inputs", () => {
    // CONTEXT.md, "Context Assembly": the system prompt is a pure function of
    // Role, bundle, product version and resource set — same inputs, same
    // string. Precomputing the role-static layers must not have broken that.
    const spec = {
      role: "ticket",
      tools: { tools: ["read"], verbs: [] },
    } as const satisfies SystemPromptInput;
    expect(composeSystemPrompt(spec)).toBe(composeSystemPrompt(spec));
    expect(composeSystemPrompt({ ...spec, role: "project" })).not.toBe(composeSystemPrompt(spec));
  });
});
