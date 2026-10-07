import { describe, expect, it, vi } from "vite-plus/test";
import { captureHostLog } from "@volli/host-core/testing";
import type { HostLiveWork } from "@volli/host-core/sessions";

import {
  BROWSER_CLOSED_FOR_MENU_BAR,
  closeAgentTabsCopy,
  createMenuBarHost,
  liveWorkPhrase,
  MENU_BAR_POLL_MS,
  MENU_BAR_SETTLE_MS,
  MENU_BAR_SMOKE_SETTLE_MAX_MS,
  menuBarSmokeSettleMs,
  planQuitBranch,
  SYSTEM_SHUTDOWN_LATCH_MS,
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

function harness(initial: HostLiveWork = ONE_TURN, settleMs?: number) {
  const calls: string[] = [];
  let work = initial;
  const listeners = new Set<(work: HostLiveWork) => void>();
  let windows = 1;
  let staged = false;
  let installInFlight = false;
  let installStarts = true;
  let confirm: "quit" | "wait" = "wait";
  let tabsAnswer: "close" | "cancel" = "close";
  let agentTabs = 0;
  let latched = false;
  let latchRaces = false;
  const trays: TrayModel[] = [];
  const clock = fakeTimers();
  const ports = {
    liveWork: {
      current: vi.fn(() => work),
      subscribe: (listener: (work: HostLiveWork) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // The host's barrier: a re-read and the latch in one call.
      tryBeginIdleExit: vi.fn(() => {
        if (latchRaces || work.turns > 0 || work.shells > 0) return false;
        if (!latched) calls.push("latch");
        latched = true;
        return true;
      }),
      abandonIdleExit: vi.fn(() => {
        if (latched) calls.push("unlatch");
        latched = false;
      }),
    },
    browserTabs: {
      sessionTabCount: () => agentTabs,
      closeForMenuBar: () => {
        calls.push("tabs.close");
        agentTabs = 0;
      },
      reopen: () => calls.push("tabs.reopen"),
    },
    confirmCloseAgentTabs: vi.fn(() => tabsAnswer),
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
  const host = createMenuBarHost(settleMs === undefined ? ports : { ...ports, settleMs });
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
    answerTabs: (value: "close" | "cancel") => {
      tabsAnswer = value;
    },
    openAgentTabs: (count: number) => {
      agentTabs = count;
    },
    /** A start lands between the settle check and the barrier. */
    raceTheLatch: (value: boolean) => {
      latchRaces = value;
    },
    latched: () => latched,
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
    // The host's barrier reads the same count, so it cannot answer either.
    h.ports.liveWork.tryBeginIdleExit.mockImplementation(() => {
      throw new Error("bindings");
    });
    expect(h.host.branch()).toBe("quit");
  });

  it("enters once: windows closed, Dock hidden, Tray shown, and never a quit", () => {
    const h = harness(ONE_TURN);
    h.host.enter();
    h.host.enter();
    expect(h.host.isResident()).toBe(true);
    expect(h.calls).toEqual([
      "tabs.close",
      "windows.closeAll",
      "dock.hide",
      "tray.show",
      "power.hold",
    ]);
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
    expect(h.calls).toEqual([
      "tray.destroy",
      "dock.show",
      "tabs.reopen",
      "windows.open",
      "app.focus",
    ]);
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

  it("defaults to real timers and the host log", () => {
    vi.useFakeTimers();
    const captured = captureHostLog();
    const info = (line: string) => captured.of("menu-bar").some((record) => record.msg === line);
    try {
      const quit = vi.fn();
      let work = ONE_TURN;
      const host = createMenuBarHost({
        liveWork: {
          current: () => work,
          subscribe: () => () => {},
          tryBeginIdleExit: () => work.turns === 0,
          abandonIdleExit: () => {},
        },
        browserTabs: { sessionTabCount: () => 0, closeForMenuBar: () => {}, reopen: () => {} },
        confirmCloseAgentTabs: () => "cancel",
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
      expect(info("[menu-bar] entered menu-bar mode: 1 turn")).toBe(true);
      work = IDLE;
      vi.advanceTimersByTime(MENU_BAR_POLL_MS + MENU_BAR_SETTLE_MS);
      expect(quit).toHaveBeenCalledOnce();
      host.reveal();
      host.enter();
      expect(info("[menu-bar] entered menu-bar mode: no live work")).toBe(true);
      host.reveal();
    } finally {
      captured.restore();
      vi.useRealTimers();
    }
  });

  describe("the idle-exit barrier (VC-577 B1)", () => {
    it("an idle verdict takes the start latch in the same call; a live one never does", () => {
      const live = harness(ONE_TURN);
      expect(live.host.branch()).toBe("menu-bar");
      expect(live.ports.liveWork.tryBeginIdleExit).not.toHaveBeenCalled();
      const idle = harness(IDLE);
      expect(idle.host.branch()).toBe("quit");
      expect(idle.latched()).toBe(true);
    });

    it("a start landing between the read and the barrier keeps the host resident", () => {
      const h = harness(IDLE);
      h.raceTheLatch(true);
      expect(h.host.branch()).toBe("menu-bar");
      expect(h.latched()).toBe(false);
    });

    it("an override quits over live work without latching (it stops the host anyway)", () => {
      const h = harness(ONE_TURN);
      h.setInstallInFlight(true);
      expect(h.host.branch()).toBe("quit");
      h.setInstallInFlight(false);
      h.host.noteSystemShutdown();
      expect(h.host.branch()).toBe("quit");
      expect(h.ports.liveWork.tryBeginIdleExit).not.toHaveBeenCalled();
    });

    it("an unreadable barrier fails toward today's quit", () => {
      const h = harness(IDLE);
      h.ports.liveWork.tryBeginIdleExit.mockImplementation(() => {
        throw new Error("runtime");
      });
      expect(h.host.branch()).toBe("quit");
    });

    it("the drain exit's own quit is decided by the barrier inside before-quit", () => {
      const h = harness(ONE_TURN);
      let verdict: string | null = null;
      h.ports.quit.mockImplementation(() => {
        verdict = h.host.branch();
      });
      h.host.enter();
      h.setWork(IDLE);
      h.clock.advance(MENU_BAR_SETTLE_MS);
      expect(verdict).toBe("quit");
      expect(h.latched()).toBe(true);
    });

    it("install-when-idle takes the same barrier first, and stays resident if a start won", () => {
      const h = harness(ONE_TURN);
      h.stage();
      h.host.enter();
      h.host.toggleInstallWhenIdle();
      h.setWork(IDLE);
      h.raceTheLatch(true);
      h.clock.advance(MENU_BAR_SETTLE_MS);
      expect(h.calls).not.toContain("update.install");
      expect(h.ports.quit).not.toHaveBeenCalled();
      expect(h.host.isResident()).toBe(true);
      // The start's turn ends; the barrier holds this time and the install runs.
      h.raceTheLatch(false);
      h.setWork(ONE_TURN);
      h.setWork(IDLE);
      h.clock.advance(MENU_BAR_SETTLE_MS);
      expect(h.calls.slice(-2)).toEqual(["latch", "update.install"]);
    });

    it("an install that cannot start lifts the latch before the ordinary quit", () => {
      const h = harness(ONE_TURN);
      h.stage();
      h.failInstall();
      h.host.enter();
      h.host.toggleInstallWhenIdle();
      h.setWork(IDLE);
      h.clock.advance(MENU_BAR_SETTLE_MS);
      expect(h.calls.slice(-4)).toEqual(["latch", "update.install", "unlatch", "app.quit"]);
    });
  });

  describe("system logout, restart and shutdown (VC-577 B3)", () => {
    it("stands down until the process outlives the notice by a minute", () => {
      const h = harness(ONE_TURN);
      h.host.noteSystemShutdown();
      expect(h.host.systemShuttingDown()).toBe(true);
      expect(h.host.branch()).toBe("quit");
      h.clock.advance(SYSTEM_SHUTDOWN_LATCH_MS - 1);
      expect(h.host.systemShuttingDown()).toBe(true);
      h.clock.advance(1);
      // The logout was cancelled elsewhere: ⌘Q keeps its turns again.
      expect(h.host.systemShuttingDown()).toBe(false);
      expect(h.host.branch()).toBe("menu-bar");
    });

    it("a second notice restarts the minute; a reveal or an activation ends it at once", () => {
      const h = harness(ONE_TURN);
      h.host.noteSystemShutdown();
      h.clock.advance(SYSTEM_SHUTDOWN_LATCH_MS - 1);
      h.host.noteSystemShutdown();
      h.clock.advance(SYSTEM_SHUTDOWN_LATCH_MS - 1);
      expect(h.host.systemShuttingDown()).toBe(true);
      h.host.reveal();
      expect(h.host.systemShuttingDown()).toBe(false);
      expect(h.clock.pendingCount()).toBe(0);
      h.host.noteSystemShutdown();
      h.host.noteActivated();
      expect(h.host.systemShuttingDown()).toBe(false);
      expect(h.clock.pendingCount()).toBe(0);
      h.host.noteActivated();
      expect(h.host.branch()).toBe("menu-bar");
    });
  });

  describe("agent Browser Tabs on entry (VC-577 orchestrator ruling)", () => {
    it("asks only when this attempt would enter menu-bar mode over tabs a Session uses", () => {
      const idle = harness(IDLE);
      idle.openAgentTabs(2);
      expect(idle.host.confirmEnter()).toBe(true);
      const noTabs = harness(ONE_TURN);
      expect(noTabs.host.confirmEnter()).toBe(true);
      for (const h of [idle, noTabs]) expect(h.ports.confirmCloseAgentTabs).not.toHaveBeenCalled();

      const h = harness(ONE_TURN);
      h.openAgentTabs(2);
      h.answerTabs("cancel");
      expect(h.host.confirmEnter()).toBe(false);
      expect(h.ports.confirmCloseAgentTabs).toHaveBeenCalledWith(2);
      h.answerTabs("close");
      expect(h.host.confirmEnter()).toBe(true);
      // Entry closes them first, and a resident host is never asked again.
      h.host.enter();
      expect(h.calls.slice(0, 2)).toEqual(["tabs.close", "windows.closeAll"]);
      h.openAgentTabs(1);
      expect(h.host.confirmEnter()).toBe(true);
      expect(h.ports.confirmCloseAgentTabs).toHaveBeenCalledTimes(2);
    });

    it("an override needs no question: the quit stops the agents too", () => {
      const h = harness(ONE_TURN);
      h.openAgentTabs(1);
      h.setInstallInFlight(true);
      expect(h.host.confirmEnter()).toBe(true);
      expect(h.ports.confirmCloseAgentTabs).not.toHaveBeenCalled();
    });

    it("words the confirm and the model's refusal", () => {
      expect(closeAgentTabsCopy(1).message).toBe("1 browser tab used by running agents will close");
      expect(closeAgentTabsCopy(3)).toEqual({
        message: "3 browser tabs used by running agents will close",
        detail: "The agents keep running without them.",
      });
      expect(BROWSER_CLOSED_FOR_MENU_BAR).toContain(
        "The browser was closed when Volli moved to the menu bar",
      );
    });
  });
});

describe("menuBarSmokeSettleMs — the mechanics smoke's settle window (VC-709)", () => {
  const SEAM = { VOLLI_SMOKE_MENU_BAR_HOST: "1" };

  it("is the smoke's value only behind both locks: an unpackaged build and the seam flag", () => {
    const env = { ...SEAM, VOLLI_SMOKE_MENU_BAR_SETTLE_MS: "20000" };
    expect(menuBarSmokeSettleMs(true, env)).toBe(20_000);
    expect(menuBarSmokeSettleMs(false, env)).toBeUndefined();
    expect(menuBarSmokeSettleMs(true, { VOLLI_SMOKE_MENU_BAR_SETTLE_MS: "20000" })).toBeUndefined();
    expect(
      menuBarSmokeSettleMs(true, {
        VOLLI_SMOKE_MENU_BAR_HOST: "0",
        VOLLI_SMOKE_MENU_BAR_SETTLE_MS: "20000",
      }),
    ).toBeUndefined();
  });

  it("can only lengthen the settle, never shorten it past a release's, and is bounded", () => {
    const at = (value: string) =>
      menuBarSmokeSettleMs(true, { ...SEAM, VOLLI_SMOKE_MENU_BAR_SETTLE_MS: value });
    expect(menuBarSmokeSettleMs(true, SEAM)).toBeUndefined();
    expect(at(String(MENU_BAR_SETTLE_MS))).toBe(MENU_BAR_SETTLE_MS);
    expect(at(String(MENU_BAR_SETTLE_MS - 1))).toBeUndefined();
    expect(at("0")).toBeUndefined();
    expect(at(String(MENU_BAR_SMOKE_SETTLE_MAX_MS))).toBe(MENU_BAR_SMOKE_SETTLE_MAX_MS);
    expect(at(String(MENU_BAR_SMOKE_SETTLE_MAX_MS + 1))).toBeUndefined();
    for (const junk of ["", "-20000", "2e4", "20000.5", " 20000", "20s", "9999999999"]) {
      expect(at(junk)).toBeUndefined();
    }
  });

  it("a host given the longer settle stays resident through it, then drain-exits once", () => {
    const settleMs = 20_000;
    const h = harness(IDLE, settleMs);
    h.host.enter();
    h.clock.advance(settleMs - 1);
    expect(h.host.isResident()).toBe(true);
    expect(h.ports.quit).not.toHaveBeenCalled();
    h.clock.advance(1);
    expect(h.ports.quit).toHaveBeenCalledOnce();
  });
});
