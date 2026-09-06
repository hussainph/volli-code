/**
 * The three decisions a drop makes, and the slot a native drag announces
 * itself in.
 *
 * The zone tests are written against BOXES rather than against the component,
 * because the whole point of the module is that the geometry is checkable
 * without a browser: the corner rule, the minimum band, and the narrow pane
 * that would otherwise have no centre left.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import {
  beginSplitDrag,
  endSplitDrag,
  isSplitZoneId,
  parseSplitDragPayload,
  parseSplitZoneId,
  splitDragPayloadJson,
  splitDragSnapshot,
  splitDragType,
  splitDropAccepts,
  splitDropEdge,
  splitDropPreview,
  splitDropZoneAt,
  splitDropZoneLabel,
  splitTabDropOperation,
  splitZoneDropOperation,
  splitZoneId,
  subscribeSplitDrag,
  SPLIT_DROP_EDGE_BAND_CSS,
  SPLIT_FILE_DRAG_TYPE,
  SPLIT_SESSION_DRAG_TYPE,
  type SplitDragPayload,
  type SplitPaneTabs,
} from "./split-drop";

const BOX = { width: 800, height: 600 };

describe("splitDropZoneAt", () => {
  it("keeps the middle of a pane for the centre", () => {
    expect(splitDropZoneAt(BOX, { x: 400, y: 300 })).toBe("center");
  });

  it("claims the outer quarter of the width for a right split", () => {
    // The band starts at 600 (800 - 25%).
    expect(splitDropZoneAt(BOX, { x: 599, y: 300 })).toBe("center");
    expect(splitDropZoneAt(BOX, { x: 601, y: 300 })).toBe("right");
    expect(splitDropZoneAt(BOX, { x: 799, y: 300 })).toBe("right");
  });

  it("claims the outer quarter of the height for a down split", () => {
    expect(splitDropZoneAt(BOX, { x: 400, y: 449 })).toBe("center");
    expect(splitDropZoneAt(BOX, { x: 400, y: 451 })).toBe("bottom");
  });

  it("gives the whole corner to the right column", () => {
    // Deep along the bottom AND inside the right band: right, because the
    // right band is a full-height column and the bottom band is what is left.
    expect(splitDropZoneAt(BOX, { x: 605, y: 595 })).toBe("right");
    expect(splitDropZoneAt(BOX, { x: 795, y: 455 })).toBe("right");
    // Just left of the column, and low: the bottom band has it.
    expect(splitDropZoneAt(BOX, { x: 595, y: 595 })).toBe("bottom");
  });

  it("holds the bands to 48px on a pane too narrow for a quarter to reach", () => {
    // 25% of 120 is 30, so the floor binds: the band starts at 72.
    expect(splitDropZoneAt({ width: 120, height: 600 }, { x: 71, y: 300 })).toBe("center");
    expect(splitDropZoneAt({ width: 120, height: 600 }, { x: 73, y: 300 })).toBe("right");
  });

  it("never lets the two bands eat the centre of a tiny pane", () => {
    // 48px of band would cover the whole 60px pane; half is the clamp, so the
    // left half is still a centre drop.
    expect(splitDropZoneAt({ width: 60, height: 60 }, { x: 10, y: 10 })).toBe("center");
    expect(splitDropZoneAt({ width: 60, height: 60 }, { x: 55, y: 10 })).toBe("right");
    expect(splitDropZoneAt({ width: 60, height: 60 }, { x: 10, y: 55 })).toBe("bottom");
  });

  it("states the band once, for the DOM and for the arithmetic", () => {
    expect(SPLIT_DROP_EDGE_BAND_CSS).toBe("min(max(25%, 48px), 50%)");
  });

  it("answers centre for a box that has not been measured", () => {
    expect(splitDropZoneAt({ width: 0, height: 0 }, { x: 0, y: 0 })).toBe("center");
    expect(splitDropZoneAt({ width: 800, height: 0 }, { x: 799, y: 0 })).toBe("center");
  });
});

describe("splitDropPreview", () => {
  it("previews the RESULT: the half a split opens, or the whole pane", () => {
    expect(splitDropPreview("right")).toEqual({
      left: "50%",
      top: "0%",
      width: "50%",
      height: "100%",
    });
    expect(splitDropPreview("bottom")).toEqual({
      left: "0%",
      top: "50%",
      width: "100%",
      height: "50%",
    });
    expect(splitDropPreview("center")).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "100%",
    });
  });
});

describe("splitDropEdge / splitDropZoneLabel", () => {
  it("maps the two edges onto the model's own vocabulary", () => {
    expect(splitDropEdge("right")).toBe("right");
    expect(splitDropEdge("bottom")).toBe("down");
    expect(splitDropEdge("center")).toBeNull();
  });

  it("names the act rather than the region", () => {
    expect(splitDropZoneLabel("right")).toBe("Split right");
    expect(splitDropZoneLabel("bottom")).toBe("Split down");
    expect(splitDropZoneLabel("center")).toBe("Move here");
  });
});

describe("zone ids", () => {
  it("round-trips a pane id that contains the separator", () => {
    const id = splitZoneId("pane:1:2", "bottom");
    expect(parseSplitZoneId(id)).toEqual({ paneId: "pane:1:2", zone: "bottom" });
    expect(isSplitZoneId(id)).toBe(true);
  });

  it("refuses a tab id, a truncated id and an unknown zone", () => {
    expect(parseSplitZoneId("file:src/app.ts")).toBeNull();
    expect(parseSplitZoneId("split-zone:right")).toBeNull();
    expect(parseSplitZoneId("split-zone:right:")).toBeNull();
    expect(parseSplitZoneId("split-zone:middle:p1")).toBeNull();
    expect(isSplitZoneId("doc")).toBe(false);
  });
});

const PANES: readonly SplitPaneTabs[] = [
  { paneId: "root", tabIds: ["chat:a", "file:one.ts"] },
  { paneId: "p1", tabIds: ["term-1"] },
];

describe("splitZoneDropOperation", () => {
  it("splits on an edge, whichever pane the tab came from", () => {
    expect(splitZoneDropOperation(PANES, "term-1", "root", "right")).toEqual({
      kind: "split",
      paneId: "root",
      edge: "right",
      tabId: "term-1",
    });
    expect(splitZoneDropOperation(PANES, "chat:a", "p1", "bottom")).toEqual({
      kind: "split",
      paneId: "p1",
      edge: "down",
      tabId: "chat:a",
    });
  });

  it("moves on a centre drop into another pane", () => {
    expect(splitZoneDropOperation(PANES, "term-1", "root", "center")).toEqual({
      kind: "move",
      tabId: "term-1",
      paneId: "root",
    });
  });

  it("writes nothing for a centre drop on the pane the tab is already in", () => {
    expect(splitZoneDropOperation(PANES, "term-1", "p1", "center")).toBeNull();
  });

  it("moves a tab no strip claims, rather than refusing it", () => {
    expect(splitZoneDropOperation(PANES, "stranger", "p1", "center")).toEqual({
      kind: "move",
      tabId: "stranger",
      paneId: "p1",
    });
  });

  it("still splits an edge of the tab's own pane — the model refuses the no-op", () => {
    expect(splitZoneDropOperation(PANES, "term-1", "p1", "right")).toEqual({
      kind: "split",
      paneId: "p1",
      edge: "right",
      tabId: "term-1",
    });
  });
});

describe("splitTabDropOperation", () => {
  it("reorders inside one pane, exactly as the strip always did", () => {
    expect(
      splitTabDropOperation({ activeId: "file:one.ts", overId: "chat:a", panes: PANES }),
    ).toEqual({
      kind: "reorder",
      paneId: "root",
      movedId: "file:one.ts",
      ids: ["file:one.ts", "chat:a"],
    });
  });

  it("moves a tab dropped on ANOTHER pane's strip", () => {
    expect(splitTabDropOperation({ activeId: "term-1", overId: "chat:a", panes: PANES })).toEqual({
      kind: "move",
      tabId: "term-1",
      paneId: "root",
    });
  });

  it("routes a zone id through the zone rules", () => {
    expect(
      splitTabDropOperation({
        activeId: "chat:a",
        overId: splitZoneId("p1", "bottom"),
        panes: PANES,
      }),
    ).toEqual({ kind: "split", paneId: "p1", edge: "down", tabId: "chat:a" });
  });

  it("writes nothing for a gesture that ended over nothing", () => {
    expect(splitTabDropOperation({ activeId: "chat:a", overId: null, panes: PANES })).toBeNull();
  });

  it("writes nothing when the drop landed on the tab itself", () => {
    expect(
      splitTabDropOperation({ activeId: "chat:a", overId: "chat:a", panes: PANES }),
    ).toBeNull();
  });

  it("writes nothing when the tab under the pointer belongs to no strip", () => {
    expect(splitTabDropOperation({ activeId: "chat:a", overId: "ghost", panes: PANES })).toBeNull();
    expect(
      splitTabDropOperation({
        activeId: "stranger",
        overId: "stranger",
        panes: [{ paneId: "root", tabIds: [] }],
      }),
    ).toBeNull();
  });

  it("moves an unclaimed tab onto the pane whose strip took the drop", () => {
    expect(splitTabDropOperation({ activeId: "stranger", overId: "term-1", panes: PANES })).toEqual(
      { kind: "move", tabId: "stranger", paneId: "p1" },
    );
  });
});

const TICKET_SESSION: SplitDragPayload = {
  type: "session",
  scope: "ticket",
  projectId: "proj-1",
  ticketId: "tick-1",
  kind: "chat",
  sessionId: "sess-1",
};

const PROJECT_FILE: SplitDragPayload = {
  type: "file",
  scope: "project",
  projectId: "proj-1",
  ticketId: null,
  relPath: "src/app.ts",
};

describe("payloads", () => {
  it("round-trips both kinds through the wire", () => {
    expect(splitDragType(TICKET_SESSION)).toBe(SPLIT_SESSION_DRAG_TYPE);
    expect(splitDragType(PROJECT_FILE)).toBe(SPLIT_FILE_DRAG_TYPE);
    expect(
      parseSplitDragPayload(SPLIT_SESSION_DRAG_TYPE, splitDragPayloadJson(TICKET_SESSION)),
    ).toEqual(TICKET_SESSION);
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, splitDragPayloadJson(PROJECT_FILE))).toEqual(
      PROJECT_FILE,
    );
  });

  it("refuses a foreign type, and bytes that are not JSON", () => {
    expect(parseSplitDragPayload("text/plain", splitDragPayloadJson(PROJECT_FILE))).toBeNull();
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, "not json")).toBeNull();
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, "null")).toBeNull();
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, '"a string"')).toBeNull();
  });

  it("refuses a scope that contradicts itself", () => {
    const ticketless = JSON.stringify({ ...TICKET_SESSION, ticketId: null });
    expect(parseSplitDragPayload(SPLIT_SESSION_DRAG_TYPE, ticketless)).toBeNull();
    const ticketed = JSON.stringify({ ...PROJECT_FILE, ticketId: "tick-1" });
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, ticketed)).toBeNull();
    const noScope = JSON.stringify({ ...PROJECT_FILE, scope: "elsewhere" });
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, noScope)).toBeNull();
    const noProject = JSON.stringify({ ...PROJECT_FILE, projectId: "" });
    expect(parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, noProject)).toBeNull();
  });

  it("refuses a payload whose subject is missing or of the wrong kind", () => {
    expect(
      parseSplitDragPayload(SPLIT_FILE_DRAG_TYPE, JSON.stringify({ ...PROJECT_FILE, relPath: "" })),
    ).toBeNull();
    expect(
      parseSplitDragPayload(
        SPLIT_FILE_DRAG_TYPE,
        JSON.stringify({ ...PROJECT_FILE, type: "session" }),
      ),
    ).toBeNull();
    expect(
      parseSplitDragPayload(
        SPLIT_SESSION_DRAG_TYPE,
        JSON.stringify({ ...TICKET_SESSION, type: "file" }),
      ),
    ).toBeNull();
    expect(
      parseSplitDragPayload(
        SPLIT_SESSION_DRAG_TYPE,
        JSON.stringify({ ...TICKET_SESSION, kind: "browser" }),
      ),
    ).toBeNull();
    expect(
      parseSplitDragPayload(
        SPLIT_SESSION_DRAG_TYPE,
        JSON.stringify({ ...TICKET_SESSION, sessionId: 7 }),
      ),
    ).toBeNull();
  });

  it("accepts a payload only on the surface its own scope names", () => {
    const ticketSurface = { scope: "ticket" as const, projectId: "proj-1", ticketId: "tick-1" };
    const homeSurface = { scope: "project" as const, projectId: "proj-1", ticketId: null };
    expect(splitDropAccepts(TICKET_SESSION, ticketSurface)).toBe(true);
    expect(splitDropAccepts(TICKET_SESSION, homeSurface)).toBe(false);
    expect(splitDropAccepts(PROJECT_FILE, homeSurface)).toBe(true);
    expect(splitDropAccepts(PROJECT_FILE, ticketSurface)).toBe(false);
    expect(splitDropAccepts(TICKET_SESSION, { ...ticketSurface, ticketId: "other-ticket" })).toBe(
      false,
    );
    expect(splitDropAccepts(PROJECT_FILE, { ...homeSurface, projectId: "proj-2" })).toBe(false);
  });
});

describe("the live native drag", () => {
  it("announces a drag, publishes it, and withdraws it once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSplitDrag(listener);
    expect(splitDragSnapshot()).toBeNull();

    beginSplitDrag(PROJECT_FILE);
    expect(splitDragSnapshot()).toEqual(PROJECT_FILE);
    expect(listener).toHaveBeenCalledTimes(1);

    endSplitDrag();
    expect(splitDragSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    // A second end is not a second event: `dragend` and a window `drop` both
    // fire for the same gesture.
    endSplitDrag();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    beginSplitDrag(TICKET_SESSION);
    expect(listener).toHaveBeenCalledTimes(2);
    endSplitDrag();
  });
});
