import { describe, expect, it } from "vite-plus/test";
import type { TicketStatus } from "@volli/shared";

import {
  dragPickerReducer,
  dragPickerRelease,
  highlightedIndex,
  IDLE_DRAG_PICKER,
  isPickerColumn,
  isPickerOpen,
  showsChooseHint,
  showsOfferedList,
  type DragPickerColumns,
  type DragPickerEvent,
  type DragPickerState,
} from "./drag-picker-model";

/**
 * A board where Doing offers three Automations and arms the first (the digit
 * order pins the armed one to index 0, so `defaultIndex` is 0 by arithmetic),
 * Needs Review offers two and arms nothing, and Backlog offers none — the
 * empty-Offered-list column that must still grow a Move only target.
 */
const columns: DragPickerColumns = {
  offeredCount: (status) => ({ backlog: 0, todo: 0, doing: 3, needs_review: 2, done: 0 })[status],
  defaultIndex: (status) => (status === "doing" ? 0 : null),
};

function run(events: readonly DragPickerEvent[], from = IDLE_DRAG_PICKER): DragPickerState {
  return events.reduce((state, event) => dragPickerReducer(state, event, columns), from);
}

const start: DragPickerEvent = { kind: "drag-start", modifierHeld: false };

function over(status: TicketStatus | null, modifierHeld = false): DragPickerEvent {
  return { kind: "pointer-move", hovered: status, modifierHeld };
}

describe("drag lifecycle", () => {
  it("is inert at rest — a digit or a held ⌥ decides nothing with no card in the air", () => {
    expect(dragPickerReducer(IDLE_DRAG_PICKER, { kind: "digit", digit: 2 }, columns)).toBe(
      IDLE_DRAG_PICKER,
    );
    expect(dragPickerReducer(IDLE_DRAG_PICKER, { kind: "modifier", held: true }, columns)).toBe(
      IDLE_DRAG_PICKER,
    );
    expect(dragPickerReducer(IDLE_DRAG_PICKER, over("doing"), columns)).toBe(IDLE_DRAG_PICKER);
    expect(showsOfferedList(IDLE_DRAG_PICKER, "doing")).toBe(false);
    expect(showsChooseHint(IDLE_DRAG_PICKER, columns)).toBe(false);
  });

  it("starts clean, so the previous drag's hover cannot replay a panel", () => {
    const settled = run([start, over("doing", true), { kind: "drag-end" }]);
    expect(settled).toEqual(IDLE_DRAG_PICKER);
    expect(run([start]).hovered).toBeNull();
    expect(isPickerOpen(run([start]))).toBe(false);
  });

  it("ends the picker whether the drag dropped or was cancelled", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    expect(isPickerOpen(open)).toBe(true);
    expect(dragPickerReducer(open, { kind: "drag-end" }, columns)).toEqual(IDLE_DRAG_PICKER);
  });
});

describe("⌥ is a state, not an edge", () => {
  it("opens on keydown while a column is hovered", () => {
    const state = run([start, over("doing"), { kind: "modifier", held: true }]);
    expect(state.picker).toEqual({ status: "doing", index: 0 });
    expect(isPickerColumn(state, "doing")).toBe(true);
    expect(isPickerColumn(state, "todo")).toBe(false);
  });

  it("opens when a move carries an ALREADY-held ⌥ onto its first column", () => {
    // The rig's two holes: ⌥ pressed over the gutter, and a drag started with
    // ⌥ already down. Neither ever sees a keydown over a column.
    const gutter = run([start, over(null), { kind: "modifier", held: true }]);
    expect(gutter.picker).toBeNull();
    expect(gutter.modifierHeld).toBe(true);
    expect(
      run([start, over(null), { kind: "modifier", held: true }, over("doing", true)]).picker,
    ).toEqual({ status: "doing", index: 0 });
    expect(
      run([{ kind: "drag-start", modifierHeld: true }, over("needs_review", true)]).picker,
    ).toEqual({ status: "needs_review", index: null });
  });

  it("collapses on the next move when the keyup never arrived", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    const collapsed = dragPickerReducer(open, over("doing", false), columns);
    expect(collapsed.picker).toBeNull();
    // Folded into the bare-digit layer, so the choice survives the collapse.
    expect(collapsed.selection).toEqual({ status: "doing", index: 0 });
  });

  it("closes on ⌥-up without ending the drag, folding the highlight forward", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "modifier", held: true },
      { kind: "digit", digit: 3 },
      { kind: "modifier", held: false },
    ]);
    expect(state.dragging).toBe(true);
    expect(state.picker).toBeNull();
    expect(state.selection).toEqual({ status: "doing", index: 2 });
    // ⌥-up with no picker open is only a modifier read.
    expect(dragPickerReducer(state, { kind: "modifier", held: false }, columns).selection).toEqual({
      status: "doing",
      index: 2,
    });
  });

  it("ignores a second keydown while a picker is already open", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    const again = dragPickerReducer(open, { kind: "modifier", held: true }, columns);
    expect(again.picker).toEqual(open.picker);
  });
});

describe("opening preselects what a plain release would already do", () => {
  it("preselects the armed column's default, never Move only", () => {
    expect(run([start, over("doing"), { kind: "modifier", held: true }]).picker).toEqual({
      status: "doing",
      index: 0,
    });
  });

  it("preselects Move only where a plain release would run nothing", () => {
    expect(run([start, over("needs_review"), { kind: "modifier", held: true }]).picker).toEqual({
      status: "needs_review",
      index: null,
    });
  });

  it("carries a digit already chosen for THIS column into the picker", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "digit", digit: 2 },
      { kind: "modifier", held: true },
    ]);
    expect(state.picker).toEqual({ status: "doing", index: 1 });
  });

  it("never seeds a picker from a choice bound to another column", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "digit", digit: 3 },
      over("needs_review", true),
    ]);
    expect(state.selection).toBeNull();
    expect(state.picker).toEqual({ status: "needs_review", index: null });
  });
});

describe("the open picker follows the pointer", () => {
  it("carries the chosen row to a column long enough to have one", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "modifier", held: true },
      { kind: "digit", digit: 2 },
      over("needs_review", true),
    ]);
    expect(state.picker).toEqual({ status: "needs_review", index: 1 });
  });

  it("falls back to Move only where the row does not exist there", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "modifier", held: true },
      { kind: "digit", digit: 3 },
      over("needs_review", true),
    ]);
    expect(state.picker).toEqual({ status: "needs_review", index: null });
  });

  it("stays put over the gutter and over its own column", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    expect(dragPickerReducer(open, over(null, true), columns).picker).toEqual(open.picker);
    expect(dragPickerReducer(open, over("doing", true), columns).picker).toEqual(open.picker);
  });

  it("takes the row the pointer is standing on", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    const onRow = dragPickerReducer(
      open,
      {
        kind: "pointer-move",
        hovered: "doing",
        modifierHeld: true,
        target: { status: "doing", index: 2 },
      },
      columns,
    );
    expect(onRow.picker).toEqual({ status: "doing", index: 2 });
    const onMoveOnly = dragPickerReducer(
      onRow,
      {
        kind: "pointer-move",
        hovered: "doing",
        modifierHeld: true,
        target: { status: "doing", index: null },
      },
      columns,
    );
    expect(onMoveOnly.picker).toEqual({ status: "doing", index: null });
  });

  it("ignores a row the column does not offer", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    const stale = dragPickerReducer(
      open,
      {
        kind: "pointer-move",
        hovered: "doing",
        modifierHeld: true,
        target: { status: "doing", index: 9 },
      },
      columns,
    );
    expect(stale.picker).toEqual(open.picker);
  });
});

describe("digits", () => {
  it("accelerate the Automation rows inside an open picker", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "modifier", held: true },
      { kind: "digit", digit: 3 },
    ]);
    expect(state.picker).toEqual({ status: "doing", index: 2 });
  });

  it("reproduce a plain drop on `1` in an armed column", () => {
    const plain = run([start, over("doing"), { kind: "modifier", held: true }]);
    const pressed = dragPickerReducer(plain, { kind: "digit", digit: 1 }, columns);
    expect(pressed.picker).toEqual(plain.picker);
    expect(dragPickerRelease(pressed, "doing")).toEqual(dragPickerRelease(plain, "doing"));
  });

  it("pick Move only with `0`, inside the picker and bare", () => {
    expect(
      run([start, over("doing"), { kind: "modifier", held: true }, { kind: "digit", digit: 0 }])
        .picker,
    ).toEqual({ status: "doing", index: null });
    expect(run([start, over("doing"), { kind: "digit", digit: 0 }]).selection).toEqual({
      status: "doing",
      index: null,
    });
  });

  it("refuse a digit the column has no row for", () => {
    const open = run([start, over("needs_review"), { kind: "modifier", held: true }]);
    expect(dragPickerReducer(open, { kind: "digit", digit: 9 }, columns).picker).toEqual(
      open.picker,
    );
    const bare = run([start, over("needs_review")]);
    expect(dragPickerReducer(bare, { kind: "digit", digit: 9 }, columns).selection).toBeNull();
  });

  it("decide nothing over the gutter with no picker open", () => {
    const state = run([start, over(null), { kind: "digit", digit: 1 }]);
    expect(state.selection).toBeNull();
  });

  it("clear back to the column's default when the same digit is pressed twice", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "digit", digit: 2 },
      { kind: "digit", digit: 2 },
    ]);
    expect(state.selection).toBeNull();
    expect(highlightedIndex(state, columns, "doing")).toBe(0);
  });

  it("survive a move within the same column and clear on leaving it", () => {
    const chosen = run([start, over("doing"), { kind: "digit", digit: 3 }]);
    expect(dragPickerReducer(chosen, over("doing"), columns).selection).toEqual({
      status: "doing",
      index: 2,
    });
    // The gutter is not another column: a choice survives crossing it.
    expect(dragPickerReducer(chosen, over(null), columns).selection).toEqual({
      status: "doing",
      index: 2,
    });
    expect(dragPickerReducer(chosen, over("needs_review"), columns).selection).toBeNull();
  });
});

describe("what is drawn", () => {
  it("shows the hovered column's list, and only the picker's while one is open", () => {
    const hovering = run([start, over("doing")]);
    expect(showsOfferedList(hovering, "doing")).toBe(true);
    expect(showsOfferedList(hovering, "needs_review")).toBe(false);
    const open = run([start, over("doing"), { kind: "modifier", held: true }, over(null, true)]);
    expect(showsOfferedList(open, "doing")).toBe(true);
    expect(showsOfferedList(open, "needs_review")).toBe(false);
  });

  it("lights the default row when nothing has been chosen, and the choice when it has", () => {
    const hovering = run([start, over("doing")]);
    expect(highlightedIndex(hovering, columns, "doing")).toBe(0);
    expect(highlightedIndex(hovering, columns, "needs_review")).toBeNull();
    const chosen = run([start, over("doing"), { kind: "digit", digit: 3 }]);
    expect(highlightedIndex(chosen, columns, "doing")).toBe(2);
    const open = run([start, over("doing"), { kind: "modifier", held: true }]);
    expect(highlightedIndex(open, columns, "doing")).toBe(0);
  });

  it("earns the ⌥ hint only over a column with something to choose, before the picker", () => {
    expect(showsChooseHint(run([start, over("doing")]), columns)).toBe(true);
    // Nothing offered here: ⌥ would grow one Move only target nobody needs a
    // hint to find.
    expect(showsChooseHint(run([start, over("backlog")]), columns)).toBe(false);
    expect(showsChooseHint(run([start, over(null)]), columns)).toBe(false);
    // Advice to press the key you are already pressing is noise.
    expect(
      showsChooseHint(run([start, over("doing"), { kind: "modifier", held: true }]), columns),
    ).toBe(false);
  });
});

describe("dragPickerRelease", () => {
  it("obeys the picker, not the pointer", () => {
    const open = run([start, over("doing"), { kind: "modifier", held: true }, over(null, true)]);
    expect(dragPickerRelease(open, null)).toEqual({
      status: "doing",
      choice: { kind: "automation", index: 0 },
    });
    // Even a release the board resolved to another column lands where the
    // picker says: no ambiguous drop region remains under ⌥.
    expect(dragPickerRelease(open, "done")).toEqual({
      status: "doing",
      choice: { kind: "automation", index: 0 },
    });
  });

  it("lands Move only as its own named target", () => {
    const state = run([
      start,
      over("doing"),
      { kind: "modifier", held: true },
      { kind: "digit", digit: 0 },
    ]);
    expect(dragPickerRelease(state, "doing")).toEqual({
      status: "doing",
      choice: { kind: "move-only" },
    });
  });

  it("carries a bare-digit choice made for the column released over", () => {
    const state = run([start, over("doing"), { kind: "digit", digit: 2 }]);
    expect(dragPickerRelease(state, "doing")).toEqual({
      status: "doing",
      choice: { kind: "automation", index: 1 },
    });
    // …and never one made for a different column.
    expect(dragPickerRelease(state, "needs_review")).toEqual({
      status: "needs_review",
      choice: { kind: "default" },
    });
  });

  it("is the plain drop when nothing was chosen", () => {
    expect(dragPickerRelease(run([start, over("doing")]), "doing")).toEqual({
      status: "doing",
      choice: { kind: "default" },
    });
  });

  it("is null for a release that names no column and has no picker open", () => {
    expect(dragPickerRelease(run([start, over(null)]), null)).toBeNull();
  });
});
