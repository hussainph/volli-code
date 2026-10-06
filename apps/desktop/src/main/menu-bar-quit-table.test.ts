/**
 * The whole quit decision table (VC-577), run through the REAL quit path:
 * `registerAcceptedQuitCoordinator` → `prepareDesktopQuit` → the menu-bar
 * host, with the unsaved-drafts and terminal gates modelled exactly as
 * index.ts writes them (both stand down for an accepted update install, both
 * refuse through `refuseQuit`).
 *
 * Dimensions: flag × live work × unsaved drafts × busy terminals × update in
 * flight × Tray quit vs ⌘Q. Every row asserts the outcome (exit, menu-bar or
 * stay), whether Automations were stopped, and that the flag-off rows are
 * today's path call for call.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostLiveWork } from "@volli/host-core/sessions";

import { prepareDesktopQuit } from "./host-runtime";
import { createMenuBarHost } from "./menu-bar-host";
import {
  abandonAcceptedUpdateInstall,
  beginAcceptedUpdateInstall,
  quitAlreadyRefused,
  refuseQuit,
  registerAcceptedQuitCoordinator,
  updateInstallQuitInFlight,
} from "./quit-gate";

type Confirm = "none" | "accept" | "cancel";
type QuitEvent = { preventDefault(): void };

interface Row {
  flag: boolean;
  live: boolean;
  unsaved: Confirm;
  terminals: Confirm;
  update: boolean;
  trigger: "cmd-q" | "tray";
}

function rows(): Row[] {
  const all: Row[] = [];
  const confirms: Confirm[] = ["none", "accept", "cancel"];
  for (const flag of [false, true])
    for (const live of [false, true])
      for (const unsaved of confirms)
        for (const terminals of confirms)
          for (const update of [false, true])
            for (const trigger of ["cmd-q", "tray"] as const) {
              // The Tray exists only in menu-bar mode, which only the flag enters.
              if (trigger === "tray" && !flag) continue;
              all.push({ flag, live, unsaved, terminals, update, trigger });
            }
  return all;
}

/** What today's desktop does, and what the flag adds. Written out, not derived from the code. */
function expected(row: Row): {
  outcome: "exit" | "menu-bar" | "stay";
  automationsStopped: boolean;
} {
  // Both confirms stand down for an accepted update install (VC-59).
  const declined = !row.update && (row.unsaved === "cancel" || row.terminals === "cancel");
  if (!row.flag) {
    // Today: Automations stop first and unconditionally, even on a refusal.
    return { outcome: declined ? "stay" : "exit", automationsStopped: true };
  }
  if (declined) return { outcome: "stay", automationsStopped: false };
  if (row.update || row.trigger === "tray" || !row.live) {
    return { outcome: "exit", automationsStopped: true };
  }
  return { outcome: "menu-bar", automationsStopped: false };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function runRow(row: Row) {
  const calls: string[] = [];
  let beforeQuit!: (event: QuitEvent) => void;
  const exit = vi.fn();
  const work: HostLiveWork = row.live ? { turns: 1, shells: 0 } : { turns: 0, shells: 0 };
  if (row.update) beginAcceptedUpdateInstall();

  const menuBar = createMenuBarHost({
    liveWork: { current: () => work, subscribe: () => () => {} },
    windows: {
      count: () => 0,
      closeAll: () => calls.push("windows.closeAll"),
      open: () => calls.push("windows.open"),
    },
    dock: { hide: () => calls.push("dock.hide"), show: () => calls.push("dock.show") },
    tray: { show: () => calls.push("tray.show"), update: () => {}, destroy: () => {} },
    power: { hold: () => {}, release: () => {} },
    update: {
      ready: () => false,
      installInFlight: updateInstallQuitInFlight,
      install: () => false,
    },
    confirmQuit: () => "quit",
    // app.quit() emits before-quit synchronously with a fresh event.
    quit: () => beforeQuit({ preventDefault: () => calls.push("event.preventDefault") }),
    focusApp: () => {},
    timers: {
      setTimeout: () => null,
      clearTimeout: () => {},
      setInterval: () => null,
      clearInterval: () => {},
    },
    log: () => {},
  });

  const confirmGate =
    (name: "unsaved" | "terminal", answer: Confirm) =>
    (event: QuitEvent): void => {
      if (quitAlreadyRefused(event)) return;
      if (!updateInstallQuitInFlight() && answer !== "none") {
        calls.push(`${name}.confirm`);
        if (answer === "cancel") {
          refuseQuit(event);
          return;
        }
      }
      if (name === "terminal") calls.push("terminal.killAll");
    };

  let lastEvent: QuitEvent | null = null;
  registerAcceptedQuitCoordinator({
    lifecycle: {
      on: (_event, listener) => {
        beforeQuit = (event) => {
          lastEvent = event;
          listener(event);
        };
      },
      exit,
    },
    shutdownNativeSessions: async () => {
      calls.push("host.stop");
    },
    shutdownAgentSocket: async () => {},
    stopBackgroundWork: () => calls.push("background.stop"),
    reportFailure: vi.fn(),
    prepareQuit: (event) =>
      prepareDesktopQuit(event, {
        stopAutomations: () => calls.push("automations.stop"),
        unsavedQuit: confirmGate("unsaved", row.unsaved),
        terminalQuit: confirmGate("terminal", row.terminals),
        abortRepack: () => calls.push("repack.abort"),
        ...(row.flag ? { menuBar } : {}),
      }),
  });

  if (row.trigger === "tray") {
    // Only reachable from menu-bar mode.
    menuBar.enter();
    calls.length = 0;
    menuBar.quitFromTray();
  } else {
    beforeQuit({ preventDefault: () => calls.push("event.preventDefault") });
  }
  await settle();
  abandonAcceptedUpdateInstall();
  return { calls, exit, menuBar, event: lastEvent as QuitEvent | null };
}

afterEach(() => {
  abandonAcceptedUpdateInstall();
});

describe("the VC-577 quit decision table, through the real quit path", () => {
  const table = rows();

  it("covers every combination of the six dimensions", () => {
    // 2 live × 3 unsaved × 3 terminals × 2 update = 36 per (flag, trigger);
    // flag off has ⌘Q only.
    expect(table).toHaveLength(36 * 3);
  });

  for (const row of table) {
    const want = expected(row);
    const name =
      `flag=${row.flag ? "on" : "off"} live=${row.live} unsaved=${row.unsaved} ` +
      `terminals=${row.terminals} update=${row.update} via=${row.trigger} → ${want.outcome}`;
    it(name, async () => {
      const { calls, exit, menuBar, event } = await runRow(row);
      const exited = exit.mock.calls.length > 0;
      const entered = calls.includes("windows.closeAll");
      const outcome = exited ? "exit" : entered ? "menu-bar" : "stay";
      expect(outcome).toBe(want.outcome);
      expect(calls.includes("automations.stop")).toBe(want.automationsStopped);
      // An exit always stops the host; nothing else ever does.
      expect(calls.includes("host.stop")).toBe(want.outcome === "exit");
      if (want.outcome === "exit") expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      if (want.outcome === "menu-bar") {
        // refuseQuit, never a bare preventDefault: the coordinator stood down.
        expect(event !== null && quitAlreadyRefused(event)).toBe(true);
        expect(menuBar.isResident()).toBe(true);
        expect(calls).not.toContain("background.stop");
        expect(calls).toEqual(
          expect.arrayContaining(["windows.closeAll", "dock.hide", "tray.show"]),
        );
      }
      if (!row.flag) {
        // Today's order, call for call.
        const today = ["automations.stop"];
        if (!row.update && row.unsaved !== "none") today.push("unsaved.confirm");
        const unsavedRefused = !row.update && row.unsaved === "cancel";
        if (!unsavedRefused) {
          if (!row.update && row.terminals !== "none") today.push("terminal.confirm");
          if (row.update || row.terminals !== "cancel") today.push("terminal.killAll");
        }
        today.push("repack.abort");
        const gates = calls.filter((call) =>
          [
            "automations.stop",
            "unsaved.confirm",
            "terminal.confirm",
            "terminal.killAll",
            "repack.abort",
          ].includes(call),
        );
        expect(gates).toEqual(today);
        expect(calls).not.toContain("windows.closeAll");
      }
    });
  }
});
