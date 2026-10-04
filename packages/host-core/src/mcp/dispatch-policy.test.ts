import { DEFAULT_MCP_SERVER_LIMITS } from "@volli/agent-runtime";
import {
  mcpProviderToolName,
  type McpToolDefinition,
  type RuntimeMcpCall,
  type RuntimeMcpCallResult,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { desktopMcpDispatch, MCP_QUEUE_WAIT_LOG_MS } from "./dispatch-policy";
import { MCP_PARALLEL_DEV_ENV } from "./parallel-dev-config";

function definition(toolName: string, parallelRead?: true): McpToolDefinition {
  return {
    serverId: "server-1",
    toolName,
    providerName: mcpProviderToolName("server-1", "Fixture", toolName),
    description: "Read-only and safe to run concurrently.",
    inputSchema: { type: "object" },
    ...(parallelRead === undefined ? {} : { parallelRead }),
  };
}

function request(toolCallId: string): RuntimeMcpCall {
  return { serverId: "server-1", toolName: "read", arguments: {}, toolCallId };
}

const devEnv = (value: unknown) => ({ [MCP_PARALLEL_DEV_ENV]: JSON.stringify(value) });

afterEach(() => {
  vi.useRealTimers();
});

describe("desktopMcpDispatch (VC-454)", () => {
  it("is sequential with the shipped bound when the developer opt-in is absent", () => {
    const log = vi.fn();
    const dispatch = desktopMcpDispatch({ env: {}, packaged: false, log });
    const smuggled = definition("read", true);

    expect(dispatch.parallelMcpReads).toBe(false);
    // A mark nobody authored is stripped at birth and ignored at attach.
    expect(dispatch.forNewSession([smuggled])).toEqual([definition("read")]);
    expect(dispatch.forAttach([smuggled])).toEqual([definition("read")]);
    expect(log).not.toHaveBeenCalled();
  });

  it("stays off in a packaged build whatever the environment says", () => {
    const dispatch = desktopMcpDispatch({
      env: devEnv({ reads: ["server-1:read"] }),
      packaged: true,
      log: vi.fn(),
    });
    expect(dispatch.parallelMcpReads).toBe(false);
    expect(dispatch.forNewSession([definition("read")])).toEqual([definition("read")]);
  });

  it("stamps new Sessions from the allowlist and narrows frozen marks to it at attach", () => {
    const dispatch = desktopMcpDispatch({
      env: devEnv({ reads: ["server-1:read"] }),
      packaged: false,
      log: vi.fn(),
    });

    expect(dispatch.parallelMcpReads).toBe(true);
    expect(dispatch.forNewSession([definition("read"), definition("write")])).toEqual([
      definition("read", true),
      definition("write"),
    ]);
    // A tool taken off the list loses its frozen mark; a tool never marked is
    // not granted one after birth.
    expect(
      dispatch.forAttach([
        definition("read", true),
        definition("list", true),
        definition("search"),
      ]),
    ).toEqual([definition("read", true), definition("list"), definition("search")]);
  });

  it("logs a value it could not read and runs as if it were absent", () => {
    const log = vi.fn();
    const dispatch = desktopMcpDispatch({
      env: { [MCP_PARALLEL_DEV_ENV]: "{not json" },
      packaged: false,
      log,
    });
    expect(dispatch.parallelMcpReads).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^VOLLI_DEV_MCP_PARALLEL was ignored/));
  });

  it("bounds each server by the developer's limits, else the shipped default", async () => {
    const dispatch = desktopMcpDispatch({
      env: devEnv({ limits: { "server-1": { maxConcurrent: 1 } } }),
      packaged: false,
      log: vi.fn(),
    });
    const pending: Array<() => void> = [];
    const port = {
      call: () =>
        new Promise<RuntimeMcpCallResult>((resolve) =>
          pending.push(() => resolve({ content: [], isError: false })),
        ),
    };
    const bound = dispatch.bind({ port, close: async () => undefined });
    const first = bound.call(request("one"), new AbortController().signal);
    const second = bound.call(request("two"), new AbortController().signal);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(dispatch.budget.load("server-1")).toMatchObject({ active: 1, queued: 1 });
    pending.shift()!();
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!();
    await second;

    // A server the developer did not name gets the default.
    const other = dispatch.bind({ port, close: async () => undefined });
    const calls = Array.from({ length: DEFAULT_MCP_SERVER_LIMITS.maxConcurrent + 1 }, (_, index) =>
      other.call({ ...request(`d${index}`), serverId: "server-2" }, new AbortController().signal),
    );
    await vi.waitFor(() =>
      expect(dispatch.budget.load("server-2")).toMatchObject({
        active: DEFAULT_MCP_SERVER_LIMITS.maxConcurrent,
        queued: 1,
      }),
    );
    while (pending.length > 0) {
      pending.shift()!();
      await vi.waitFor(() => undefined);
    }
    await Promise.all(calls);
  });

  it("withdraws the Session's calls before closing its host, and leaves other Sessions alone", async () => {
    const dispatch = desktopMcpDispatch({
      env: devEnv({ limits: { "server-1": { maxConcurrent: 1 } } }),
      packaged: false,
      log: vi.fn(),
    });
    const order: string[] = [];
    const signals: AbortSignal[] = [];
    const port = {
      call: (_call: RuntimeMcpCall, signal: AbortSignal) =>
        new Promise<RuntimeMcpCallResult>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => {
              order.push("call aborted");
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const session = dispatch.bind({
      port,
      close: async () => {
        order.push("host closed");
      },
    });
    const running = session.call(request("running"), new AbortController().signal);
    const queued = session.call(request("queued"), new AbortController().signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    await session.dispose();

    await expect(running).rejects.toThrow("MCP attachment closed");
    await expect(queued).rejects.toThrow("MCP attachment closed");
    expect(order).toEqual(["call aborted", "host closed"]);
    expect(signals).toHaveLength(1);
  });

  it("logs a call that waited long for the bound, and not one that barely did", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const dispatch = desktopMcpDispatch({
      env: devEnv({ limits: { "server-1": { maxConcurrent: 1 } } }),
      packaged: false,
      log,
    });
    const finish: Array<() => void> = [];
    const bound = dispatch.bind({
      port: {
        call: () =>
          new Promise<RuntimeMcpCallResult>((resolve) =>
            finish.push(() => resolve({ content: [], isError: false })),
          ),
      },
      close: async () => undefined,
    });
    const signal = new AbortController().signal;
    const calls = [
      bound.call(request("a"), signal),
      bound.call(request("b"), signal),
      bound.call(request("c"), signal),
    ];
    await vi.advanceTimersByTimeAsync(MCP_QUEUE_WAIT_LOG_MS - 10);
    finish.shift()!();
    await vi.advanceTimersByTimeAsync(20);
    finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    finish.shift()!();
    await Promise.all(calls);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^MCP server server-1: a call waited 10\d\d ms for the shared per-server bound$/,
      ),
    );
  });
});
