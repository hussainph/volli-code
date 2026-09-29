/**
 * VC-444's opt-in, fixture-only MCP benchmark: the app-side composition.
 *
 * The Pi-facing half — the real Pi `Agent` loop, the VC-245 scripted provider
 * and the Volli MCP tool wrapper — comes from the package's bench surface
 * (`@volli/agent-runtime/bench/mcp-parallel`). This file binds it to the real
 * desktop `McpSessionHost` and protocol client, connected to local Streamable
 * HTTP fixture servers. Nothing here is imported by the shipping app.
 */
import {
  runScriptedMcpTurn,
  type BatchShape,
  type McpParallelAllowlist,
} from "@volli/agent-runtime/bench/mcp-parallel";
import {
  mcpProviderToolName,
  type McpServerDraft,
  type McpToolDefinition,
  type RuntimeMcpCall,
  type RuntimeMcpPort,
} from "@volli/shared";

import { openMcpProtocolClient } from "../../../src/main/mcp/client";
import { McpSessionHost, type McpSessionHostOptions } from "../../../src/main/mcp/session-host";
import { startFixtureMcpServer, type FixtureMcpServer } from "./http-fixture";

export type { BatchShape };
export type StartupState = "cold" | "warm";

export interface McpScenario {
  latencyMs: number;
  serverCount: 1 | 2;
  startup: StartupState;
  batchSize: number;
  batchShape: BatchShape;
  mode: "sequential" | "parallel";
  providerLatencyMs: number;
  coldStartMs: number;
  resultChars?: number;
  maxConcurrent?: number;
  maxRequestsPerWindow?: number;
  rateWindowMs?: number;
}

export interface McpRunResult {
  elapsedMs: number;
  toolTimeMs: number;
  providerRequests: number;
  providerTokens: number;
  resultBytes: number;
  resultTokens: number;
  toolErrors: number;
  fixtureErrors: number;
  retryCount: number;
  expectedOrder: string[];
  resultOrder: string[];
  completionOrder: string[];
  peakConcurrency: number;
  perServerPeak: number[];
  fixturePeakPerServer: number[];
  fixtureCalls: number;
  cleanup: boolean;
  openClients: number;
  closedClients: number;
  fixtureServersClosed: boolean;
  serverErrorKinds: Record<string, number>;
}

/**
 * The fixture's host-authored trust policy: exact `serverId:toolName` keys.
 * Tool descriptions (which claim "read-only") never enter this decision.
 */
export const FIXTURE_READ_ALLOWLIST: McpParallelAllowlist = new Set([
  "vc444-fixture-1:fixture_read",
  "vc444-fixture-2:fixture_read",
]);
const monotonicNow = (): number => performance.now();

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("MCP fixture startup cancelled"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function fixtureDefinition(
  serverId: string,
  serverName: string,
  toolName = "fixture_read",
): McpToolDefinition {
  return {
    serverId,
    toolName,
    providerName: mcpProviderToolName(serverId, serverName, toolName),
    // A deliberately untrusted claim: only the fixture-owned exact-name
    // allowlist below can select a parallel-safe tool in this test harness.
    description: "Read-only and safe to run concurrently (untrusted fixture copy).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function highestOverlap(samples: readonly { startedAt: number; endedAt: number }[]): number {
  const edges = samples
    .flatMap((sample) => [
      { at: sample.startedAt, delta: 1 },
      { at: sample.endedAt, delta: -1 },
    ])
    .toSorted((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let highest = 0;
  for (const edge of edges) {
    current += edge.delta;
    highest = Math.max(highest, current);
  }
  return highest;
}

function toolDefinitionsFor(servers: readonly FixtureMcpServer[]): McpToolDefinition[] {
  return servers.map((server) => fixtureDefinition(server.id, server.id));
}

/** Run one real Pi Agent turn against the local fixture MCP servers. */
export async function runMcpScenario(scenario: McpScenario): Promise<McpRunResult> {
  const fixtures: FixtureMcpServer[] = [];
  let host: McpSessionHost | undefined;
  const clientsOpened = new Set<string>();
  let openClients = 0;
  let closedClients = 0;
  let cleanup = false;
  const toolTrace: Array<{
    toolCallId: string;
    serverId: string;
    startedAt: number;
    endedAt: number;
  }> = [];

  try {
    for (let index = 0; index < scenario.serverCount; index += 1) {
      fixtures.push(
        await startFixtureMcpServer({
          id: `vc444-fixture-${index + 1}`,
          latencyMs: scenario.latencyMs + (index === 0 ? 0 : Math.max(5, scenario.latencyMs / 4)),
          ...(scenario.resultChars === undefined ? {} : { resultChars: scenario.resultChars }),
          ...(scenario.maxConcurrent === undefined
            ? {}
            : { maxConcurrent: scenario.maxConcurrent }),
          ...(scenario.maxRequestsPerWindow === undefined
            ? {}
            : { maxRequestsPerWindow: scenario.maxRequestsPerWindow }),
          ...(scenario.rateWindowMs === undefined ? {} : { rateWindowMs: scenario.rateWindowMs }),
        }),
      );
    }

    const servers: McpServerDraft[] = fixtures.map((fixture, index) => ({
      id: fixture.id,
      name: `VC-444 local fixture ${index + 1}`,
      enabled: true,
      transport: { type: "streamable-http", url: fixture.url },
    }));
    const open: NonNullable<McpSessionHostOptions["open"]> = async (server, workspace, signal) => {
      if (scenario.startup === "cold" && !clientsOpened.has(server.id)) {
        await abortableDelay(scenario.coldStartMs, signal);
      }
      const client = await openMcpProtocolClient(server, workspace, signal);
      clientsOpened.add(server.id);
      openClients += 1;
      return {
        listTools: client.listTools,
        callTool: client.callTool,
        close: async () => {
          closedClients += 1;
          await client.close();
        },
      };
    };
    const activeHost = new McpSessionHost({ workspacePath: process.cwd(), servers, open });
    host = activeHost;
    const definitions = toolDefinitionsFor(fixtures);

    if (scenario.startup === "warm") {
      for (const definition of definitions) {
        await activeHost.port.call(
          {
            serverId: definition.serverId,
            toolName: definition.toolName,
            arguments: {},
            toolCallId: `prewarm-${definition.serverId}`,
          },
          new AbortController().signal,
        );
      }
      for (const server of fixtures) server.resetMeasurements();
    }

    const port: RuntimeMcpPort = {
      call: async (request: RuntimeMcpCall, signal) => {
        const startedAt = monotonicNow();
        try {
          return await activeHost.port.call(request, signal);
        } finally {
          toolTrace.push({
            toolCallId: request.toolCallId,
            serverId: request.serverId,
            startedAt,
            endedAt: monotonicNow(),
          });
        }
      },
    };
    const turn = await runScriptedMcpTurn({
      definitions,
      port,
      allowlist: FIXTURE_READ_ALLOWLIST,
      batchSize: scenario.batchSize,
      batchShape: scenario.batchShape,
      mode: scenario.mode,
      providerLatencyMs: scenario.providerLatencyMs,
    });

    const serverCalls = fixtures.flatMap((server) => server.calls);
    const serverErrorKinds: Record<string, number> = {};
    for (const call of serverCalls) {
      if (call.status === "connection-limited" || call.status === "rate-limited") {
        serverErrorKinds[call.status] = (serverErrorKinds[call.status] ?? 0) + 1;
      }
    }
    const toolTimeMs = toolTrace.reduce((sum, call) => sum + call.endedAt - call.startedAt, 0);
    const peakConcurrency = highestOverlap(toolTrace);
    const perServerPeak = fixtures.map((server) =>
      highestOverlap(
        toolTrace
          .filter((call) => call.serverId === server.id)
          .map(({ startedAt: callStart, endedAt: callEnd }) => ({
            startedAt: callStart,
            endedAt: callEnd,
          })),
      ),
    );
    const retryCount = toolTrace.length - new Set(toolTrace.map((call) => call.toolCallId)).size;

    await activeHost.close();
    await Promise.all(fixtures.map((server) => server.close()));
    cleanup = closedClients === openClients && fixtures.length === scenario.serverCount;

    return {
      elapsedMs: turn.elapsedMs,
      toolTimeMs,
      providerRequests: turn.providerRequests,
      providerTokens: turn.providerTokens,
      resultBytes: turn.resultBytes,
      resultTokens: turn.resultTokens,
      toolErrors: turn.toolErrors,
      fixtureErrors: fixtures.reduce((sum, fixture) => sum + fixture.errors, 0),
      retryCount,
      expectedOrder: turn.expectedOrder,
      resultOrder: turn.resultOrder,
      completionOrder: turn.completionOrder,
      peakConcurrency,
      perServerPeak,
      fixturePeakPerServer: fixtures.map((server) => server.peakConcurrency),
      fixtureCalls: serverCalls.length,
      cleanup,
      openClients,
      closedClients,
      fixtureServersClosed: cleanup,
      serverErrorKinds,
    };
  } catch (error) {
    await host?.close().catch(() => undefined);
    await Promise.allSettled(fixtures.map((server) => server.close()));
    throw error;
  }
}

export interface BenchRunSet {
  sequential: McpRunResult[];
  parallel: McpRunResult[];
  unbatched: McpRunResult[];
}

export async function runScenarioRepeats(
  base: Omit<McpScenario, "mode" | "batchShape">,
  repeats: number,
): Promise<BenchRunSet> {
  const sequential: McpRunResult[] = [];
  const parallel: McpRunResult[] = [];
  const unbatched: McpRunResult[] = [];
  for (let index = 0; index < repeats; index += 1) {
    sequential.push(await runMcpScenario({ ...base, mode: "sequential", batchShape: "batched" }));
    parallel.push(await runMcpScenario({ ...base, mode: "parallel", batchShape: "batched" }));
    unbatched.push(await runMcpScenario({ ...base, mode: "parallel", batchShape: "unbatched" }));
  }
  return { sequential, parallel, unbatched };
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[rank]!;
}

export function p50p95(values: readonly number[]): string {
  return `${quantile(values, 0.5).toFixed(1)}/${quantile(values, 0.95).toFixed(1)}`;
}

export function assertSameBatchedOutcome(seq: McpRunResult, par: McpRunResult): void {
  if (seq.expectedOrder.join(",") !== seq.resultOrder.join(",")) {
    throw new Error(`Sequential result order mismatch: ${seq.resultOrder.join(",")}`);
  }
  if (par.expectedOrder.join(",") !== par.resultOrder.join(",")) {
    throw new Error(`Parallel result order mismatch: ${par.resultOrder.join(",")}`);
  }
  if (seq.providerRequests !== par.providerRequests || seq.providerTokens !== par.providerTokens) {
    throw new Error("Pi execution mode changed the same scripted provider request/token count.");
  }
  if (seq.resultBytes !== par.resultBytes || seq.resultTokens !== par.resultTokens) {
    throw new Error("Parallel and sequential runs returned different fixture result volume.");
  }
  if (seq.fixtureCalls !== par.fixtureCalls || seq.fixtureErrors !== par.fixtureErrors) {
    throw new Error("Pi execution mode changed the number or outcome of fixture MCP calls.");
  }
  if (seq.retryCount !== 0 || par.retryCount !== 0) {
    throw new Error("The scripted fixture benchmark unexpectedly retried an MCP call.");
  }
  if (!seq.cleanup || !par.cleanup)
    throw new Error("A benchmark Session did not clean up its MCP client.");
}
