import { describe, expect, it, vi } from "vite-plus/test";
import type { HostLiveWork } from "@volli/host-core/sessions";

import {
  createMenuBarHost,
  liveWorkPhrase,
  MENU_BAR_POLL_MS,
  MENU_BAR_SETTLE_MS,
  planQuitBranch,
  quitWithLiveWorkCopy,
  trayModel,
  type MenuBarHostPorts,
  type QuitBranchInput,
  type TrayModel,
} from "./menu-bar-host";

const IDLE: HostLiveWork = { turns: 0, shells: 0 };
const ONE_TURN: HostLiveWork = { turns: 1, shells: 0 };

describe("planQuitBranch — the quit decision table, flag on (VC-577)", () => {
  const base: QuitBranchInput = {
    updateInstallInFlight: false,
    systemShuttingDown: false,
    quitRequested: false,
    liveWork: IDLE,
  };
  const live: HostLiveWork[] = [
    { turns: 1, shells: 0 },
    { turns: 0, shells: 1 },
    { turns: 2, shells: 3 },
  ];

  it("enters menu-bar mode for running turns or running shells, and nothing else", () => {
    for (const liveWork of live) {
      expect(planQuitBranch({ ...base, liveWork })).toBe("menu-bar");
    }
    expect(planQuitBranch(base)).toBe("quit");
  });

  it("stands down for an update install, a system shutdown or a Tray quit, whatever is live", () => {
    for (const liveWork of [IDLE, ...live]) {
      expect(planQuitBranch({ ...base, liveWork, updateInstallInFlight: true })).toBe("quit");
      expect(planQuitBranch({ ...base, liveWork, systemShuttingDown: true })).toBe("quit");
      expect(planQuitBranch({ ...base, liveWork, quitRequested: true })).toBe("quit");
    }
  });
});

describe("menu-bar copy", () => {
  it("names turns and shells in the confirm and the Tray", () => {
    expect(liveWorkPhrase({ turns: 1, shells: 0 })).toBe("1 turn");
    expect(liveWorkPhrase({ turns: 2, shells: 0 })).toBe("2 turns");
    expect(liveWorkPhrase({ turns: 0, shells: 1 })).toBe("1 background shell");
    expect(liveWorkPhrase({ turns: 1, shells: 2 })).toBe("1 turn and 2 background shells");
    expect(quitWithLiveWorkCopy({ turns: 1, shells: 0 }).message).toBe("1 turn is running");
    expect(quitWithLiveWorkCopy({ turns: 3, shells: 0 }).message).toBe("3 turns are running");
    expect(quitWithLiveWorkCopy({ turns: 1, shells: 1 }).message).toBe(
      "1 turn and 1 background shell are running",
    );
    expect(quitWithLiveWorkCopy(ONE_TURN).detail).toContain("quits on its own");
  });

  it("models the Tray: running count, Open, the update offer only when staged, Quit", () => {
    expect(trayModel({ turns: 2, shells: 1 }, "none")).toEqual({
      title: "Volli 3",
      tooltip: "Volli — 2 turns and 1 background shell running",
      items: [
        { id: "status", label: "2 turns and 1 background shell running", enabled: false },
        { id: "open", label: "Open Volli", enabled: true },
        { id: "quit", label: "Quit Volli", enabled: true, separatorBefore: true },
      ],
    });
    const ready = trayModel(IDLE, "ready");
    expect(ready.title).toBe("Volli");
    expect(ready.items[0]?.label).toBe("Nothing running");
    expect(ready.items.find((item) => item.id === "install-when-idle")).toEqual({
      id: "install-when-idle",
      label: "Install Update When Idle",
      enabled: true,
      checked: false,
      separatorBefore: true,
    });
    expect(
      trayModel(ONE_TURN, "armed").items.find((item) => item.id === "install-when-idle")?.checked,
    ).toBe(true);
  });
});

/** A fake clock the controller's timers run on. */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; run: () => void; every?: number }>();
  return {
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        nextId += 1;
        pending.set(nextId, { at: now + ms, run });
        return nextId;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
      setInterval: (run: () => void, ms: number) => {
        nextId += 1;
        pending.set(nextId, { at: now + ms, run, every: ms });
        return nextId;
      },
      clearInterval: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === undefined) pending.delete(id);
        else timer.at += timer.every;
        timer.run();
      }
      now = until;
    },
    pendingCount: () => pending.size,
  };
}

function harness(initial: HostLiveWork = ONE_TURN) {
  const calls: string[] = [];
  let work = initial;
  const listeners = new Set<(work: HostLiveWork) => void>();
  let windows = 1;
  let staged = false;
  let installInFlight = false;
  let installStarts = true;
  let confirm: "quit" | "wait" = "wait";
  const trays: TrayModel[] = [];
  const clock = fakeTimers();
  const ports = {
    liveWork: {
      current: vi.fn(() => work),
      subscribe: (listener: (work: HostLiveWork) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    windows: {
      count: () => windows,
      closeAll: () => {
        calls.push("windows.closeAll");
        windows = 0;
      },
      open: () => {
        calls.push("windows.open");
        windows += 1;
      },
    },
    dock: {
      hide: () => calls.push("dock.hide"),
      show: () => calls.push("dock.show"),
    },
    tray: {
      show: (model: TrayModel) => {
        calls.push("tray.show");
        trays.push(model);
      },
      update: (model: TrayModel) => {
        trays.push(model);
      },
      destroy: () => calls.push("tray.destroy"),
    },
    power: {
      hold: () => calls.push("power.hold"),
      release: () => calls.push("power.release"),
    },
    update: {
      ready: () => staged,
      installInFlight: () => installInFlight,
      install: () => {
        calls.push("update.install");
        return installStarts;
      },
    },
    confirmQuit: vi.fn(() => confirm),
    quit: vi.fn(() => {
      calls.push("app.quit");
    }),
    focusApp: () => calls.push("app.focus"),
    timers: clock.timers,
    log: () => {},
  } satisfies MenuBarHostPorts;
  const host = createMenuBarHost(ports);
  return {
    host,
    ports,
    calls,
    trays,
    clock,
    setWork(next: HostLiveWork, announce = true) {
      work = next;
      if (announce) for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
    stage: () => {
      staged = true;
    },
    setInstallInFlight: (value: boolean) => {
      installInFlight = value;
    },
    failInstall: () => {
      installStarts = false;
    },
    answer: (value: "quit" | "wait") => {
      confirm = value;
    },
  };
}

describe("createMenuBarHost (VC-577)", () => {
  it("asks the quit branch from the host's live work, an update install and a shutdown", () => {
    const h = harness(ONE_TURN);
    expect(h.host.branch()).toBe("menu-bar");
    h.setInstallInFlight(true);
    expect(h.host.branch()).toBe("quit");
    h.setInstallInFlight(false);
    h.host.noteSystemShutdown();
    expect(h.host.branch()).toBe("quit");
    expect(harness(IDLE).host.branch()).toBe("quit");
  });

  it("reads unreadable live work as none — today's quit", () => {
    const h = harness(ONE_TURN);
    h.ports.liveWork.current.mockImplementation(() => {
      throw new Error("bindings");
    });
    expect(h.host.branch()).toBe("quit");
  });

  it("enters once: windows closed, Dock hidden, Tray shown, and never a quit", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.host.enter();
    expect(h.host.isResident()).toBe(true);
    expect(h.calls).toEqual(["windows.closeAll", "dock.hide", "tray.show", "power.hold"]);
    expect(h.trays.at(-1)?.title).toBe("Volli 1");
    expect(h.ports.quit).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(1);
  });

  it("holds the power blocker only while turns run, never for shells alone", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.setWork({ turns: 2, shells: 0 });
    h.setWork({ turns: 0, shells: 1 });
    h.setWork({ turns: 1, shells: 1 });
    expect(h.calls.filter((call) => call.startsWith("power."))).toEqual([
      "power.hold",
      "power.release",
      "power.hold",
    ]);
    expect(h.trays.at(-1)?.items[0]?.label).toBe("1 turn and 1 background shell running");
  });

  it("drains then exits through the ordinary quit, once work stays drained", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.setWork(IDLE);
    expect(h.calls).toContain("power.release");
    h.clock.advance(MENU_BAR_SETTLE_MS - 1);
    expect(h.ports.quit).not.toHaveBeenCalled();
    // A follow-up released at the turn's end starts inside the window.
    h.setWork(ONE_TURN);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).not.toHaveBeenCalled();
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });

  it("re-checks at the end of the settle window rather than trusting the announcement", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.setWork(IDLE);
    // Work came back with no announcement (a binding read, say).
    h.setWork(ONE_TURN, false);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).not.toHaveBeenCalled();
  });

  it("notices on its own clock work that drained without an announcement", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.setWork(IDLE, false);
    h.clock.advance(MENU_BAR_POLL_MS + MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });

  it("does not re-ask after a drain-exit something refused, until work runs again", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).toHaveBeenCalledOnce();
    // The quit was refused (a busy-terminal Cancel): still resident, quiet.
    h.clock.advance(MENU_BAR_POLL_MS * 4);
    expect(h.ports.quit).toHaveBeenCalledOnce();
    h.setWork(ONE_TURN);
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).toHaveBeenCalledTimes(2);
  });

  it("reveals: leaves the mode, shows the Dock, opens one window, and stops every clock", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.setWork(IDLE);
    h.calls.length = 0;
    h.host.reveal({ focus: true });
    expect(h.host.isResident()).toBe(false);
    expect(h.calls).toEqual(["tray.destroy", "dock.show", "windows.open", "app.focus"]);
    expect(h.listenerCount()).toBe(0);
    expect(h.clock.pendingCount()).toBe(0);
    // Reattached to the same host: nothing quits when the old timer would have.
    h.clock.advance(MENU_BAR_SETTLE_MS * 10);
    expect(h.ports.quit).not.toHaveBeenCalled();
  });

  it("releases a held power blocker when revealed mid-turn", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.host.reveal();
    expect(h.calls.filter((call) => call.startsWith("power."))).toEqual([
      "power.hold",
      "power.release",
    ]);
  });

  it("outside menu-bar mode, reveal is exactly 'open a window if none exists'", () => {
    const h = harness(ONE_TURN);
    h.host.reveal();
    expect(h.calls).toEqual([]);
    h.ports.windows.closeAll();
    h.calls.length = 0;
    h.host.reveal();
    expect(h.calls).toEqual(["windows.open"]);
  });

  it("Tray quit with live work: Wait keeps the host resident, Quit Anyway forces one real quit", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.answer("wait");
    h.host.quitFromTray();
    expect(h.ports.confirmQuit).toHaveBeenCalledWith(ONE_TURN);
    expect(h.ports.quit).not.toHaveBeenCalled();

    h.answer("quit");
    let branchDuringQuit: string | null = null;
    h.ports.quit.mockImplementationOnce(() => {
      // before-quit is emitted synchronously inside app.quit().
      branchDuringQuit = h.host.branch();
    });
    h.host.quitFromTray();
    expect(branchDuringQuit).toBe("quit");
    // Never outlives the one attempt.
    expect(h.host.branch()).toBe("menu-bar");
  });

  it("Tray quit with nothing running quits without asking", () => {
    const h = harness(IDLE);
    h.host.quitFromTray();
    expect(h.ports.confirmQuit).not.toHaveBeenCalled();
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });

  it("Wait and Quit leaves the drain-exit armed: the host quits once the turn ends", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.answer("wait");
    h.host.quitFromTray();
    expect(h.ports.quit).not.toHaveBeenCalled();
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });

  it("installs a staged update when idle instead of quitting, if armed", () => {
    const h = harness(ONE_TURN);
    h.stage();
    h.host.enter();
    expect(h.trays.at(-1)?.items.some((item) => item.id === "install-when-idle")).toBe(true);
    h.host.toggleInstallWhenIdle();
    expect(h.trays.at(-1)?.items.find((item) => item.id === "install-when-idle")?.checked).toBe(
      true,
    );
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.calls).toContain("update.install");
    expect(h.ports.quit).not.toHaveBeenCalled();
  });

  it("falls back to an ordinary quit when the armed install cannot start", () => {
    const h = harness(ONE_TURN);
    h.stage();
    h.failInstall();
    h.host.enter();
    h.host.toggleInstallWhenIdle();
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.calls).toContain("update.install");
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });

  it("an unarmed staged update still quits (it installs on quit, as today)", () => {
    const h = harness(ONE_TURN);
    h.stage();
    h.host.enter();
    h.host.toggleInstallWhenIdle();
    h.host.toggleInstallWhenIdle();
    h.setWork(IDLE);
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(h.calls).not.toContain("update.install");
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });

  it("refresh re-renders the Tray only while resident", () => {
    const h = harness(ONE_TURN);
    h.host.refresh();
    expect(h.trays).toHaveLength(0);
    h.host.enter();
    h.stage();
    h.host.refresh();
    expect(h.trays.at(-1)?.items.some((item) => item.id === "install-when-idle")).toBe(true);
  });

  it("a settle timer that fires after a reveal does nothing", () => {
    const h = harness(ONE_TURN);
    const cleared: unknown[] = [];
    const clearTimeout = h.ports.timers.clearTimeout;
    h.ports.timers.clearTimeout = (handle) => {
      // Simulate a timer that already fired its callback into the queue.
      cleared.push(handle);
    };
    h.host.enter();
    h.setWork(IDLE);
    h.host.reveal();
    h.ports.timers.clearTimeout = clearTimeout;
    h.clock.advance(MENU_BAR_SETTLE_MS);
    expect(cleared).toHaveLength(1);
    expect(h.ports.quit).not.toHaveBeenCalled();
  });

  it("defaults to real timers and console logging", () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const quit = vi.fn();
      let work = ONE_TURN;
      const host = createMenuBarHost({
        liveWork: { current: () => work, subscribe: () => () => {} },
        windows: { count: () => 0, closeAll: () => {}, open: () => {} },
        dock: { hide: () => {}, show: () => {} },
        tray: { show: () => {}, update: () => {}, destroy: () => {} },
        power: { hold: () => {}, release: () => {} },
        update: { ready: () => false, installInFlight: () => false, install: () => false },
        confirmQuit: () => "wait",
        quit,
        focusApp: () => {},
      });
      host.enter();
      expect(info).toHaveBeenCalledWith("[menu-bar] entered menu-bar mode: 1 turn");
      work = IDLE;
      vi.advanceTimersByTime(MENU_BAR_POLL_MS + MENU_BAR_SETTLE_MS);
      expect(quit).toHaveBeenCalledOnce();
      host.reveal();
      host.enter();
      expect(info).toHaveBeenCalledWith("[menu-bar] entered menu-bar mode: no live work");
      host.reveal();
    } finally {
      info.mockRestore();
      vi.useRealTimers();
    }
  });
});
