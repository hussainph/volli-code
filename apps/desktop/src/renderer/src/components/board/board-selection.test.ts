import { describe, expect, it } from "vite-plus/test";

import { ticketSelectionAfterClick } from "./board-selection";

const ORDER = ["a", "b", "c", "d"];
const COLUMN = { allIds: [...ORDER, "hidden"], visibleIds: ORDER };

describe("ticketSelectionAfterClick", () => {
  it("replaces the selection on a plain click", () => {
    expect(
      ticketSelectionAfterClick(["a", "b"], "c", COLUMN, "a", {
        toggle: false,
        range: false,
      }),
    ).toEqual({ selectedIds: ["c"], anchorId: "c" });
  });

  it("toggles one card with Command or Control", () => {
    expect(
      ticketSelectionAfterClick(["a"], "c", COLUMN, "a", { toggle: true, range: false }),
    ).toEqual({ selectedIds: ["a", "c"], anchorId: "c" });
    expect(
      ticketSelectionAfterClick(["a", "c"], "a", COLUMN, "c", {
        toggle: true,
        range: false,
      }),
    ).toEqual({ selectedIds: ["c"], anchorId: "a" });
  });

  it("selects a visible range in either direction and keeps the anchor", () => {
    expect(
      ticketSelectionAfterClick(["b"], "d", COLUMN, "b", { toggle: false, range: true }),
    ).toEqual({ selectedIds: ["b", "c", "d"], anchorId: "b" });
    expect(
      ticketSelectionAfterClick(["d"], "b", COLUMN, "d", { toggle: false, range: true }),
    ).toEqual({ selectedIds: ["b", "c", "d"], anchorId: "d" });
  });

  it("adds a Command/Control+Shift range and preserves a filtered-out selection", () => {
    expect(
      ticketSelectionAfterClick(["a", "hidden"], "d", COLUMN, "b", {
        toggle: true,
        range: true,
      }),
    ).toEqual({ selectedIds: ["a", "b", "c", "d", "hidden"], anchorId: "b" });
  });

  it("falls back to a plain or toggle click when the anchor is not visible", () => {
    expect(
      ticketSelectionAfterClick(["hidden"], "c", COLUMN, "hidden", {
        toggle: false,
        range: true,
      }),
    ).toEqual({ selectedIds: ["c"], anchorId: "c" });
    expect(
      ticketSelectionAfterClick(["hidden"], "c", COLUMN, "hidden", {
        toggle: true,
        range: true,
      }),
    ).toEqual({ selectedIds: ["hidden", "c"], anchorId: "c" });
  });

  it("keeps modifier selections from other columns while resetting the range anchor", () => {
    expect(
      ticketSelectionAfterClick(["other"], "c", COLUMN, "other", {
        toggle: true,
        range: true,
      }),
    ).toEqual({ selectedIds: ["other", "c"], anchorId: "c" });
  });

  it("replaces a cross-column selection on an unmodified Shift-click", () => {
    expect(
      ticketSelectionAfterClick(["other"], "c", COLUMN, "other", {
        toggle: false,
        range: true,
      }),
    ).toEqual({ selectedIds: ["c"], anchorId: "c" });
  });
});
