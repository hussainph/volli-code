import { describe, expect, it, vi } from "vite-plus/test";

import type { SessionLayout, SessionTab } from "@renderer/stores/sessions";
import type { TerminalIoResult } from "@volli/shared";
import {
  runOnLivePanes,
  terminalTabDot,
  terminalTabState,
  type TerminalTabState,
} from "./terminal-tab-state";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@renderer/lib/toast", () => ({ toastError }));

function pane(sessionId: string, exitCode: number | null = null): SessionLayout {
  return { kind: "pane", sessionId, exitCode };
}

function tabOf(layout: SessionLayout): SessionTab {
  return {
    sessionId: "root",
    title: "Terminal 1",
    scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
    layout,
    activePaneId: "root",
  };
}

/** Two panes side by side — the case every "every/some" below actually turns on. */
function splitOf(first: SessionLayout, second: SessionLayout): SessionLayout {
  return { kind: "split", id: "sp1", direction: "vertical", ratio: 0.5, first, second };
}

describe("terminalTabState", () => {
  it("reads a live, unparked tab as plain", () => {
    expect(terminalTabState(tabOf(pane("root")), {})).toEqual({
      exited: false,
      exitCode: null,
      parked: false,
      keptAwake: false,
      livePaneIds: ["root"],
    });
  });

  it("is parked only when EVERY live pane is", () => {
    const layout = splitOf(pane("a"), pane("b"));
    const parked = { parked: true, keepAwake: false };
    expect(terminalTabState(tabOf(layout), { a: parked }).parked).toBe(false);
    expect(terminalTabState(tabOf(layout), { a: parked, b: parked }).parked).toBe(true);
  });

  it("is kept awake when ANY live pane is pinned", () => {
    const layout = splitOf(pane("a"), pane("b"));
    const state = terminalTabState(tabOf(layout), {
      b: { parked: false, keepAwake: true },
    });
    expect(state.keptAwake).toBe(true);
  });

  it("counts a dead pane out of the park set, so one live pane still decides", () => {
    // The exited pane holds no memory to reclaim and cannot be woken; letting it
    // vote would make a half-dead split permanently "parked".
    const layout = splitOf(pane("a", 0), pane("b"));
    const state = terminalTabState(tabOf(layout), { b: { parked: true, keepAwake: false } });
    expect(state.exited).toBe(false);
    expect(state.parked).toBe(true);
    expect(state.livePaneIds).toEqual(["b"]);
  });

  it("is exited only when every pane is, and surfaces a code for the hover line", () => {
    expect(terminalTabState(tabOf(splitOf(pane("a", 0), pane("b"))), {}).exited).toBe(false);
    const dead = terminalTabState(tabOf(splitOf(pane("a", 130), pane("b", 0))), {});
    expect(dead.exited).toBe(true);
    expect(dead.exitCode).toBe(130);
    // Vacuously parked with no live panes — which is exactly why every reader
    // gates the moon badge and "Park Now" on `!exited` as well.
    expect(dead.parked).toBe(true);
    expect(dead.livePaneIds).toEqual([]);
  });
});

/** A live, unparked terminal — the baseline every case below varies one fact of. */
function stateOf(overrides: Partial<TerminalTabState>): TerminalTabState {
  return {
    exited: false,
    exitCode: null,
    parked: false,
    keptAwake: false,
    livePaneIds: ["root"],
    ...overrides,
  };
}

describe("terminalTabDot", () => {
  it("reads a running terminal as idle — live and quiet, not a live turn", () => {
    expect(terminalTabDot(stateOf({}))).toBe("idle");
  });

  it("reads an ended PTY as exited", () => {
    expect(terminalTabDot(stateOf({ exited: true, exitCode: 0, livePaneIds: [] }))).toBe("exited");
  });

  it("stays silent while parked — the moon badge says that one", () => {
    expect(terminalTabDot(stateOf({ parked: true }))).toBeNull();
  });

  it("prefers exited over parked, because `parked` is vacuously true with no live panes", () => {
    expect(terminalTabDot(stateOf({ exited: true, parked: true, livePaneIds: [] }))).toBe("exited");
  });
});

describe("runOnLivePanes", () => {
  it("runs the action once per pane and says nothing when every one succeeds", async () => {
    toastError.mockClear();
    const seen: string[] = [];
    runOnLivePanes(
      ["a", "b"],
      (paneId) => {
        seen.push(paneId);
        return Promise.resolve<TerminalIoResult>({ ok: true });
      },
      "Park",
    );
    await Promise.resolve();
    expect(seen).toEqual(["a", "b"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a refused mutation rather than swallowing it", async () => {
    toastError.mockClear();
    runOnLivePanes(
      ["a"],
      () => Promise.resolve<TerminalIoResult>({ ok: false, error: "gone" }),
      "Wake",
    );
    await Promise.resolve();
    expect(toastError).toHaveBeenCalledWith("Wake failed: gone");
  });

  it("surfaces a rejected mutation too — a throw is a failure like any other", async () => {
    toastError.mockClear();
    runOnLivePanes(["a"], () => Promise.reject(new Error("boom")), "Keep Awake");
    await Promise.resolve();
    await Promise.resolve();
    expect(toastError).toHaveBeenCalledWith("Keep Awake failed: boom");
  });
});
