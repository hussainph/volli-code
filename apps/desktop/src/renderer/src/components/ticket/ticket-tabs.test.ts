import { describe, expect, it } from "vite-plus/test";

import type { SessionLayout, SessionTab } from "@renderer/stores/sessions";
import {
  isClosableTicketTab,
  terminalTabState,
  type TicketTabDescriptor,
  type TicketTabKind,
} from "./ticket-tabs";

describe("isClosableTicketTab", () => {
  it("treats file, diff, and chat tabs as closable like sessions", () => {
    const kinds: TicketTabKind[] = ["body", "session", "file", "diff", "chat"];
    expect(kinds.map(isClosableTicketTab)).toEqual([false, true, true, true, true]);
  });

  it("accepts a chat descriptor with a prefixed id and a lifecycle dot", () => {
    const tab: TicketTabDescriptor = {
      id: "chat:sess-9",
      kind: "chat",
      label: "Chat 1",
      status: "working",
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.id.startsWith("chat:")).toBe(true);
  });

  it("accepts diff descriptors with relPath, optional previousPath, and dirty", () => {
    const tab: TicketTabDescriptor = {
      id: "diff:src/app.ts",
      kind: "diff",
      label: "app.ts",
      relPath: "src/app.ts",
      previousPath: "src/old.ts",
      dirty: true,
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.previousPath).toBe("src/old.ts");
  });

  it("accepts a preview File descriptor (decision #56)", () => {
    const tab: TicketTabDescriptor = {
      id: "file:src/app.ts",
      kind: "file",
      label: "app.ts",
      relPath: "src/app.ts",
      preview: true,
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.preview).toBe(true);
  });
});

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
