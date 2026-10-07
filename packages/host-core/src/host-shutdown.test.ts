import { describe, expect, it, vi } from "vite-plus/test";
import { closeAllMcpSessionHosts } from "./mcp/session-host";
import { shutdownNativeSessions } from "./host-shutdown";

vi.mock("./mcp/session-host", () => ({ closeAllMcpSessionHosts: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("host shutdown", () => {
  it("stops watches, drains both Session owners, kills MCP groups, then flushes observability", async () => {
    const calls: string[] = [];
    const rpc = deferred();
    const runtime = deferred();
    vi.mocked(closeAllMcpSessionHosts).mockImplementationOnce(async () => {
      calls.push("mcp");
    });
    const shutdown = shutdownNativeSessions({
      sessionWatchdog: {
        stop: () => {
          calls.push("watchdog");
        },
      },
      scheduledResumeHost: {
        stop: () => {
          calls.push("resume");
        },
      },
      shellHostNotices: {
        close: () => {
          calls.push("notices");
        },
      },
      sessionRpc: {
        close: () => {
          calls.push("rpc");
          return rpc.promise;
        },
      },
      sessionRuntime: {
        close: () => {
          calls.push("runtime");
          return runtime.promise;
        },
      },
      agentObservability: {
        shutdown: async () => {
          calls.push("flush");
        },
      },
      log: { error: vi.fn() },
    });
    expect(calls).toEqual(["watchdog", "resume", "notices", "rpc", "runtime"]);
    rpc.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("mcp");
    runtime.resolve();
    await shutdown;
    expect(calls).toEqual(["watchdog", "resume", "notices", "rpc", "runtime", "mcp", "flush"]);
  });

  it("waits for the other Session owner after a rejection before the MCP backstop", async () => {
    const failure = new Error("RPC failed");
    const runtime = deferred();
    const error = vi.fn();
    const mcp = vi.mocked(closeAllMcpSessionHosts).mockImplementationOnce(async () => {});
    mcp.mockClear();
    const shutdown = shutdownNativeSessions({
      sessionWatchdog: null,
      scheduledResumeHost: null,
      shellHostNotices: null,
      sessionRpc: { close: () => Promise.reject(failure) },
      sessionRuntime: { close: () => runtime.promise },
      agentObservability: null,
      log: { error },
    });
    await Promise.resolve();
    expect(mcp).not.toHaveBeenCalled();
    runtime.resolve();
    await shutdown;
    expect(error).toHaveBeenCalledWith("failed to close native session rpc", { error: failure });
    expect(mcp).toHaveBeenCalledOnce();
  });

  it("still runs the MCP backstop for a degraded host with no Session owners", async () => {
    const mcp = vi.mocked(closeAllMcpSessionHosts).mockImplementationOnce(async () => {});
    mcp.mockClear();
    const error = vi.fn();
    await shutdownNativeSessions({
      sessionWatchdog: null,
      scheduledResumeHost: null,
      shellHostNotices: null,
      sessionRpc: null,
      sessionRuntime: null,
      agentObservability: null,
      log: { error },
    });
    expect(mcp).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports each Session owner that fails to close, then still flushes", async () => {
    const calls: string[] = [];
    const error = vi.fn();
    vi.mocked(closeAllMcpSessionHosts).mockImplementationOnce(async () => {
      calls.push("mcp");
    });
    await shutdownNativeSessions({
      sessionWatchdog: null,
      scheduledResumeHost: null,
      shellHostNotices: null,
      sessionRpc: { close: () => Promise.reject(new Error("rpc")) },
      sessionRuntime: { close: () => Promise.reject(new Error("runtime")) },
      agentObservability: {
        shutdown: async () => {
          calls.push("flush");
        },
      },
      log: { error },
    });
    expect(error.mock.calls).toEqual([
      [
        "failed to close native session rpc",
        { error: expect.objectContaining({ message: "rpc" }) },
      ],
      [
        "failed to close native session rpc",
        { error: expect.objectContaining({ message: "runtime" }) },
      ],
    ]);
    expect(calls).toEqual(["mcp", "flush"]);
  });

  it("hands a failed export flush to its caller, which reports the drain unclean", async () => {
    vi.mocked(closeAllMcpSessionHosts).mockImplementationOnce(async () => {});
    const failure = new Error("collector gone");
    await expect(
      shutdownNativeSessions({
        sessionWatchdog: null,
        scheduledResumeHost: null,
        shellHostNotices: null,
        sessionRpc: null,
        sessionRuntime: null,
        agentObservability: { shutdown: () => Promise.reject(failure) },
        log: { error: vi.fn() },
      }),
    ).rejects.toBe(failure);
  });
});
