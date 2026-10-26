/**
 * The routing between what a drop means and the store twin that writes it —
 * exercised against a recording writes bag, because the module's whole claim
 * is that BOTH surfaces get exactly these calls for exactly these gestures.
 * Which twin a surface binds is the surface's business; that the right one is
 * asked, with the right ids, is this module's.
 */
import { SPLIT_VIEW_ROOT_PANE_ID } from "@volli/shared";
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
    ungroupTab: vi.fn(),
    splitPane: vi.fn(),
    activateTab: vi.fn(),
    openPayload: vi.fn(() => opensAs),
  };
  return { writes: calls, calls };
}

const ROOT = SPLIT_VIEW_ROOT_PANE_ID;

describe("reorderDropWrite", () => {
  it("arranges the surface from the top strip's full-width pane", () => {
    const { writes, calls } = recordingWrites(null);
    reorderDropWrite(writes, ROOT, "a", ["a", "b"]);
    expect(calls.reorderSurface).toHaveBeenCalledWith("a", ["a", "b"]);
    expect(calls.reorderPane).not.toHaveBeenCalled();
  });

  it("rewrites a group pane's own stack, leaving the surface alone", () => {
    const { writes, calls } = recordingWrites(null);
    reorderDropWrite(writes, "pane-2", "a", ["a", "b"]);
    expect(calls.reorderPane).toHaveBeenCalledWith("pane-2", "a", ["a", "b"]);
    expect(calls.reorderSurface).not.toHaveBeenCalled();
  });
});

describe("tabDropWrite", () => {
  it("routes a reorder through the same surface-or-pane branch", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(writes, { kind: "reorder", paneId: "pane-2", movedId: "a", ids: ["a"] });
    expect(calls.reorderPane).toHaveBeenCalledWith("pane-2", "a", ["a"]);
  });

  it("hands a move into a group pane to the pane twin", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(writes, { kind: "move", tabId: "a", paneId: "pane-2" });
    expect(calls.moveTabToPane).toHaveBeenCalledWith("a", "pane-2");
    expect(calls.ungroupTab).not.toHaveBeenCalled();
  });

  it("takes a tab moved to the top strip out of its group", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(writes, { kind: "move", tabId: "a", paneId: ROOT });
    expect(calls.ungroupTab).toHaveBeenCalledWith("a");
    expect(calls.moveTabToPane).not.toHaveBeenCalled();
  });

  it("splits the pane the zone names", () => {
    const { writes, calls } = recordingWrites(null);
    tabDropWrite(writes, { kind: "split", paneId: ROOT, edge: "left", tabId: "a" });
    expect(calls.splitPane).toHaveBeenCalledWith(ROOT, "left", "a");
  });
});

describe("nativeDropWrite", () => {
  it("writes nothing when the payload opens no tab", () => {
    const { writes, calls } = recordingWrites(null);
    nativeDropWrite(writes, TERMINAL, "pane-2", "center");
    expect(calls.openPayload).toHaveBeenCalledWith(TERMINAL);
    expect(calls.moveTabToPane).not.toHaveBeenCalled();
    expect(calls.activateTab).not.toHaveBeenCalled();
    expect(calls.splitPane).not.toHaveBeenCalled();
  });

  it("moves the opened tab into a group pane for a centre drop", () => {
    const { writes, calls } = recordingWrites("t1");
    nativeDropWrite(writes, TERMINAL, "pane-2", "center");
    expect(calls.moveTabToPane).toHaveBeenCalledWith("t1", "pane-2");
    expect(calls.activateTab).not.toHaveBeenCalled();
  });

  it("answers a full-width centre drop with the activation door, payload and all", () => {
    const { writes, calls } = recordingWrites("t1");
    nativeDropWrite(writes, TERMINAL, ROOT, "center");
    expect(calls.activateTab).toHaveBeenCalledWith("t1", TERMINAL);
    expect(calls.moveTabToPane).not.toHaveBeenCalled();
  });

  it("splits on an edge with the tab the drop just opened", () => {
    const { writes, calls } = recordingWrites("chat:s1");
    nativeDropWrite(writes, CHAT, ROOT, "right");
    expect(calls.splitPane).toHaveBeenCalledWith(ROOT, "right", "chat:s1");
  });

  it("maps the bottom band to a down split", () => {
    const { writes, calls } = recordingWrites("chat:s1");
    nativeDropWrite(writes, CHAT, "pane-2", "bottom");
    expect(calls.splitPane).toHaveBeenCalledWith("pane-2", "down", "chat:s1");
  });
});
