import { describe, expect, it, vi } from "vite-plus/test";
import type { HostCore, HostRuntimeOwner } from "@volli/host-core";
import type { RecoveredSessionServices } from "@volli/host-core/session-runtime/lifecycle";
import { createDesktopHostRuntime, prepareDesktopQuit } from "./host-runtime";
import { quitAlreadyRefused, refuseQuit, registerAcceptedQuitCoordinator } from "./quit-gate";

function fixture() {
  const calls: string[] = [];
  let owner: HostRuntimeOwner | undefined;
  const proof = { services: {} } as RecoveredSessionServices<object>;
  const options = {
    host: {
      start: async (runtime: HostRuntimeOwner) => {
        owner = runtime;
        await runtime.start();
      },
    } as unknown as HostCore,
    lifecycle: {
      ready: vi.fn(async () => {
        calls.push("ready");
        return proof;
      }),
      close: vi.fn(async () => {
        calls.push("runtime.close");
      }),
    },
    bindReady: vi.fn(() => {
      calls.push("bind");
    }),
    stopProducers: vi.fn(() => {
      calls.push("producers.stop");
    }),
    closeShells: vi.fn(async () => {
      calls.push("shells.close");
    }),
    closeSocket: vi.fn(async () => {
      calls.push("socket.close");
    }),
    settleProducers: vi.fn(async () => {
      calls.push("producers.settled");
    }),
  };
  const desktop = createDesktopHostRuntime(options);
  return {
    calls,
    options,
    desktop,
    proof,
    owner: () => {
      if (owner === undefined) throw new Error("No owner adopted.");
      return owner;
    },
  };
}

describe("desktop host adapter", () => {
  it("binds only recovered services and joins runtime, shells and producers in order", async () => {
    const f = fixture();
    expect(await f.desktop.start()).toBe(f.proof);
    expect(f.options.bindReady).toHaveBeenCalledExactlyOnceWith(f.proof);
    expect(f.calls).toEqual(["ready", "bind", "ready"]);
    f.calls.length = 0;
    f.owner().stopProducers();
    await Promise.all([f.owner().close(), f.owner().closeSocket?.()]);
    expect(f.calls).toEqual([
      "producers.stop",
      "runtime.close",
      "socket.close",
      "shells.close",
      "producers.settled",
    ]);
  });

  it.each(["runtime", "shells"] as const)(
    "a failed %s close cannot skip later writer joins",
    async (failure) => {
      const f = fixture();
      await f.desktop.start();
      const error = new Error("close failed");
      if (failure === "runtime") f.options.lifecycle.close.mockRejectedValueOnce(error);
      else f.options.closeShells.mockRejectedValueOnce(error);
      await expect(f.owner().close()).rejects.toBe(error);
      expect(f.options.closeShells).toHaveBeenCalledOnce();
      expect(f.options.settleProducers).toHaveBeenCalledOnce();
    },
  );

  it("preserves accepted and refused synchronous quit gate order", () => {
    for (const refused of [false, true]) {
      const calls: string[] = [];
      const event = { preventDefault: vi.fn() };
      prepareDesktopQuit(event, {
        stopAutomations: () => {
          calls.push("automations.stop");
        },
        unsavedQuit: (attempt) => {
          calls.push("draft.gate");
          if (refused) refuseQuit(attempt);
        },
        terminalQuit: (attempt) => {
          if (!quitAlreadyRefused(attempt)) calls.push("terminal.kill");
        },
        abortRepack: () => {
          calls.push("repack.abort");
        },
      });
      expect(calls).toEqual(
        refused
          ? ["automations.stop", "draft.gate", "repack.abort"]
          : ["automations.stop", "draft.gate", "terminal.kill", "repack.abort"],
      );
    }
  });

  it("a throwing synchronous gate cannot strand the already-prevented quit", async () => {
    const trigger = Promise.withResolvers<(event: { preventDefault(): void }) => void>();
    const exited = Promise.withResolvers<number>();
    const drain = vi.fn(async () => {});
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on: (_event, listener) => {
          trigger.resolve(listener);
        },
        exit: exited.resolve,
      },
      shutdownNativeSessions: drain,
      shutdownAgentSocket: drain,
      prepareQuit: () => {
        throw new Error("dialog failed");
      },
      reportFailure: vi.fn(),
    });
    const event = { preventDefault: vi.fn() };
    const fire = await trigger.promise;
    expect(() => fire(event)).toThrow("dialog failed");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(await exited.promise).toBe(0);
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
