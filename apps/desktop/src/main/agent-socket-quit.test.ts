import { createHook, executionAsyncId } from "node:async_hooks";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAgentSocketLifecycle } from "@volli/host-core/agent-socket";
import { registerAgentSocketWillQuit } from "./agent-socket-quit";

describe("agent socket app quit", () => {
  it("exits the socket-only fallback through an Immediate after real I/O", async () => {
    const directory = await mkdtemp(join(tmpdir(), "volli-socket-checkpoint-"));
    const file = join(directory, "completion");
    await writeFile(file, "experimental FS settlement");
    const resources = new Map<number, string>();
    const hook = createHook({
      init(id, type) {
        resources.set(id, type);
      },
      destroy(id) {
        resources.delete(id);
      },
    });
    let attemptQuit!: (event: { preventDefault(): void }) => void;
    let finishExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      finishExit = resolve;
    });
    let exitResource: string | undefined;
    const exit = vi.fn(() => {
      exitResource = resources.get(executionAsyncId());
      finishExit();
    });
    const shutdownAgentSocket = vi.fn(() => unlink(file));
    hook.enable();
    try {
      registerAgentSocketWillQuit({
        lifecycle: {
          on(_event, listener) {
            attemptQuit = listener;
          },
          exit,
        },
        shutdownAgentSocket,
        reportFailure: vi.fn(),
      });
      attemptQuit({ preventDefault: vi.fn() });
      await exited;
      expect(exitResource).toBe("Immediate");
      attemptQuit({ preventDefault: vi.fn() });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
    } finally {
      hook.disable();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("holds will-quit until socket shutdown completes", async () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    let finishClose: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const agentSocket = createAgentSocketLifecycle({
      start: vi.fn(() => Promise.resolve({ close })),
      reportFailure: vi.fn(),
    });
    await agentSocket.start({
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1, ok: true as const, data: {} }),
    });
    const exit = vi.fn();

    registerAgentSocketWillQuit({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownAgentSocket: agentSocket.shutdown,
      reportFailure: vi.fn(),
    });

    const event = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(event);

    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(exit).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    finishClose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
  });

  it("forces one will-quit after the shutdown deadline and observes a late rejection", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
      let failShutdown!: (error: unknown) => void;
      const shutdownAgentSocket = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            failShutdown = reject;
          }),
      );
      const reportFailure = vi.fn();
      const exit = vi.fn();
      registerAgentSocketWillQuit({
        lifecycle: {
          on(event, listener) {
            handlers.set(event, listener);
          },
          exit,
        },
        shutdownAgentSocket,
        shutdownDeadlineMs: 25,
        reportFailure,
      });

      const first = { preventDefault: vi.fn() };
      const repeated = { preventDefault: vi.fn() };
      handlers.get("will-quit")?.(first);
      handlers.get("will-quit")?.(repeated);
      await vi.advanceTimersByTimeAsync(0);

      expect(first.preventDefault).toHaveBeenCalledExactlyOnceWith();
      expect(repeated.preventDefault).toHaveBeenCalledExactlyOnceWith();
      expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);

      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
        new Error("Application shutdown did not settle within 25ms."),
      );
      expect(exit).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);

      failShutdown(new Error("late socket failure"));
      await vi.advanceTimersByTimeAsync(0);
      handlers.get("will-quit")?.({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(25);

      expect(reportFailure).toHaveBeenNthCalledWith(2, new Error("late socket failure"));
      expect(reportFailure).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a will-quit shutdown rejection before exiting", async () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const failure = new Error("socket shutdown rejected");
    const reportFailure = vi.fn();
    const exit = vi.fn();
    registerAgentSocketWillQuit({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownAgentSocket: () => Promise.reject(failure),
      reportFailure,
    });

    const event = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(event);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
