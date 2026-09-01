/**
 * The routing between what a drop means and the store twin that writes it —
 * exercised against a recording writes bag, because the module's whole claim
 * is that BOTH surfaces get exactly these calls for exactly these gestures.
 * Which twin a surface binds is the surface's business; that the right one is
 * asked, with the right ids, is this module's.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { SplitDragPayload } from "./split-drop";
import {
  nativeDropWrite,
  reorderDropWrite,
  tabDropWrite,
  type SplitSurfaceWrites,
} from "./split-surface-drop";

const CHAT: SplitDragPayload = {
  type: "session",
  scope: "project",
  projectId: "p1",
  ticketId: null,
  kind: "chat",
  sessionId: "s1",
};

const TERMINAL: SplitDragPayload = { ...CHAT, kind: "terminal", sessionId: "t1" };

function recordingWrites(opensAs: string | null): {
  writes: SplitSurfaceWrites;
  calls: Record<keyof SplitSurfaceWrites, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    reorderSurface: vi.fn(),
    reorderPane: vi.fn(),
    moveTabToPane: vi.fn(),
    splitPane: vi.fn(),
    activateTab: vi.fn(),
    openPayload: vi.fn(() => opensAs),
  };
  return { writes: calls, calls };
}

const UNSPLIT = { isSplit: false, orderedTabIds: ["board", "a", "b"] };
const SPLIT = { isSplit: true, orderedTabIds: ["board", "a", "b"] };

describe("reorderDropWrite", () => {
  it("arranges the surface while unsplit", () => {
    const { writes, calls } = recordingWrites(null);
    reorderDropWrite(UNSPLIT, writes, "pane-2", "a", ["a", "b"]);
    expect(calls.reorderSurface).toHaveBeenCalledWith("a", ["a", "b"]);
    expect(calls.reorderPane).not.toHaveBeenCalled();
  });

  it("rewrites the pane's own order while split, leaving the surface alone", () => {
    const { writes, calls } = recordingWrites(null);
    reorderDropWrite(SPLIT, writes, "pane-2", "a", ["a", "b"]);
    expect(calls.reorderPane).toHaveBeenCalledWith("pane-2", "a", ["a", "b"]);
    expect(calls.reorderSurface).not.toHaveBeenCalled();
  });
});

describe("tabDropWrite", () => {
  it("routes a reorder through the same unsplit-or-pane branch", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(SPLIT, writes, { kind: "reorder", paneId: "pane-2", movedId: "a", ids: ["a"] });
    expect(calls.reorderPane).toHaveBeenCalledWith("pane-2", "a", ["a"]);
  });

  it("hands a move to the pane twin, which focuses and activates for it", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(SPLIT, writes, { kind: "move", tabId: "a", paneId: "pane-2" });
    expect(calls.moveTabToPane).toHaveBeenCalledWith("a", "pane-2");
  });

  it("splits with the strip as it stands — the first split's claim", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(UNSPLIT, writes, { kind: "split", paneId: "root", edge: "right", tabId: "a" });
    expect(calls.splitPane).toHaveBeenCalledWith("root", "right", "a", ["board", "a", "b"]);
  });
});

describe("nativeDropWrite", () => {
  it("writes nothing when the payload opens no tab", () => {
    const { writes, calls } = recordingWrites(null);
    nativeDropWrite(SPLIT, writes, TERMINAL, "pane-2", "center");
    expect(calls.openPayload).toHaveBeenCalledWith(TERMINAL);
    expect(calls.moveTabToPane).not.toHaveBeenCalled();
    expect(calls.activateTab).not.toHaveBeenCalled();
    expect(calls.splitPane).not.toHaveBeenCalled();
  });

  it("moves the opened tab into the pane for a centre drop while split", () => {
    const { writes, calls } = recordingWrites("t1");
    nativeDropWrite(SPLIT, writes, TERMINAL, "pane-2", "center");
    expect(calls.moveTabToPane).toHaveBeenCalledWith("t1", "pane-2");
    expect(calls.activateTab).not.toHaveBeenCalled();
  });

  it("answers an unsplit centre drop with the activation door, payload and all", () => {
    const { writes, calls } = recordingWrites("t1");
    nativeDropWrite(UNSPLIT, writes, TERMINAL, "root", "center");
    expect(calls.activateTab).toHaveBeenCalledWith("t1", TERMINAL);
    expect(calls.moveTabToPane).not.toHaveBeenCalled();
  });

  it("splits on an edge, claiming the strip PLUS the tab the drop just opened", () => {
    const { writes, calls } = recordingWrites("chat:s1");
    nativeDropWrite(UNSPLIT, writes, CHAT, "root", "right");
    expect(calls.splitPane).toHaveBeenCalledWith("root", "right", "chat:s1", [
      "board",
      "a",
      "b",
      "chat:s1",
    ]);
  });

  it("maps the bottom band to a down split", () => {
    const { writes, calls } = recordingWrites("chat:s1");
    nativeDropWrite(SPLIT, writes, CHAT, "pane-2", "bottom");
    expect(calls.splitPane).toHaveBeenCalledWith("pane-2", "down", "chat:s1", [
      "board",
      "a",
      "b",
      "chat:s1",
    ]);
  });
});
