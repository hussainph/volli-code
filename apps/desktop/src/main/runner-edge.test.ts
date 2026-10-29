/**
 * Desktop's runner edge (VC-671), booted the way index.ts boots it: the runner
 * installs the accepted-quit hold while composing, then boot binds each gate
 * as it builds what the gate guards. The real `registerAcceptedQuitCoordinator`,
 * `prepareDesktopQuit`, unsaved-drafts gate, window flush (`createAppWindows`)
 * and flush-and-ack barrier run unmodified; `app`, the host, the terminals'
 * confirm, the menu-bar controller and each window's renderer are recorded
 * ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostHandlerMap } from "@volli/host-core/handlers";
import type { RunnerReady } from "@volli/host-core/session-runtime";
import { captureHostLog } from "@volli/host-core/testing";

import { createAppWindows, type AppWindow } from "./app-windows";
import { createClientStateFlush, SHUTDOWN_FLUSH_TIMEOUT_MS } from "./client-state-flush";
import {
  abandonAcceptedUpdateInstall,
  beginAcceptedUpdateInstall,
  quitAlreadyRefused,
  recordUnsavedDocuments,
  refuseQuit,
} from "./quit-gate";
import {
  createDesktopRunnerEdge,
  unsavedDraftsQuitGate,
  type AdoptableRunner,
  type SessionRpcTransport,
} from "./runner-edge";

type QuitEvent = { preventDefault(): void };

beforeEach(() => {
  recordUnsavedDocuments({ names: ["draft.md"] });
});
afterEach(() => {
  recordUnsavedDocuments({ names: [] });
  abandonAcceptedUpdateInstall();
  vi.useRealTimers();
});

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(
  options: {
    cloud?: boolean;
    settleBackgroundWork?: () => Promise<void>;
    /** The unsaved-drafts confirm's answer: Discard and Quit, or Cancel. */
    unsaved?: "discard" | "keep";
    /**
     * How the one window's renderer answers a draft flush: after
     * `answerAfterMs` (it sends its draft, then acks), or never.
     */
    renderer?: { answerAfterMs: number } | "silent";
    /** A restart into another product store waiting on this quit (VC-889). */
    relaunch?: { pending(): boolean; quitAccepted(): void; quitRefused(): void };
  } = {},
) {
  const calls: string[] = [];
  const listeners: Array<(event: QuitEvent) => void> = [];
  const exited = Promise.withResolvers<number>();
  const host = {
    stop: vi.fn(async (_reason: string): Promise<unknown> => {
      calls.push("host.stop");
      return undefined;
    }),
    warnIfFollowUpCleanCloseSkipped: vi.fn(),
  };
  const terminals = {
    killAll: vi.fn(() => {
      calls.push("terminals.killAll");
    }),
    stopParkSweep: vi.fn(),
  };
  const askedAbout: unknown[] = [];
  const rpc = { close: vi.fn(async () => {}) };
  const createSessionRpc = vi.fn(
    (_ready: RunnerReady, _handlers: HostHandlerMap): SessionRpcTransport | null => rpc,
  );
  const closeSocket = vi.fn(async () => true);
  const edge = createDesktopRunnerEdge({
    lifecycle: {
      on: (event, listener) => {
        expect(event).toBe("before-quit");
        listeners.push(listener);
      },
      exit: (code) => exited.resolve(code),
    },
    host,
    // Hosts added over SSH (VC-700): their tunnels and links close with the host.
    remoteHosts: {
      close: async () => {
        calls.push("remote-hosts.close");
      },
    },
    stopBackgroundWork: () => {
      calls.push("web-sealing.stop");
    },
    ...(options.settleBackgroundWork ? { settleBackgroundWork: options.settleBackgroundWork } : {}),
    cloudEnabled: () => options.cloud === true,
    terminalQuit: (bound, event) => {
      askedAbout.push(bound);
      calls.push(quitAlreadyRefused(event) ? "terminal.gate(refused)" : "terminal.gate");
    },
    createSessionRpc,
    closeSocket,
    ...(options.relaunch === undefined ? {} : { relaunch: options.relaunch }),
  });

  // The one window, through the real draft flush (VC-577): its renderer is
  // asked over `volli:client-state-flush` and answers as scripted.
  let nextRequest = 0;
  const flusher = createClientStateFlush({
    newRequestId: () => `flush-${++nextRequest}`,
    log: (line) => calls.push(`flush.log:${line}`),
  });
  const renderer = options.renderer ?? { answerAfterMs: 0 };
  const window: AppWindow = {
    id: 1,
    isDestroyed: () => false,
    hide: () => {},
    destroy: () => {},
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, requestId: unknown) => {
        calls.push(`renderer.asked:${channel}`);
        if (renderer === "silent") return;
        setTimeout(() => {
          calls.push("renderer.draft-sent");
          flusher.acknowledge(requestId);
        }, renderer.answerAfterMs);
      },
    },
  };
  const windows = createAppWindows({
    all: () => [window],
    create: () => {},
    reveal: () => {},
    flush: flusher,
  });

  /** index.ts's boot: the hold while the runner composes, then each gate as its subject exists. */
  const boot = () => {
    edge.installQuitHold();
    edge.bind({
      automations: {
        stop: () => {
          calls.push("automations.stop");
        },
      },
    });
    edge.bind({
      unsavedQuit: unsavedDraftsQuitGate({
        confirmDiscard: (names, verb) => {
          calls.push(`unsaved.confirm:${names.join(",")}:${verb}`);
          return options.unsaved !== "keep";
        },
        env: {},
      }),
    });
    edge.bind({ terminals });
    edge.bind({ windows });
    edge.bind({
      repack: {
        abort: () => {
          calls.push("repack.abort");
        },
      },
    });
  };
  const quit = (): QuitEvent => {
    const event = { preventDefault: vi.fn() };
    for (const listener of listeners) listener(event);
    return event;
  };
  return {
    edge,
    boot,
    quit,
    calls,
    listeners,
    exited: exited.promise,
    host,
    terminals,
    askedAbout,
    rpc,
    createSessionRpc,
    closeSocket,
  };
}

/** The menu-bar controller as the quit path asks it (VC-577). */
function menuBarFake(
  branch: "quit" | "menu-bar",
  calls: string[],
  options: { shuttingDown?: boolean; tabs?: "close" | "cancel" } = {},
) {
  return {
    branch: vi.fn(() => branch),
    confirmEnter: vi.fn(() => {
      if (options.tabs === undefined) return true;
      calls.push("tabs.confirm");
      return options.tabs === "close";
    }),
    systemShuttingDown: vi.fn(() => options.shuttingDown === true),
    enter: vi.fn(() => {
      calls.push("menu-bar.enter");
    }),
    isResident: vi.fn(() => false),
    reveal: vi.fn(),
    quitFromTray: vi.fn(),
    toggleInstallWhenIdle: vi.fn(),
    noteSystemShutdown: vi.fn(),
    noteActivated: vi.fn(),
    refresh: vi.fn(),
  };
}

const FLAG_OFF_ORDER = [
  "automations.stop",
  "unsaved.confirm:draft.md:Quit",
  "terminal.gate",
  "repack.abort",
];

describe("the accepted-quit hold the runner installs", () => {
  it("is one before-quit listener, registered only when the runner installs it", () => {
    const h = harness();
    expect(h.listeners).toHaveLength(0);
    h.edge.installQuitHold();
    expect(h.listeners).toHaveLength(1);
  });

  it("a quit the moment the hold is installed reaches only declared state, and exits 0", async () => {
    const h = harness({ cloud: true });
    h.edge.installQuitHold();
    const event = h.quit();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(false);
    expect(await h.exited).toBe(0);
    // No gate bound yet: nothing asks, nothing is torn down but the host.
    expect(h.calls).toEqual(["web-sealing.stop", "host.stop", "remote-hosts.close"]);
  });

  it("routes the 15-second shutdown deadline to the host's one-time watermark warning", async () => {
    vi.useFakeTimers();
    const captured = captureHostLog();
    try {
      const h = harness();
      h.boot();
      h.host.stop.mockImplementation(() => new Promise<never>(() => {}));
      h.quit();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(h.host.warnIfFollowUpCleanCloseSkipped).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.host.warnIfFollowUpCleanCloseSkipped).toHaveBeenCalledExactlyOnceWith(
        "quit: shutdown deadline expired after 15000ms",
      );
      await vi.runOnlyPendingTimersAsync();
      expect(await h.exited).toBe(0);
      expect(captured.of("desktop")).toEqual([
        expect.objectContaining({ level: "error", msg: "failed to coordinate app shutdown" }),
      ]);
      // A second quit joins the shutdown already in flight.
      h.quit();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.host.stop).toHaveBeenCalledOnce();
      expect(h.host.warnIfFollowUpCleanCloseSkipped).toHaveBeenCalledOnce();
    } finally {
      captured.restore();
    }
  });

  it("waits for cancelled local workers before exiting on an accepted quit", async () => {
    const worker = Promise.withResolvers<void>();
    const settle = vi.fn(() => worker.promise);
    const h = harness({ settleBackgroundWork: settle });
    h.boot();
    h.quit();
    let exited = false;
    void h.exited.then(() => {
      exited = true;
    });
    await nextImmediate();
    expect(settle).toHaveBeenCalledOnce();
    expect(exited).toBe(false);
    worker.resolve();
    expect(await h.exited).toBe(0);
  });

  it("an accepted quit runs all four gates in order, then stops the host and exits 0", async () => {
    const h = harness();
    h.boot();
    const event = h.quit();
    expect(h.calls).toEqual(FLAG_OFF_ORDER);
    expect(h.askedAbout).toEqual([h.terminals]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(await h.exited).toBe(0);
    expect(h.host.stop).toHaveBeenCalledExactlyOnceWith("quit");
    // The host and the remote hosts' tunnels close together (VC-700).
    expect(h.calls.slice(-3)).toEqual(["web-sealing.stop", "host.stop", "remote-hosts.close"]);
  });

  it("a refused quit still runs all four gates in order and never stops the host", async () => {
    const h = harness({ unsaved: "keep" });
    h.boot();
    const event = h.quit();
    expect(h.calls).toEqual([
      "automations.stop",
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate(refused)",
      "repack.abort",
    ]);
    expect(quitAlreadyRefused(event)).toBe(true);
    await nextImmediate();
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("web-sealing.stop");
  });

  it("reads each gate at quit time, not when the hold was installed", () => {
    const h = harness();
    h.boot();
    const late: string[] = [];
    const lateTerminals = { killAll: vi.fn(), stopParkSweep: vi.fn() };
    h.edge.bind({
      automations: { stop: () => late.push("automations") },
      unsavedQuit: () => late.push("unsavedQuit"),
      terminals: lateTerminals,
      repack: { abort: () => late.push("repack") },
    });
    h.quit();
    expect(late).toEqual(["automations", "unsavedQuit", "repack"]);
    expect(h.calls).toEqual(["terminal.gate"]);
    expect(h.askedAbout).toEqual([lateTerminals]);
  });

  it("flag off: a built menu-bar host is never asked, and the quit is today's", async () => {
    const h = harness({ cloud: false });
    h.boot();
    const menuBar = menuBarFake("menu-bar", h.calls);
    h.edge.bind({ menuBar });
    h.quit();
    expect(h.calls.slice(0, 4)).toEqual(FLAG_OFF_ORDER);
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(menuBar.systemShuttingDown).not.toHaveBeenCalled();
    expect(await h.exited).toBe(0);
  });

  it("flag on, live work: the confirms run, then menu-bar mode — no Automation stop, no host stop", async () => {
    const h = harness({ cloud: true });
    h.boot();
    h.edge.bind({ menuBar: menuBarFake("menu-bar", h.calls) });
    const event = h.quit();
    expect(h.calls).toEqual(["unsaved.confirm:draft.md:Quit", "terminal.gate", "menu-bar.enter"]);
    expect(quitAlreadyRefused(event)).toBe(true);
    await nextImmediate();
    expect(h.host.stop).not.toHaveBeenCalled();
  });

  it("flag on, no live work: today's quit with the two stops behind the decision", async () => {
    const h = harness({ cloud: true });
    h.boot();
    h.edge.bind({ menuBar: menuBarFake("quit", h.calls) });
    h.quit();
    expect(h.calls.slice(0, 4)).toEqual([
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate",
      "automations.stop",
      "repack.abort",
    ]);
    expect(await h.exited).toBe(0);
  });

  it("flag on, system shutdown noted: no confirm is asked, their teardown runs, and the quit is accepted", async () => {
    const h = harness({ cloud: true, unsaved: "keep" });
    h.boot();
    const menuBar = menuBarFake("menu-bar", h.calls, { shuttingDown: true });
    h.edge.bind({ menuBar });
    const event = h.quit();
    expect(h.calls).toEqual([
      "terminals.killAll",
      "renderer.asked:volli:client-state-flush",
      "automations.stop",
      "repack.abort",
    ]);
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(false);
    expect(await h.exited).toBe(0);
    expect(h.host.stop).toHaveBeenCalledOnce();
    // The flush is joined: the renderer's draft went out before the exit.
    expect(h.calls).toContain("renderer.draft-sent");
  });

  it("flag on, system shutdown: exit waits for a responsive renderer's draft", async () => {
    const h = harness({ cloud: true, unsaved: "keep", renderer: { answerAfterMs: 50 } });
    h.boot();
    h.edge.bind({ menuBar: menuBarFake("menu-bar", h.calls, { shuttingDown: true }) });
    let draftSentAtExit = false;
    const exited = h.exited.then((code) => {
      draftSentAtExit = h.calls.includes("renderer.draft-sent");
      return code;
    });
    h.quit();
    // The host stops at once; the renderer answers 50ms later, inside the bound.
    expect(await exited).toBe(0);
    expect(draftSentAtExit).toBe(true);
  });

  it("flag on, system shutdown: a silent renderer never stalls power-off past the bound", async () => {
    // The bound and the host deadline on a fake clock; the exit's Immediate is real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness({ cloud: true, unsaved: "keep", renderer: "silent" });
    h.boot();
    h.edge.bind({ menuBar: menuBarFake("menu-bar", h.calls, { shuttingDown: true }) });
    let exitCode: number | null = null;
    void h.exited.then((code) => {
      exitCode = code;
    });
    const event = h.quit();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_TIMEOUT_MS - 1);
    await nextImmediate();
    // The host has stopped; the exit still waits on the renderer.
    expect(h.host.stop).toHaveBeenCalledOnce();
    expect(exitCode).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await h.exited).toBe(0);
    expect(quitAlreadyRefused(event)).toBe(false);
    expect(h.calls).not.toContain("renderer.draft-sent");
    expect(h.calls).toContain(
      `flush.log:[client-state] 1 window(s) had not confirmed their drafts were saved after ${SHUTDOWN_FLUSH_TIMEOUT_MS}ms`,
    );
    expect(h.host.warnIfFollowUpCleanCloseSkipped).not.toHaveBeenCalled();
  });

  it("flag off, system shutdown noted: today's confirms, and a decline still refuses", () => {
    const h = harness({ cloud: false, unsaved: "keep" });
    h.boot();
    const menuBar = menuBarFake("menu-bar", h.calls, { shuttingDown: true });
    h.edge.bind({ menuBar });
    const event = h.quit();
    expect(h.calls).toEqual([
      "automations.stop",
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate(refused)",
      "repack.abort",
    ]);
    expect(menuBar.systemShuttingDown).not.toHaveBeenCalled();
    expect(h.terminals.killAll).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  it("flag on, live work over agent Browser Tabs: Cancel refuses before the terminal gate", () => {
    const h = harness({ cloud: true });
    h.boot();
    const menuBar = menuBarFake("menu-bar", h.calls, { tabs: "cancel" });
    h.edge.bind({ menuBar });
    const event = h.quit();
    expect(h.calls).toEqual([
      "unsaved.confirm:draft.md:Quit",
      "tabs.confirm",
      "terminal.gate(refused)",
    ]);
    expect(menuBar.enter).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  // VC-889: a restart asks every confirm first and is never menu-bar mode.
  it("a restart over live work: a Cancel stops nothing and says so; an accept quits and relaunches", async () => {
    const relaunch = { pending: () => true, quitAccepted: vi.fn(), quitRefused: vi.fn() };
    const kept = harness({ cloud: true, unsaved: "keep", relaunch });
    kept.boot();
    const menuBar = menuBarFake("menu-bar", kept.calls, { tabs: "cancel" });
    kept.edge.bind({ menuBar });
    const event = kept.quit();
    await nextImmediate();
    expect(quitAlreadyRefused(event)).toBe(true);
    expect(kept.calls).not.toContain("automations.stop");
    expect(kept.calls).not.toContain("menu-bar.enter");
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(relaunch.quitRefused).toHaveBeenCalled();

    const accepted = harness({ cloud: true, relaunch });
    accepted.boot();
    accepted.edge.bind({ menuBar: menuBarFake("menu-bar", accepted.calls) });
    accepted.quit();
    expect(accepted.calls.slice(0, 4)).toEqual([
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate",
      "automations.stop",
      "repack.abort",
    ]);
    expect(await accepted.exited).toBe(0);
    expect(relaunch.quitAccepted).toHaveBeenCalledOnce();

    // Before menu-bar mode is built, a restart still keeps the confirms first.
    const early = harness({ cloud: true, relaunch });
    early.boot();
    early.quit();
    expect(early.calls[0]).toBe("unsaved.confirm:draft.md:Quit");
  });

  it("flag on, but the host is already stopping: never offered menu-bar mode", () => {
    const h = harness({ cloud: true });
    h.boot();
    const menuBar = menuBarFake("menu-bar", h.calls);
    h.edge.bind({ menuBar });
    // The runner's producer stop: the host has begun stopping.
    h.edge.stopProducers();
    h.quit();
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(h.calls[0]).toBe("automations.stop");
  });
});

describe("boot's last word on the quit path", () => {
  it("names every binding boot never made, and passes once the path is whole", () => {
    const h = harness();
    expect(() => h.edge.assertBound()).toThrow(
      "never bound: automations, unsavedQuit, terminals, windows, repack, menuBar",
    );
    h.boot();
    // A dropped menu-bar binding would silently skip menu-bar mode at quit.
    expect(() => h.edge.assertBound()).toThrow("never bound: menuBar.");
    h.edge.bind({ menuBar: menuBarFake("quit", h.calls) });
    expect(() => h.edge.assertBound()).not.toThrow();
  });
});

describe("the runner's producer stop and Session RPC transport", () => {
  it("stops desktop's producers: the host is closing, and the bound terminals stop sweeping", () => {
    const h = harness();
    expect(h.edge.hostClosing()).toBe(false);
    // Before the terminals exist, it only marks the host closing.
    h.edge.stopProducers();
    expect(h.edge.hostClosing()).toBe(true);
    h.edge.bind({ terminals: h.terminals });
    h.edge.stopProducers();
    expect(h.terminals.stopParkSweep).toHaveBeenCalledOnce();
  });

  it("binds the Session RPC from the recovered proof, hands it to the runner, and closes the socket with the host", async () => {
    const h = harness();
    const proof = { kind: "recovered" } as unknown as RunnerReady;
    const handlers = { kind: "host-handlers" } as unknown as HostHandlerMap;
    const owner = { kind: "runner-owner" };
    const runner = {
      owner: vi.fn((_edge: Parameters<AdoptableRunner<typeof owner>["owner"]>[0]) => owner),
      handlers: vi.fn((_ready: RunnerReady) => handlers),
    };
    // The host adopts exactly the runner's owner.
    expect(h.edge.ownerFor(runner)).toBe(owner);
    expect(runner.owner).toHaveBeenCalledOnce();
    const hostEdge = runner.owner.mock.calls[0]![0];
    // Nothing binds until the host's start hands over the recovered proof.
    expect(h.edge.transport()).toBeNull();
    expect(runner.handlers).not.toHaveBeenCalled();
    hostEdge.bind(proof);
    expect(runner.handlers).toHaveBeenCalledExactlyOnceWith(proof);
    expect(h.createSessionRpc).toHaveBeenCalledExactlyOnceWith(proof, handlers);
    expect(h.edge.transport()).toBe(h.rpc);
    expect(await hostEdge.closeSocket()).toBe(true);
    expect(h.closeSocket).toHaveBeenCalledOnce();
  });

  it("no runtime, no Session RPC: the transport stays null", () => {
    const h = harness();
    h.createSessionRpc.mockReturnValue(null);
    const runner = {
      owner: vi.fn((edge: Parameters<AdoptableRunner<null>["owner"]>[0]) => {
        edge.bind({ kind: "degraded" } as unknown as RunnerReady);
        return null;
      }),
      handlers: vi.fn(() => ({}) as unknown as HostHandlerMap),
    };
    h.edge.ownerFor(runner);
    expect(h.edge.transport()).toBeNull();
  });

  it("menu-bar mode, once bound, is what every reveal door reads", () => {
    const h = harness();
    expect(h.edge.menuBar()).toBeNull();
    const menuBar = menuBarFake("menu-bar", h.calls);
    h.edge.bind({ menuBar });
    expect(h.edge.menuBar()).toBe(menuBar);
  });
});

/** The unsaved-drafts gate over a confirm that answers `answer` (true: Discard and Quit). */
function gate(answer: boolean, env: Record<string, string> = {}) {
  const confirmDiscard = vi.fn((_names: readonly string[], _verb: "Quit") => answer);
  return { confirmDiscard, check: unsavedDraftsQuitGate({ confirmDiscard, env }) };
}

describe("unsavedDraftsQuitGate", () => {
  it("names the unsaved drafts in one confirm, and a Cancel refuses the quit", () => {
    for (const answer of [true, false]) {
      const { confirmDiscard, check } = gate(answer);
      const event = { preventDefault: vi.fn() };
      check(event);
      expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(["draft.md"], "Quit");
      expect(quitAlreadyRefused(event)).toBe(!answer);
    }
  });

  it("stands down for a refused attempt, an accepted update install, nothing unsaved, or the skip seam", () => {
    const refused = gate(false);
    const event = { preventDefault: vi.fn() };
    refuseQuit(event);
    refused.check(event);
    expect(refused.confirmDiscard).not.toHaveBeenCalled();

    const installing = gate(false);
    beginAcceptedUpdateInstall();
    const duringInstall = { preventDefault: vi.fn() };
    installing.check(duringInstall);
    abandonAcceptedUpdateInstall();
    expect(installing.confirmDiscard).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(duringInstall)).toBe(false);

    const skipped = gate(false, { VOLLI_SKIP_CLOSE_CONFIRM: "1" });
    const smoke = { preventDefault: vi.fn() };
    skipped.check(smoke);
    expect(skipped.confirmDiscard).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(smoke)).toBe(false);

    recordUnsavedDocuments({ names: [] });
    const clean = gate(false);
    clean.check({ preventDefault: vi.fn() });
    expect(clean.confirmDiscard).not.toHaveBeenCalled();
  });
});
