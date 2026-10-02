/**
 * Test-only Streamable HTTP MCP fixture for VC-444's isolated runtime bench.
 *
 * This server is local, unauthenticated and intentionally side-effect free
 * unless `sideEffect` is set by a negative-control test. It never reaches a
 * configured or remote MCP server.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { sleep } from "@volli/agent-runtime/bench/mcp-parallel";

export interface FixtureMcpServerOptions {
  id: string;
  latencyMs: number;
  resultChars?: number;
  maxConcurrent?: number;
  maxRequestsPerWindow?: number;
  rateWindowMs?: number;
  sideEffect?: boolean;
}

export interface FixtureToolCall {
  toolName: string;
  startedAtMs: number;
  endedAtMs: number;
  status: "completed" | "connection-limited" | "rate-limited" | "cancelled";
}

export interface FixtureMcpServer {
  id: string;
  url: string;
  readonly calls: readonly FixtureToolCall[];
  readonly errors: number;
  readonly cancelled: number;
  readonly peakConcurrency: number;
  readonly sideEffectCount: number;
  readonly activeCalls: number;
  /** True once the HTTP server has stopped listening. */
  readonly closed: boolean;
  resetMeasurements(): void;
  close(): Promise<void>;
}

export async function startFixtureMcpServer(
  options: FixtureMcpServerOptions,
): Promise<FixtureMcpServer> {
  const calls: FixtureToolCall[] = [];
  let active = 0;
  let peakConcurrency = 0;
  let errors = 0;
  let cancelled = 0;
  let sideEffectCount = 0;
  let rateWindowStart = performance.now();
  let requestsInWindow = 0;
  const maxConcurrent = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
  const maxRequestsPerWindow = options.maxRequestsPerWindow ?? Number.POSITIVE_INFINITY;
  const rateWindowMs = options.rateWindowMs ?? 100;
  const latencyMs = options.latencyMs;
  const resultChars = options.resultChars ?? 96;

  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: `volli-vc444-${options.id}`, version: "1.0.0" });
      const register = (toolName: string, sideEffect: boolean): void => {
        mcp.registerTool(
          toolName,
          { description: `Local fixture ${toolName}; output and effects are synthetic.` },
          async (context) => {
            const startedAtMs = performance.now();
            if (startedAtMs - rateWindowStart >= rateWindowMs) {
              rateWindowStart = startedAtMs;
              requestsInWindow = 0;
            }
            if (requestsInWindow >= maxRequestsPerWindow) {
              errors += 1;
              calls.push({
                toolName,
                startedAtMs,
                endedAtMs: performance.now(),
                status: "rate-limited",
              });
              return {
                content: [{ type: "text", text: "Fixture rate limit exceeded (no retry)." }],
                isError: true,
              };
            }
            requestsInWindow += 1;
            if (active >= maxConcurrent) {
              errors += 1;
              calls.push({
                toolName,
                startedAtMs,
                endedAtMs: performance.now(),
                status: "connection-limited",
              });
              return {
                content: [{ type: "text", text: "Fixture per-server connection limit exceeded." }],
                isError: true,
              };
            }

            active += 1;
            peakConcurrency = Math.max(peakConcurrency, active);
            try {
              await sleep(latencyMs, context.http?.req?.signal ?? new AbortController().signal);
              if (sideEffect) sideEffectCount += 1;
              const prefix = `${options.id}:${toolName}:`;
              const text = `${prefix}${"x".repeat(Math.max(0, resultChars - prefix.length))}`;
              calls.push({
                toolName,
                startedAtMs,
                endedAtMs: performance.now(),
                status: "completed",
              });
              return { content: [{ type: "text", text }] };
            } catch (error) {
              cancelled += 1;
              calls.push({
                toolName,
                startedAtMs,
                endedAtMs: performance.now(),
                status: "cancelled",
              });
              throw error;
            } finally {
              active -= 1;
            }
          },
        );
      };
      register("fixture_read", false);
      register("fixture_mutate", options.sideEffect ?? false);
      return mcp;
    },
    { responseMode: "auto" },
  );
  const server = createServer(toNodeHandler(handler));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("Fixture MCP server did not listen");

  return {
    id: options.id,
    url: `http://127.0.0.1:${address.port}/mcp`,
    get calls() {
      return calls;
    },
    get errors() {
      return errors;
    },
    get cancelled() {
      return cancelled;
    },
    get peakConcurrency() {
      return peakConcurrency;
    },
    get sideEffectCount() {
      return sideEffectCount;
    },
    get activeCalls() {
      return active;
    },
    get closed() {
      return !server.listening;
    },
    resetMeasurements() {
      calls.length = 0;
      errors = 0;
      cancelled = 0;
      peakConcurrency = 0;
      sideEffectCount = 0;
      rateWindowStart = performance.now();
      requestsInWindow = 0;
    },
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
