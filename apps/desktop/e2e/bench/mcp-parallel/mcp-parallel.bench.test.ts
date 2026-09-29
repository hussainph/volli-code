/**
 * The off-by-default MCP parallel-dispatch bench, through the real Session
 * path (VC-444's pilot, re-based in VC-454). Run with
 * `pnpm -C apps/desktop bench:mcp-parallel` (`MCP_PARALLEL_BENCH_REPEATS=1`
 * for a smoke, `=20` or more to report a p95). It is outside the desktop
 * app's default test projects.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeMcpTurn } from "@volli/agent-runtime/bench/mcp-parallel";
import type { RuntimeMcpCall, RuntimeMcpPort } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  composeSession,
  DEFAULT_MCP_SERVER_LIMITS,
  fixtureDefinition,
  runMcpScenario,
} from "./harness";
import { buildMcpBenchReport, DEFAULT_REPEATS } from "./report";

describe("VC-454 MCP parallel dispatch through createPiAgentRuntime", () => {
  it("prints p50/tail results across network, startup, server-count and batch-size regimes", async () => {
    const repeats = Number(process.env.MCP_PARALLEL_BENCH_REPEATS ?? DEFAULT_REPEATS);
    const report = await buildMcpBenchReport(repeats);
    console.log(`\n${report.text}\n`);

    expect(report.rows).toHaveLength(40);
    expect(report.text).toContain("20ms/1/cold/n1");
    expect(report.text).toContain("80ms/2/warm/n16");
    const cap = DEFAULT_MCP_SERVER_LIMITS.maxConcurrent;
    for (const row of report.rows) {
      const batchSize = Number(row.label.match(/n(\d+)$/)?.[1]);
      for (let index = 0; index < repeats; index += 1) {
        const [seq, par, unb] = [
          row.sequential[index]!,
          row.parallel[index]!,
          row.unbatched[index]!,
        ];
        for (const run of [seq, par, unb]) {
          expect(run.fixtureCalls).toBe(batchSize);
          expect(run.cleanup).toBe(true);
          expect(run.resultOrder).toEqual(run.expectedOrder);
          expect(run.fixtureErrors).toBe(0);
          expect(run.retryCount).toBe(0);
          expect(run.fixtureCancelled).toBe(0);
          expect(run.turnState).toBe("completed");
          // Every call passed the Authority gate before it ran, and none
          // parked on a person.
          expect(run.gatedCalls).toBe(batchSize);
          expect(run.approvalWaitMs).toBe(0);
          for (const peak of run.hostPeakPerServer) expect(peak).toBeLessThanOrEqual(cap);
        }
        expect(seq.providerRequests).toBe(2);
        expect(par.providerRequests).toBe(2);
        expect(unb.providerRequests).toBe(batchSize + 1);
        expect(unb.resultBytes).toBe(par.resultBytes);
        expect(unb.resultTokens).toBe(par.resultTokens);
        expect(seq.toolExecution).toBe("sequential");
        expect(par.toolExecution).toBe("parallel");
        expect(seq.peakConcurrency).toBe(1);
        expect(unb.peakConcurrency).toBeLessThanOrEqual(1);
        if (batchSize > 1) expect(par.peakConcurrency).toBeGreaterThan(1);
      }
    }

    // The shipped bound, not the batch, sets the fan-out ceiling per server.
    const highFanout = report.rows.find((row) => row.label === "80ms/1/warm/n16");
    expect(highFanout?.parallel[0]?.peakConcurrency).toBe(cap);
    expect(highFanout?.parallel[0]?.queueWaitMs).toBeGreaterThan(0);
    const crossServer = report.rows.find((row) => row.label === "80ms/2/warm/n8");
    expect(crossServer?.parallel[0]?.completionOrder).not.toEqual(
      crossServer?.parallel[0]?.resultOrder,
    );
  }, 3_600_000);

  it("completes the VC-444 capacity stress batch with no limit errors under the host bound", async () => {
    const stress = {
      latencyMs: 20,
      serverCount: 2,
      startup: "warm",
      batchSize: 16,
      batchShape: "batched",
      providerLatencyMs: 0,
      coldStartMs: 0,
      maxConcurrent: 2,
      maxRequestsPerWindow: 6,
      rateWindowMs: 100,
    } as const;
    // The host-authored bound for these two servers matches what they publish.
    const bounded = await runMcpScenario({
      ...stress,
      arm: "parallel",
      hostLimits: { maxConcurrent: 2, maxStarts: 6, windowMs: 100 },
    });
    // The control: the same batch with only the shipped default for them.
    const unconfigured = await runMcpScenario({ ...stress, arm: "parallel" });
    const serial = await runMcpScenario({ ...stress, arm: "sequential" });
    console.log(
      `VC-454 limit stress (two servers, n=16, per-server maxConcurrent=2, 6 calls/100ms): ` +
        `host-bounded parallel ${bounded.fixtureErrors} fixture errors, host peaks ${bounded.hostPeakPerServer.join(",")}, ` +
        `fixture peaks ${bounded.fixturePeakPerServer.join(",")}, wall ${bounded.elapsedMs.toFixed(1)}ms, ` +
        `queue wait ${bounded.queueWaitMs.toFixed(1)}ms, ${bounded.retryCount} retries; ` +
        `default-bound parallel ${unconfigured.fixtureErrors} fixture errors (${JSON.stringify(unconfigured.serverErrorKinds)}), ` +
        `wall ${unconfigured.elapsedMs.toFixed(1)}ms; ` +
        `sequential ${serial.fixtureErrors} fixture errors, wall ${serial.elapsedMs.toFixed(1)}ms.`,
    );

    expect(bounded.fixtureErrors).toBe(0);
    expect(bounded.serverErrorKinds).toEqual({});
    expect(bounded.toolErrors).toBe(0);
    expect(bounded.hostPeakPerServer).toEqual([2, 2]);
    expect(bounded.fixturePeakPerServer.every((peak) => peak <= 2)).toBe(true);
    // Counted at the servers, below the host: a retry anywhere in the stack
    // would show up here as more than one server call per model tool call.
    expect(bounded.fixtureCalls).toBe(16);
    expect(bounded.retryCount).toBe(0);
    expect(bounded.resultOrder).toEqual(bounded.expectedOrder);
    expect(bounded.cleanup).toBe(true);
    // A server the host has no limits for gets the default, which is looser
    // than this one publishes: the bound is only as good as what it is told.
    expect(unconfigured.fixtureErrors).toBeGreaterThan(0);
    expect(unconfigured.fixtureCalls).toBe(16);
    expect(unconfigured.retryCount).toBe(0);
    expect(serial.fixtureErrors).toBe(0);
    expect(serial.fixturePeakPerServer).toEqual([1, 1]);
    expect(serial.cleanup).toBe(true);
  }, 60_000);

  it("withdraws in-flight and queued calls across two servers when a Session's turn is interrupted", async () => {
    // One slot per server, a 500 ms read, a four-call batch: two calls reach
    // the servers and two wait in the budget when the person presses stop.
    const composed = await composeSession({
      arm: "parallel",
      latencyMs: 500,
      serverCount: 2,
      hostLimits: { maxConcurrent: 1, maxStarts: Number.POSITIVE_INFINITY, windowMs: 1_000 },
    });
    const [first, second] = composed.fixtures;
    const bothRunning = vi.waitFor(
      () => {
        expect(first!.activeCalls).toBe(1);
        expect(second!.activeCalls).toBe(1);
      },
      { timeout: 5_000, interval: 5 },
    );
    let cleanup = false;
    try {
      const turn = await runRuntimeMcpTurn({
        // Round-robin over the two servers' reads: a, b, a, b.
        definitions: composed.definitions,
        port: composed.port,
        parallelMcpReads: composed.parallelMcpReads,
        batchSize: 4,
        batchShape: "batched",
        providerLatencyMs: 0,
        interruptWhen: bothRunning.then(() => {
          expect(composed.budget.load(first!.id)).toMatchObject({ active: 1, queued: 1 });
          expect(composed.budget.load(second!.id)).toMatchObject({ active: 1, queued: 1 });
        }),
      });
      await vi.waitFor(() => expect(first!.cancelled + second!.cancelled).toBe(2), {
        timeout: 5_000,
      });

      expect(turn.turnState).toBe("interrupted");
      expect(turn.interruptSettleMs).toBeGreaterThanOrEqual(0);
      expect(first!.activeCalls).toBe(0);
      expect(second!.activeCalls).toBe(0);
      // The queued half never reached a server.
      expect(first!.calls.length + second!.calls.length).toBe(2);
      for (const fixture of [first!, second!]) {
        expect(composed.budget.load(fixture.id)).toMatchObject({
          active: 0,
          queued: 0,
          admitted: 1,
        });
      }
      console.log(
        `VC-454 batch cancellation (two servers, 2 in flight + 2 queued): turn settled ` +
          `${turn.interruptSettleMs?.toFixed(1)}ms after stop; ` +
          `servers saw ${first!.cancelled + second!.cancelled} cancellations and ` +
          `${first!.calls.length + second!.calls.length} calls; active drained to 0.`,
      );
    } finally {
      cleanup = await composed.dispose();
    }
    expect(cleanup).toBe(true);
    expect(composed.clients.opened).toBe(2);
    expect(composed.clients.closed).toBe(2);
  }, 30_000);

  it.each([
    {
      label: "a non-allowlisted MCP mutation",
      serverId: "vc444-side-effect",
      toolName: "fixture_mutate",
      // The server's claimed read-only description is not authority. Exact
      // allowlist membership (absent here) keeps this tool sequential.
      mcpMarked: false,
      sideEffects: 1,
    },
    {
      label: "an allowlisted MCP read",
      serverId: "vc444-fixture-1",
      toolName: "fixture_read",
      // Eligible to overlap on its own, but the built-in write in the same
      // emitted batch is not, so Pi runs the whole batch serially.
      mcpMarked: true,
      sideEffects: 0,
    },
  ] as const)(
    "serializes built-in file writes mixed with $label in a parallel Session",
    async ({ serverId, toolName, mcpMarked, sideEffects }) => {
      const workspace = mkdtempSync(join(tmpdir(), "vc454-mcp-negative-control-"));
      const filePath = join(workspace, "fixture.txt");
      writeFileSync(filePath, "initial");
      const composed = await composeSession({
        arm: "parallel",
        latencyMs: 15,
        serverCount: 1,
        ids: [serverId],
        sideEffect: true,
        workspacePath: workspace,
      });
      // Born the way main births a root Session under the fixture allowlist:
      // only the allowlisted read is marked, whatever the mutation claims.
      const [definition] = composed.born([fixtureDefinition(serverId, serverId, toolName)]);
      expect(definition!.parallelRead === true).toBe(mcpMarked);
      const seenByMcp: string[] = [];
      const port: RuntimeMcpPort = {
        call: async (request: RuntimeMcpCall, signal) => {
          seenByMcp.push(`start:${readFileSync(filePath, "utf8")}`);
          try {
            return await composed.port.call(request, signal);
          } finally {
            seenByMcp.push(`end:${readFileSync(filePath, "utf8")}`);
          }
        },
      };

      try {
        const turn = await runRuntimeMcpTurn({
          definitions: [definition!],
          port,
          parallelMcpReads: composed.parallelMcpReads,
          batchSize: 3,
          batchShape: "batched",
          providerLatencyMs: 0,
          codingTools: ["write"],
          workspacePath: workspace,
          batch: [
            { name: "write", args: { path: filePath, content: "first" } },
            { name: definition!.providerName, args: {} },
            { name: "write", args: { path: filePath, content: "last" } },
          ],
        });
        // One call at a time, in source order: each finished before the next
        // started, and the MCP call saw exactly the first write.
        expect(turn.activityLog).toEqual([
          "started:tc-1-0",
          "completed:tc-1-0",
          "started:tc-1-1",
          "completed:tc-1-1",
          "started:tc-1-2",
          "completed:tc-1-2",
        ]);
        expect(seenByMcp).toEqual(["start:first", "end:first"]);
        expect(readFileSync(filePath, "utf8")).toBe("last");
        expect(composed.fixtures[0]!.sideEffectCount).toBe(sideEffects);
        expect(composed.fixtures[0]!.peakConcurrency).toBe(1);
        expect(turn.resultOrder).toEqual(["tc-1-0", "tc-1-1", "tc-1-2"]);
        expect(turn.toolErrors).toBe(0);
      } finally {
        await composed.dispose();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
