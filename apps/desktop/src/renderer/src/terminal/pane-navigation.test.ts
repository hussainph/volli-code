import { describe, expect, it } from "vite-plus/test";

import type { SessionLayout } from "@renderer/stores/sessions";

import { adjacentPaneId } from "./pane-navigation";

const pane = (sessionId: string): SessionLayout => ({ kind: "pane", sessionId, exitCode: null });

const crossLayout: SessionLayout = {
  kind: "split",
  id: "root",
  direction: "vertical",
  ratio: 0.4,
  first: pane("left"),
  second: {
    kind: "split",
    id: "right-stack",
    direction: "horizontal",
    ratio: 0.35,
    first: pane("top-right"),
    second: pane("bottom-right"),
  },
};

describe("adjacentPaneId", () => {
  it("moves between direct left and right siblings", () => {
    expect(adjacentPaneId(crossLayout, "left", "right")).toBe("bottom-right");
    expect(adjacentPaneId(crossLayout, "top-right", "left")).toBe("left");
  });

  it("moves vertically through a nested stack", () => {
    expect(adjacentPaneId(crossLayout, "top-right", "down")).toBe("bottom-right");
    expect(adjacentPaneId(crossLayout, "bottom-right", "up")).toBe("top-right");
  });

  it("uses perpendicular proximity when multiple panes share the requested edge", () => {
    expect(adjacentPaneId(crossLayout, "bottom-right", "left")).toBe("left");
    expect(adjacentPaneId(crossLayout, "left", "right")).toBe("bottom-right");
  });

  it("does not wrap at an outer edge", () => {
    expect(adjacentPaneId(crossLayout, "left", "left")).toBeNull();
    expect(adjacentPaneId(crossLayout, "top-right", "up")).toBeNull();
    expect(adjacentPaneId(crossLayout, "bottom-right", "down")).toBeNull();
  });

  it("returns null for an unknown active pane or a one-pane layout", () => {
    expect(adjacentPaneId(crossLayout, "missing", "right")).toBeNull();
    expect(adjacentPaneId(pane("only"), "only", "right")).toBeNull();
  });

  it("selects the nearest directional pane before a farther candidate", () => {
    const rows: SessionLayout = {
      kind: "split",
      id: "outer",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "top",
        direction: "vertical",
        ratio: 0.5,
        first: pane("top-left"),
        second: pane("top-right"),
      },
      second: pane("bottom"),
    };

    expect(adjacentPaneId(rows, "top-right", "down")).toBe("bottom");
    expect(adjacentPaneId(rows, "bottom", "up")).toBe("top-left");
  });
});
