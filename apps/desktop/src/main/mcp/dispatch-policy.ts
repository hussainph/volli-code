/**
 * How main's MCP calls are dispatched and bounded (VC-454), in one place that
 * main composes and the benchmark reuses rather than copies.
 *
 * - The developer-only parallel-read opt-in is read once, from the
 *   environment of an unpackaged build (see `parallel-dev-config.ts`).
 * - A new root Session's MCP definitions are stamped from its allowlist, the
 *   only place a parallel-read mark is ever written.
 * - An existing Session's frozen marks are narrowed to that allowlist when it
 *   attaches: a tool taken off the list stops running in parallel at the next
 *   launch, and nothing is ever granted to a Session after its birth.
 * - Every attachment's MCP port is bound through one process-wide
 *   `McpServerBudget`, and a call that waited long for it says so in the log.
 */
import { McpServerBudget } from "@volli/agent-runtime";
import {
  narrowParallelReadEligibility,
  withParallelReadEligibility,
  type McpToolDefinition,
  type McpToolKey,
  type RuntimeMcpPort,
} from "@volli/shared";

import { readMcpParallelDevConfig } from "./parallel-dev-config";

/** A queued call that waited at least this long is worth a log line. */
export const MCP_QUEUE_WAIT_LOG_MS = 1_000;

export interface DesktopMcpDispatch {
  /** Whether the runtime may honour frozen parallel-read marks at all. */
  readonly parallelMcpReads: boolean;
  /** The process-wide per-server bound every attachment is bound through. */
  readonly budget: McpServerBudget;
  /** A new root Session's selected definitions, stamped from the allowlist. */
  forNewSession(definitions: readonly McpToolDefinition[]): readonly McpToolDefinition[];
  /** A Session's frozen definitions as it attaches, narrowed to the allowlist. */
  forAttach(definitions: readonly McpToolDefinition[]): readonly McpToolDefinition[];
  /** One attachment's MCP host, behind the budget, with the dispose order main needs. */
  bind(host: { port: RuntimeMcpPort; close(): Promise<void> }): {
    call: RuntimeMcpPort["call"];
    dispose: () => Promise<void>;
  };
}

export function desktopMcpDispatch(options: {
  env: Readonly<Record<string, string | undefined>>;
  packaged: boolean;
  log: (message: string) => void;
}): DesktopMcpDispatch {
  const opt = readMcpParallelDevConfig(options.env, { packaged: options.packaged });
  if (opt.kind === "invalid") options.log(opt.reason);
  const reads: ReadonlySet<McpToolKey> = opt.kind === "on" ? opt.config.reads : new Set();
  const budget = new McpServerBudget({
    limitsFor: (serverId) => (opt.kind === "on" ? opt.config.limits.get(serverId) : undefined),
    onQueueWait: ({ serverId, waitedMs }) => {
      if (waitedMs < MCP_QUEUE_WAIT_LOG_MS) return;
      options.log(
        `MCP server ${serverId}: a call waited ${Math.round(waitedMs)} ms for the shared per-server bound`,
      );
    },
  });
  return {
    parallelMcpReads: opt.kind === "on",
    budget,
    // Always stamped, so an empty allowlist also strips any mark a stored
    // catalog row might carry.
    forNewSession: (definitions) => withParallelReadEligibility(definitions, reads),
    forAttach: (definitions) => narrowParallelReadEligibility(definitions, reads),
    bind: (host) => {
      const bound = budget.bind(host.port);
      return {
        call: bound.call,
        // The binding first: this Session's queued calls are withdrawn and
        // its in-flight ones aborted before the host closes their clients.
        dispose: () => {
          bound.close();
          return host.close();
        },
      };
    },
  };
}
