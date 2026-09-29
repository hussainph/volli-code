/**
 * VC-444's off-by-default MCP parallel-dispatch pilot. Run with
 * `pnpm -C apps/desktop bench:mcp-parallel` (`MCP_PARALLEL_BENCH_REPEATS=1`
 * for a smoke). It is outside the desktop app's default test projects.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureMcpTool, runMixedSideEffectTurn } from "@volli/agent-runtime/bench/mcp-parallel";
import {
  mcpProviderToolName,
  type McpServerDraft,
  type McpToolDefinition,
  type RuntimeMcpCall,
  type RuntimeMcpPort,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { openMcpProtocolClient } from "../../../src/main/mcp/client";
import { McpSessionHost } from "../../../src/main/mcp/session-host";
import { FIXTURE_READ_ALLOWLIST, runMcpScenario } from "./harness";
import { startFixtureMcpServer } from "./http-fixture";
import { buildMcpBenchReport, DEFAULT_REPEATS } from "./report";

function definition(serverId: string, serverName: string, toolName: string): McpToolDefinition {
  return {
    serverId,
    toolName,
    providerName: mcpProviderToolName(serverId, serverName, toolName),
    description: "Read-only according to this untrusted fixture description.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function draft(serverId: string, name: string, url: string): McpServerDraft {
  return {
    id: serverId,
    name,
    enabled: true,
    transport: { type: "streamable-http", url },
  };
}

describe("VC-444 fixture-only MCP parallel pilot", () => {
  it("prints p50/p95 results across network, startup, server-count and batch-size regimes", async () => {
    const repeats = Number(process.env.MCP_PARALLEL_BENCH_REPEATS ?? DEFAULT_REPEATS);
    const report = await buildMcpBenchReport(repeats);
    console.log(`\n${report.text}\n`);

    expect(report.rows).toHaveLength(40);
    expect(report.text).toContain("20ms/1/cold/n1");
    expect(report.text).toContain("80ms/2/warm/n16");
    for (const row of report.rows) {
      const batchSize = Number(row.label.match(/n(\d+)$/)?.[1]);
      for (let index = 0; index < repeats; index += 1) {
        expect(row.sequential[index]?.fixtureCalls).toBe(batchSize);
        expect(row.parallel[index]?.fixtureCalls).toBe(batchSize);
        expect(row.unbatched[index]?.fixtureCalls).toBe(batchSize);
        expect(row.sequential[index]?.providerRequests).toBe(2);
        expect(row.parallel[index]?.providerRequests).toBe(2);
        expect(row.unbatched[index]?.providerRequests).toBe(batchSize + 1);
        expect(row.sequential[index]?.cleanup).toBe(true);
        expect(row.parallel[index]?.cleanup).toBe(true);
        expect(row.unbatched[index]?.cleanup).toBe(true);
        expect(row.sequential[index]?.resultOrder).toEqual(row.sequential[index]?.expectedOrder);
        expect(row.parallel[index]?.resultOrder).toEqual(row.parallel[index]?.expectedOrder);
        expect(row.unbatched[index]?.resultOrder).toEqual(row.unbatched[index]?.expectedOrder);
        expect(row.unbatched[index]?.resultBytes).toBe(row.parallel[index]?.resultBytes);
        expect(row.unbatched[index]?.resultTokens).toBe(row.parallel[index]?.resultTokens);
        expect(row.sequential[index]?.fixtureErrors).toBe(0);
        expect(row.parallel[index]?.fixtureErrors).toBe(0);
        expect(row.sequential[index]?.peakConcurrency).toBe(1);
        expect(row.parallel[index]?.peakConcurrency).toBeLessThanOrEqual(
          Number(row.label.match(/n(\d+)$/)?.[1]),
        );
        if (!row.label.endsWith("n1"))
          expect(row.parallel[index]?.peakConcurrency).toBeGreaterThan(1);
        expect(row.unbatched[index]?.peakConcurrency).toBeLessThanOrEqual(1);
      }
    }

    const highFanout = report.rows.find((row) => row.label === "80ms/1/warm/n16");
    expect(highFanout?.parallel[0]?.peakConcurrency).toBe(16);
    expect(highFanout?.sequential[0]?.peakConcurrency).toBe(1);
    expect(highFanout?.sequential[0]?.providerRequests).toBe(2);
    expect(highFanout?.parallel[0]?.providerRequests).toBe(2);
    expect(highFanout?.unbatched[0]?.providerRequests).toBe(17);
    const crossServer = report.rows.find((row) => row.label === "80ms/2/warm/n8");
    expect(crossServer?.parallel[0]?.completionOrder).not.toEqual(
      crossServer?.parallel[0]?.resultOrder,
    );
  }, 600_000);

  it("records per-server connection and rate limits without blind retries", async () => {
    const limited = await runMcpScenario({
      latencyMs: 20,
      serverCount: 2,
      startup: "warm",
      batchSize: 16,
      batchShape: "batched",
      mode: "parallel",
      providerLatencyMs: 0,
      coldStartMs: 0,
      maxConcurrent: 2,
      maxRequestsPerWindow: 6,
      rateWindowMs: 100,
    });
    console.log(
      `VC-444 limit stress (two servers, n=16, per-server maxConcurrent=2, 6 calls/100ms): ` +
        `${limited.fixtureErrors} fixture errors (${JSON.stringify(limited.serverErrorKinds)}), ` +
        `${limited.retryCount} retries, per-server peaks ${limited.fixturePeakPerServer.join(",")}.`,
    );

    expect(limited.fixtureErrors).toBeGreaterThan(0);
    expect(limited.serverErrorKinds["connection-limited"]).toBeGreaterThan(0);
    expect(limited.serverErrorKinds["rate-limited"]).toBeGreaterThan(0);
    expect(limited.fixturePeakPerServer).toEqual([2, 2]);
    expect(limited.retryCount).toBe(0);
    expect(limited.cleanup).toBe(true);
    expect(limited.openClients).toBe(limited.closedClients);
  }, 30_000);

  it("propagates cancellation through the Volli MCP wrapper and attachment host", async () => {
    const fixture = await startFixtureMcpServer({ id: "vc444-cancel", latencyMs: 500 });
    const server = draft(fixture.id, "local cancellation fixture", fixture.url);
    let opened = 0;
    let closed = 0;
    const host = new McpSessionHost({
      workspacePath: process.cwd(),
      servers: [server],
      open: async (serverDraft, workspace, signal) => {
        const client = await openMcpProtocolClient(serverDraft, workspace, signal);
        opened += 1;
        return {
          listTools: client.listTools,
          callTool: client.callTool,
          close: async () => {
            closed += 1;
            await client.close();
          },
        };
      },
    });
    const mcpDefinition = definition(fixture.id, "local cancellation fixture", "fixture_read");
    const tool = fixtureMcpTool(mcpDefinition, host.port, FIXTURE_READ_ALLOWLIST);
    const controller = new AbortController();
    let abortToSettleMs = 0;

    try {
      const call = tool.execute("cancel-id", {}, controller.signal);
      await vi.waitFor(() => expect(fixture.activeCalls).toBe(1), { timeout: 2_000 });
      const abortAt = performance.now();
      controller.abort(new Error("fixture cancellation"));
      await expect(call).rejects.toBeDefined();
      abortToSettleMs = performance.now() - abortAt;
      await vi.waitFor(() => expect(fixture.cancelled).toBe(1), { timeout: 2_000 });
      expect(fixture.activeCalls).toBe(0);
    } finally {
      await host.close();
      await fixture.close();
    }

    expect(opened).toBe(1);
    expect(closed).toBe(1);
    console.log(
      `VC-444 cancellation: server abort observed, active calls drained to 0, ` +
        `client closed ${closed}/${opened}; caller settled in ${abortToSettleMs.toFixed(1)}ms.`,
    );
  }, 10_000);

  it.each([
    {
      label: "a non-allowlisted MCP mutation",
      serverId: "vc444-side-effect",
      toolName: "fixture_mutate",
      // The server's claimed read-only description is not authority. Exact
      // allowlist membership (absent here) keeps this tool sequential.
      mcpExecutionMode: "sequential",
      sideEffects: 1,
    },
    {
      label: "an allowlisted MCP read",
      serverId: "vc444-fixture-1",
      toolName: "fixture_read",
      // Eligible to overlap on its own, but one sequential local edit in the
      // same emitted batch makes Pi run the whole batch serially.
      mcpExecutionMode: undefined,
      sideEffects: 0,
    },
  ] as const)(
    "serializes local-file edits mixed with $label despite parallel Agent mode",
    async ({ serverId, toolName, mcpExecutionMode, sideEffects }) => {
      const workspace = mkdtempSync(join(process.cwd(), ".vc444-mcp-negative-control-"));
      const filePath = join(workspace, "fixture.txt");
      const fixture = await startFixtureMcpServer({ id: serverId, latencyMs: 15, sideEffect: true });
      const host = new McpSessionHost({
        workspacePath: process.cwd(),
        servers: [draft(fixture.id, "local side-effect fixture", fixture.url)],
        open: openMcpProtocolClient,
      });
      const mcpDefinition = definition(fixture.id, "local side-effect fixture", toolName);
      const events: string[] = [];
      const intervals: Array<{ startedAt: number; endedAt: number }> = [];
      let live = 0;
      let peak = 0;
      const enter = (): void => {
        live += 1;
        peak = Math.max(peak, live);
      };
      const exit = (startedAt: number): void => {
        live -= 1;
        intervals.push({ startedAt, endedAt: performance.now() });
      };
      const port: RuntimeMcpPort = {
        call: async (request: RuntimeMcpCall, signal) => {
          const startedAt = performance.now();
          enter();
          try {
            const result = await host.port.call(request, signal);
            events.push(`mcp:${request.toolName}`);
            return result;
          } finally {
            exit(startedAt);
          }
        },
      };

      try {
        const run = await runMixedSideEffectTurn({
          mcpDefinition,
          port,
          allowlist: FIXTURE_READ_ALLOWLIST,
          filePath,
          probe: { enter, exit, record: (event) => events.push(event) },
        });
        expect(run.mcpExecutionMode).toBe(mcpExecutionMode);
        expect(peak).toBe(1);
        expect(events).toEqual(["file:first", `mcp:${toolName}`, "file:last"]);
        expect(readFileSync(filePath, "utf8")).toBe("last");
        expect(fixture.sideEffectCount).toBe(sideEffects);
        expect(run.resultOrder).toEqual(["tc-1-0", "tc-1-1", "tc-1-2"]);
        expect(intervals).toHaveLength(3);
      } finally {
        await host.close();
        await fixture.close();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
