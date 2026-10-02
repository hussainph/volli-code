/**
 * The bench, run as a test, so its claims are checked rather than narrated.
 *
 *   pnpm -C packages/agent-runtime run bench
 *
 * The table it prints is the deliverable. The assertions around the table are
 * what make the table worth reading: each one is a property VC-245's decision
 * rests on, and every one of them is a property of Pi's real loop rather than
 * of this file. If a future Pi changes any of them, this fails loudly instead
 * of quietly making the design note wrong.
 *
 * It is out of the default `test` lane because it sleeps for real time. It is
 * not a smoke: it spends no money and reaches no provider.
 */

import { describe, expect, it } from "vite-plus/test";

import {
  peakConcurrency,
  runOnce,
  runRepeated,
  type ScriptedReply,
  type ToolSample,
} from "./harness";
import { buildReport } from "./report";

describe("Pi tool execution modes", () => {
  it("prints the benchmark table and holds every invariant it reports", async () => {
    const report = await buildReport();
    console.log(`\n${report.text}\n`);

    expect(report.findings).toEqual([]);

    for (const scenario of report.scenarios) {
      // The headline finding: mode is a scheduler choice, not a context
      // choice. Identical scripts cost identical tokens and identical model
      // calls in both modes.
      expect(
        scenario.parallelTokens,
        `${scenario.id} token totals must not move with execution mode`,
      ).toBe(scenario.sequentialTokens);
      expect(
        scenario.parallelModelCalls,
        `${scenario.id} model-call count must not move with execution mode`,
      ).toBe(scenario.sequentialModelCalls);
    }

    const control = report.scenarios.find((entry) => entry.id === "control-single-call");
    expect(control?.peakConcurrency, "a single call cannot overlap anything").toBe(1);

    const unbatched = report.scenarios.find((entry) => entry.id === "browser-tabs-unbatched");
    expect(
      unbatched?.peakConcurrency,
      "one call per assistant reply leaves parallel mode nothing to overlap",
    ).toBe(1);

    const batched = report.scenarios.find((entry) => entry.id === "browser-tabs-batched");
    expect(batched?.peakConcurrency, "four batched reads should overlap").toBe(4);
  }, 600_000);

  it("runs a batched read-only fan-out concurrently and keeps result order", async () => {
    // Latencies DESCEND across the batch on purpose. With one latency for every
    // call, completion order equals source order by construction and the
    // ordering assertion below can never catch Pi persisting in completion
    // order — it would pass against a broken Pi. Making the first call the
    // slowest forces the two orders apart, so the invariant is actually put
    // under load rather than merely observed holding.
    const spec = {
      tools: [
        { name: "slow", latencyMs: 240 },
        { name: "middle", latencyMs: 120 },
        { name: "quick", latencyMs: 20 },
      ],
      replies: [
        {
          toolCalls: [
            { name: "slow", args: { n: 0 } },
            { name: "middle", args: { n: 1 } },
            { name: "quick", args: { n: 2 } },
          ],
        },
        { text: "done" },
      ],
      providerLatencyMs: 0,
    };

    const sequential = await runOnce({ ...spec, mode: "sequential" as const });
    const parallel = await runOnce({ ...spec, mode: "parallel" as const });

    expect(sequential.peakConcurrency).toBe(1);
    expect(parallel.peakConcurrency).toBe(3);
    expect(parallel.elapsedMs).toBeLessThan(sequential.elapsedMs);

    // The divergence the ordering promise exists to survive: fastest call
    // finishes first, slowest call is still persisted first.
    expect(parallel.completionOrder).toEqual(["tc-1-2", "tc-1-1", "tc-1-0"]);
    expect(parallel.completionOrder).not.toEqual(parallel.resultOrder);

    // Pi's documented promise: completion order may vary, persisted order is
    // assistant source order. Volli's transcript and history both depend on
    // it, so it is asserted under that divergence rather than assumed.
    expect(parallel.resultOrder).toEqual(["tc-1-0", "tc-1-1", "tc-1-2"]);
    expect(parallel.resultOrder).toEqual(sequential.resultOrder);
  });

  it("lets ONE sequential-only tool force an entire batch back to sequential", async () => {
    // The trap. Marking side-effecting tools `executionMode: "sequential"` is
    // the obvious safety lever, and Pi applies it to the whole batch, not to
    // the marked call. Three fast reads batched beside one guarded call lose
    // all of their overlap.
    const replies: ScriptedReply[] = [
      {
        toolCalls: [
          { name: "browser_navigate", args: { n: 0 } },
          { name: "browser_navigate", args: { n: 1 } },
          { name: "browser_navigate", args: { n: 2 } },
          { name: "session_start", args: {} },
        ],
      },
      { text: "done" },
    ];

    const guarded = await runOnce({
      mode: "parallel",
      providerLatencyMs: 0,
      replies,
      tools: [
        { name: "browser_navigate", latencyMs: 120 },
        { name: "session_start", latencyMs: 10, executionMode: "sequential" },
      ],
    });

    const unguarded = await runOnce({
      mode: "parallel",
      providerLatencyMs: 0,
      replies,
      tools: [
        { name: "browser_navigate", latencyMs: 120 },
        { name: "session_start", latencyMs: 10 },
      ],
    });

    expect(guarded.peakConcurrency, "one sequential tool poisons the whole batch").toBe(1);
    expect(unguarded.peakConcurrency).toBe(4);
    expect(guarded.elapsedMs).toBeGreaterThan(unguarded.elapsedMs);
  });
});

describe("peakConcurrency", () => {
  it("does not count a call that ends exactly as the next one starts", () => {
    const samples: ToolSample[] = [
      { tool: "a", toolCallId: "1", startedAt: 0, endedAt: 10 },
      { tool: "a", toolCallId: "2", startedAt: 10, endedAt: 20 },
    ];
    expect(peakConcurrency(samples)).toBe(1);
  });

  it("counts genuine overlap", () => {
    const samples: ToolSample[] = [
      { tool: "a", toolCallId: "1", startedAt: 0, endedAt: 10 },
      { tool: "a", toolCallId: "2", startedAt: 5, endedAt: 15 },
      { tool: "a", toolCallId: "3", startedAt: 6, endedAt: 8 },
    ];
    expect(peakConcurrency(samples)).toBe(3);
  });

  it("is zero for no samples", () => {
    expect(peakConcurrency([])).toBe(0);
  });
});

describe("runRepeated", () => {
  it("reports a median and a representative run drawn from the samples", async () => {
    const outcome = await runRepeated(
      {
        mode: "parallel",
        providerLatencyMs: 0,
        tools: [{ name: "read", latencyMs: 5 }],
        replies: [{ toolCalls: [{ name: "read" }] }, { text: "done" }],
      },
      3,
    );
    expect(outcome.elapsedMsAll).toHaveLength(3);
    expect(outcome.representative.toolCalls).toBe(1);
    expect(outcome.elapsedMsMedian).toBeGreaterThanOrEqual(5);
  });
});
