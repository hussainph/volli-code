/**
 * The opt-in, fixture-only MCP benchmark: the app-side composition (VC-444,
 * re-based onto the real Session path in VC-454).
 *
 * The Pi-facing half — `createPiAgentRuntime` with a scripted provider and the
 * Agent Tool Surface — comes from the package's bench
 * surface (`@volli/agent-runtime/bench/mcp-parallel`). This file composes its
 * MCP side with main's own `desktopMcpDispatch`, fed an environment the way
 * main is: the parallel arm sets `VOLLI_DEV_MCP_PARALLEL`, the sequential arm
 * sets nothing. Sessions are stamped, attachments bound through the budget,
 * and disposed, by the same code main runs, into the real desktop
 * `McpSessionHost` and protocol client, connected to local Streamable HTTP
 * fixture servers. Nothing here is imported by the shipping app.
 */
import { tmpdir } from "node:os";
import {
  DEFAULT_MCP_SERVER_LIMITS,
  type McpServerBudget,
  type McpServerLimits,
} from "@volli/agent-runtime";
import {
  peakConcurrency,
  runRuntimeMcpTurn,
  sleep,
  type BatchShape,
  type DispatchArm,
  type RuntimeMcpTurnResult,
  type RuntimeMcpTurnSpec,
  type ToolSample,
} from "@volli/agent-runtime/bench/mcp-parallel";
import {
  mcpProviderToolName,
  type McpServerDraft,
  type McpToolDefinition,
  type RuntimeMcpCall,
  type RuntimeMcpPort,
} from "@volli/shared";

import { openMcpProtocolClient } from "../../../src/main/mcp/client";
import { desktopMcpDispatch } from "../../../src/main/mcp/dispatch-policy";
import { MCP_PARALLEL_DEV_ENV } from "../../../src/main/mcp/parallel-dev-config";
import { McpSessionHost, type McpSessionHostOptions } from "../../../src/main/mcp/session-host";
import { startFixtureMcpServer, type FixtureMcpServer } from "./http-fixture";

export type { BatchShape, DispatchArm };
export type StartupState = "cold" | "warm";

export interface McpScenario {
  latencyMs: number;
  serverCount: 1 | 2;
  startup: StartupState;
  batchSize: number;
  batchShape: BatchShape;
  arm: DispatchArm;
  providerLatencyMs: number;
  coldStartMs: number;
  resultChars?: number;
  /** The fixture SERVER's own limits, which it enforces by failing calls. */
  maxConcurrent?: number;
  maxRequestsPerWindow?: number;
  rateWindowMs?: number;
  /** The HOST's per-server bound; the shipped default when absent. */
  hostLimits?: McpServerLimits;
}

export interface McpRunResult extends RuntimeMcpTurnResult {
  /** Summed host call intervals, from dispatch past the budget to settle. */
  toolTimeMs: number;
  /** Summed time calls waited in the per-server budget before dispatch. */
  queueWaitMs: number;
  fixtureErrors: number;
  fixtureCancelled: number;
  retryCount: number;
  /** Peak calls in flight at the host, across servers. */
  peakConcurrency: number;
  /** Peak calls in flight at the host, per server. */
  hostPeakPerServer: number[];
  /** Peak calls the fixture servers themselves saw running. */
  fixturePeakPerServer: number[];
  fixtureCalls: number;
  cleanup: boolean;
  openClients: number;
  closedClients: number;
  serverErrorKinds: Record<string, number>;
}

/**
 * The fixture's host-authored trust policy: exact `serverId:toolName` keys.
 * Tool descriptions (which claim "read-only") never enter this decision.
 */
export const FIXTURE_READS = ["vc444-fixture-1:fixture_read", "vc444-fixture-2:fixture_read"];

/**
 * The environment main would be launched with for one arm: the parallel arm
 * opts in with the fixture allowlist, the sequential arm is an ordinary
 * launch. `hostLimits` becomes the developer's per-server `limits`.
 */
export function armEnvironment(
  arm: DispatchArm,
  serverIds: readonly string[],
  hostLimits?: McpServerLimits,
): Record<string, string> {
  if (arm === "sequential" && hostLimits === undefined) return {};
  return {
    [MCP_PARALLEL_DEV_ENV]: JSON.stringify({
      reads: arm === "parallel" ? FIXTURE_READS : [],
      ...(hostLimits === undefined
        ? {}
        : {
            limits: Object.fromEntries(
              serverIds.map((id) => [
                id,
                {
                  maxConcurrent: hostLimits.maxConcurrent,
                  windowMs: hostLimits.windowMs,
                  ...(Number.isFinite(hostLimits.maxStarts)
                    ? { maxStarts: hostLimits.maxStarts }
                    : {}),
                },
              ]),
            ),
          }),
    }),
  };
}
const monotonicNow = (): number => performance.now();

export function fixtureDefinition(
  serverId: string,
  serverName: string,
  toolName = "fixture_read",
): McpToolDefinition {
  return {
    serverId,
    toolName,
    providerName: mcpProviderToolName(serverId, serverName, toolName),
    // A deliberately untrusted claim: only the fixture-owned exact-name
    // allowlist can select a parallel-safe tool in this harness.
    description: "Read-only and safe to run concurrently (untrusted fixture copy).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

export function fixtureDraft(fixture: FixtureMcpServer, name: string): McpServerDraft {
  return {
    id: fixture.id,
    name,
    enabled: true,
    transport: { type: "streamable-http", url: fixture.url },
  };
}

/** Client lifecycle as the harness saw it, for the cleanup checks. */
export interface ClientCounters {
  opened: number;
  closed: number;
}

/**
 * The real protocol client opener, counted, with an optional synthetic delay
 * before each server's first attach (the "cold" regime).
 */
export function countingOpen(
  counters: ClientCounters,
  coldStartMs = 0,
): NonNullable<McpSessionHostOptions["open"]> {
  const attached = new Set<string>();
  return async (server, workspace, signal) => {
    if (coldStartMs > 0 && !attached.has(server.id)) await sleep(coldStartMs, signal);
    const client = await openMcpProtocolClient(server, workspace, signal);
    attached.add(server.id);
    counters.opened += 1;
    return {
      listTools: client.listTools,
      callTool: client.callTool,
      close: async () => {
        counters.closed += 1;
        await client.close();
      },
    };
  };
}

/** A port that records each call's interval as it passes through. */
function traced(
  inner: RuntimeMcpPort,
  trace: Array<ToolSample & { serverId: string }>,
): RuntimeMcpPort {
  return {
    call: async (request: RuntimeMcpCall, signal) => {
      const startedAt = monotonicNow();
      try {
        return await inner.call(request, signal);
      } finally {
        trace.push({
          tool: request.toolName,
          toolCallId: request.toolCallId,
          serverId: request.serverId,
          startedAt,
          endedAt: monotonicNow(),
        });
      }
    },
  };
}

export interface ComposedSession {
  fixtures: FixtureMcpServer[];
  host: McpSessionHost;
  budget: McpServerBudget;
  /** The port a Session's runtime is handed: main's budget binding over the host. */
  port: RuntimeMcpPort;
  /** Whether main's runtime would honour parallel-read marks under this environment. */
  parallelMcpReads: boolean;
  /** One read per fixture server, as a Session born under this environment freezes it. */
  definitions: readonly McpToolDefinition[];
  /** Stamp other definitions the way main stamps a new root Session's. */
  born(definitions: readonly McpToolDefinition[]): readonly McpToolDefinition[];
  clients: ClientCounters;
  /** What main would have logged: a config it ignored, or a long queue wait. */
  dispatchLog: string[];
  /** Calls as the host saw them, after the budget let them through. */
  hostTrace: Array<ToolSample & { serverId: string }>;
  /** Calls as the runtime saw them, queue wait included. */
  sessionTrace: Array<ToolSample & { serverId: string }>;
  /** Dispose the attachment as main does, then stop every fixture server. */
  dispose(): Promise<boolean>;
}

/**
 * Local fixture servers plus main's MCP composition, built fresh per trial so
 * one measurement's window never spends the next one's starts.
 */
export async function composeSession(scenario: {
  arm: DispatchArm;
  latencyMs: number;
  serverCount: 1 | 2;
  coldStartMs?: number;
  resultChars?: number;
  maxConcurrent?: number;
  maxRequestsPerWindow?: number;
  rateWindowMs?: number;
  hostLimits?: McpServerLimits;
  sideEffect?: boolean;
  workspacePath?: string;
  ids?: readonly string[];
}): Promise<ComposedSession> {
  const fixtures: FixtureMcpServer[] = [];
  try {
    for (let index = 0; index < scenario.serverCount; index += 1) {
      fixtures.push(
        await startFixtureMcpServer({
          id: scenario.ids?.[index] ?? `vc444-fixture-${index + 1}`,
          latencyMs: scenario.latencyMs + (index === 0 ? 0 : Math.max(5, scenario.latencyMs / 4)),
          ...(scenario.resultChars === undefined ? {} : { resultChars: scenario.resultChars }),
          ...(scenario.maxConcurrent === undefined
            ? {}
            : { maxConcurrent: scenario.maxConcurrent }),
          ...(scenario.maxRequestsPerWindow === undefined
            ? {}
            : { maxRequestsPerWindow: scenario.maxRequestsPerWindow }),
          ...(scenario.rateWindowMs === undefined ? {} : { rateWindowMs: scenario.rateWindowMs }),
          ...(scenario.sideEffect === undefined ? {} : { sideEffect: scenario.sideEffect }),
        }),
      );
    }
  } catch (error) {
    await Promise.allSettled(fixtures.map((server) => server.close()));
    throw error;
  }
  const dispatchLog: string[] = [];
  const dispatch = desktopMcpDispatch({
    env: armEnvironment(
      scenario.arm,
      fixtures.map((fixture) => fixture.id),
      scenario.hostLimits,
    ),
    packaged: false,
    log: (message) => dispatchLog.push(message),
  });
  // The only thing main logs at construction is an environment it ignored.
  if (dispatchLog.length > 0) {
    await Promise.allSettled(fixtures.map((server) => server.close()));
    throw new Error(`The bench built an environment main would ignore: ${dispatchLog.join("; ")}`);
  }
  const clients: ClientCounters = { opened: 0, closed: 0 };
  const host = new McpSessionHost({
    workspacePath: scenario.workspacePath ?? tmpdir(),
    servers: fixtures.map((fixture, index) =>
      fixtureDraft(fixture, `VC-454 local fixture ${index + 1}`),
    ),
    open: countingOpen(clients, scenario.coldStartMs ?? 0),
  });
  const hostTrace: ComposedSession["hostTrace"] = [];
  const sessionTrace: ComposedSession["sessionTrace"] = [];
  const attachment = dispatch.bind({
    port: traced(host.rawPort, hostTrace),
    close: () => host.close(),
  });
  // Match main: the raw protocol call is budgeted, and person-routing wraps
  // that budget. Fixtures need no credentials and have nobody to ask.
  const routed = host.routed(attachment.call);
  return {
    fixtures,
    host,
    budget: dispatch.budget,
    port: traced({ call: (request, signal) => routed.call(request, signal) }, sessionTrace),
    parallelMcpReads: dispatch.parallelMcpReads,
    definitions: dispatch.forNewSession(
      fixtures.map((server) => fixtureDefinition(server.id, server.id)),
    ),
    born: (definitions) => dispatch.forNewSession(definitions),
    clients,
    dispatchLog,
    hostTrace,
    sessionTrace,
    async dispose() {
      await attachment.dispose();
      await Promise.all(fixtures.map((server) => server.close()));
      // Every client the host opened was closed, and every fixture server
      // has actually stopped listening — not merely been asked to.
      return (
        clients.opened > 0 &&
        clients.closed === clients.opened &&
        fixtures.every((server) => server.closed)
      );
    },
  };
}

/** Summed call intervals, overlapping or not. */
function span(trace: ReadonlyArray<ToolSample>): number {
  return trace.reduce((sum, call) => sum + call.endedAt - call.startedAt, 0);
}

function perServerPeak(
  trace: ReadonlyArray<ToolSample & { serverId: string }>,
  fixtures: readonly FixtureMcpServer[],
): number[] {
  return fixtures.map((fixture) =>
    peakConcurrency(trace.filter((call) => call.serverId === fixture.id)),
  );
}

/** Run one real Session turn against the local fixture MCP servers. */
export async function runMcpScenario(scenario: McpScenario): Promise<McpRunResult> {
  const composed = await composeSession({
    ...scenario,
    coldStartMs: scenario.startup === "cold" ? scenario.coldStartMs : 0,
  });
  const { fixtures, host, definitions } = composed;
  let disposed = false;
  try {
    if (scenario.startup === "warm") {
      // Straight to the host, past the budget: warming is not the workload.
      for (const definition of definitions) {
        await host.port.call(
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

    const spec: RuntimeMcpTurnSpec = {
      definitions,
      port: composed.port,
      parallelMcpReads: composed.parallelMcpReads,
      batchSize: scenario.batchSize,
      batchShape: scenario.batchShape,
      providerLatencyMs: scenario.providerLatencyMs,
    };
    const turn = await runRuntimeMcpTurn(spec);

    const serverCalls = fixtures.flatMap((server) => server.calls);
    const serverErrorKinds: Record<string, number> = {};
    for (const call of serverCalls) {
      if (call.status === "connection-limited" || call.status === "rate-limited") {
        serverErrorKinds[call.status] = (serverErrorKinds[call.status] ?? 0) + 1;
      }
    }
    const toolTimeMs = span(composed.hostTrace);
    const result = {
      ...turn,
      toolTimeMs,
      queueWaitMs: Math.max(0, span(composed.sessionTrace) - toolTimeMs),
      fixtureErrors: fixtures.reduce((sum, fixture) => sum + fixture.errors, 0),
      fixtureCancelled: fixtures.reduce((sum, fixture) => sum + fixture.cancelled, 0),
      retryCount:
        composed.hostTrace.length - new Set(composed.hostTrace.map((call) => call.toolCallId)).size,
      peakConcurrency: peakConcurrency(composed.hostTrace),
      hostPeakPerServer: perServerPeak(composed.hostTrace, fixtures),
      fixturePeakPerServer: fixtures.map((server) => server.peakConcurrency),
      fixtureCalls: serverCalls.length,
      serverErrorKinds,
    };
    disposed = true;
    const cleanup = await composed.dispose();
    return {
      ...result,
      cleanup,
      openClients: composed.clients.opened,
      closedClients: composed.clients.closed,
    };
  } finally {
    if (!disposed) await composed.dispose().catch(() => false);
  }
}

export interface BenchRunSet {
  sequential: McpRunResult[];
  parallel: McpRunResult[];
  unbatched: McpRunResult[];
}

export async function runScenarioRepeats(
  base: Omit<McpScenario, "arm" | "batchShape">,
  repeats: number,
): Promise<BenchRunSet> {
  const sequential: McpRunResult[] = [];
  const parallel: McpRunResult[] = [];
  const unbatched: McpRunResult[] = [];
  for (let index = 0; index < repeats; index += 1) {
    sequential.push(await runMcpScenario({ ...base, arm: "sequential", batchShape: "batched" }));
    parallel.push(await runMcpScenario({ ...base, arm: "parallel", batchShape: "batched" }));
    unbatched.push(await runMcpScenario({ ...base, arm: "parallel", batchShape: "unbatched" }));
  }
  return { sequential, parallel, unbatched };
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[rank]!;
}

/**
 * Nearest-rank p95 is the maximum for fewer than 20 samples, so a smaller run
 * labels its tail "max" rather than claiming a percentile it cannot resolve
 * (docs/performance-benchmark.md).
 */
export function tailLabel(samples: number): "p95" | "max" {
  return samples >= 20 ? "p95" : "max";
}

export function p50p95(values: readonly number[]): string {
  return `${quantile(values, 0.5).toFixed(1)}/${quantile(values, 0.95).toFixed(1)}`;
}

function resultVolume(run: McpRunResult) {
  return {
    bytes: run.resultBytes,
    tokens: run.resultTokens,
    toolErrors: run.toolErrors,
    fixtureErrors: run.fixtureErrors,
    serverErrorKinds: run.serverErrorKinds,
  };
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
    throw new Error(
      `Parallel and sequential runs returned different fixture result volume: ${JSON.stringify({ sequential: resultVolume(seq), parallel: resultVolume(par) })}`,
    );
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

export { DEFAULT_MCP_SERVER_LIMITS };
