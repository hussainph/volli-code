import { describe, expect, it, vi } from "vite-plus/test";
import type { HostCore, HostRuntimeOwner } from "@volli/host-core";
import type { RecoveredSessionServices } from "@volli/host-core/session-runtime";
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
    closeSocket: vi.fn(async () => {
      calls.push("socket.close");
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
  it("binds only recovered services and joins only the original runtime/socket drains", async () => {
    const f = fixture();
    expect(await f.desktop.start()).toBe(f.proof);
    expect(f.options.bindReady).toHaveBeenCalledExactlyOnceWith(f.proof);
    expect(f.calls).toEqual(["ready", "bind", "ready"]);
    f.calls.length = 0;
    f.owner().stopProducers();
    await Promise.all([f.owner().close(), f.owner().closeSocket?.()]);
    expect(f.calls).toEqual(["producers.stop", "runtime.close", "socket.close"]);
  });

  it("reports a failed runtime close without adding other joins", async () => {
    const f = fixture();
    await f.desktop.start();
    const error = new Error("close failed");
    f.options.lifecycle.close.mockRejectedValueOnce(error);
    await expect(f.owner().close()).rejects.toBe(error);
    expect(f.calls).toEqual(["ready", "bind", "ready"]);
  });

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

  it("flag on: confirms first, then menu-bar or quit, and a refusal stops nothing (VC-577)", () => {
    for (const [refused, branch, want] of [
      [true, "menu-bar", ["draft.gate"]],
      [false, "menu-bar", ["draft.gate", "terminal.kill", "menu-bar.enter"]],
      [false, "quit", ["draft.gate", "terminal.kill", "automations.stop", "repack.abort"]],
    ] as const) {
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
        menuBar: {
          branch: () => branch,
          confirmEnter: () => true,
          systemShuttingDown: () => false,
          enter: () => {
            calls.push("menu-bar.enter");
          },
        },
      });
      expect(calls).toEqual(want);
      // Menu-bar entry refuses through refuseQuit, so listeners behind it stand down.
      expect(quitAlreadyRefused(event)).toBe(refused || branch === "menu-bar");
    }
  });

  it("flag on: a Browser Tabs Cancel refuses before the terminal confirm can kill anything", () => {
    const calls: string[] = [];
    const event = { preventDefault: vi.fn() };
    prepareDesktopQuit(event, {
      stopAutomations: () => calls.push("automations.stop"),
      unsavedQuit: () => calls.push("draft.gate"),
      terminalQuit: (attempt) => {
        if (!quitAlreadyRefused(attempt)) calls.push("terminal.kill");
      },
      abortRepack: () => calls.push("repack.abort"),
      menuBar: {
        branch: () => "menu-bar",
        confirmEnter: () => {
          calls.push("tabs.confirm");
          return false;
        },
        systemShuttingDown: () => false,
        enter: () => calls.push("menu-bar.enter"),
      },
    });
    expect(calls).toEqual(["draft.gate", "tabs.confirm"]);
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  it("flag on, system shutdown: no confirm runs, their teardown does, and the quit is accepted", () => {
    const calls: string[] = [];
    const event = { preventDefault: vi.fn() };
    const ports = {
      stopAutomations: () => calls.push("automations.stop"),
      unsavedQuit: (attempt: { preventDefault(): void }) => {
        calls.push("draft.gate");
        refuseQuit(attempt);
      },
      terminalQuit: () => calls.push("terminal.gate"),
      abortRepack: () => calls.push("repack.abort"),
      menuBar: {
        branch: () => "menu-bar" as const,
        confirmEnter: () => false,
        systemShuttingDown: () => true,
        enter: () => calls.push("menu-bar.enter"),
      },
    };
    prepareDesktopQuit(event, {
      ...ports,
      systemShutdownTeardown: () => calls.push("terminals.kill+drafts.flush"),
    });
    expect(calls).toEqual(["terminals.kill+drafts.flush", "automations.stop", "repack.abort"]);
    expect(quitAlreadyRefused(event)).toBe(false);
    // The teardown port is optional.
    calls.length = 0;
    prepareDesktopQuit({ preventDefault: vi.fn() }, ports);
    expect(calls).toEqual(["automations.stop", "repack.abort"]);
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
