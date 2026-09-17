// @vitest-environment jsdom
/**
 * A column is bounded in what it MOUNTS and unbounded in what it HOLDS (VC-316).
 *
 * `column-window.test.ts` next door holds the arithmetic. This file holds the
 * four claims that only a rendered column can make, and each of them is a
 * thing a windowed board would otherwise quietly break:
 *
 * 1. A board small enough to fit renders exactly the DOM it rendered before —
 *    no window, no spacers. Every board e2e smoke and every hand test on an
 *    ordinary project depends on that, and it is why the minimum exists.
 * 2. `SortableContext` still receives EVERY id. dnd-kit indexes the sorting
 *    strategy by position in that array, so a windowed list handed only its
 *    mounted ids would compute every transform against the wrong indices.
 * 3. While a card is in the air the window may grow and may not shrink — the
 *    rule that keeps a droppable dnd-kit has already measured from vanishing
 *    underneath it mid-gesture (the VC-221 crash class).
 * 4. Selecting a row outside the window scrolls the column to it rather than
 *    mounting everything in between.
 *
 * jsdom performs no layout, so every rect here is zero: the column measures a
 * zero-height viewport and a zero-height card, and therefore falls back to the
 * minimum window and the fallback stride. That is not a limitation for these
 * claims — it makes the mounted count exactly predictable — but it does mean
 * nothing here asserts a PIXEL. The spacer heights are checked as a ratio of
 * the fallback stride rather than as a rendered layout.
 */
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DndContext } from "@dnd-kit/core";
import type { Label, Ticket, TicketStatus } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { BoardColumn } from "./board-column";
import { COLUMN_ROW_STRIDE_FALLBACK, COLUMN_WINDOW_MINIMUM } from "./column-window";
import { BoardSessionActivityProvider } from "./session-activity-context";
import { TicketDialogHost } from "./ticket-dialog-host";

/** Every `items` array `SortableContext` has been handed, newest last. */
const sortableItems = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@dnd-kit/sortable", async (importActual) => {
  const actual = await importActual<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    SortableContext: (props: Parameters<typeof actual.SortableContext>[0]) => {
      sortableItems.calls.push([...(props.items as readonly unknown[])]);
      return actual.SortableContext(props);
    },
  };
});

let root: Root | null = null;
let container: HTMLElement | null = null;

/**
 * Reads the mounted cards at exactly the moment `board.tsx`'s FLIP effect does.
 *
 * A parent's layout effect runs in the SAME commit as its children's and AFTER
 * them — but before React re-renders for state a child's layout effect just
 * scheduled. That ordering is the entire drop-animation regression: a column
 * that repairs its own window in a layout effect has not yet repaired the DOM
 * this parent is reading. `board.tsx` holds its FLIP in a layout effect above
 * the columns, so this stands in exactly the place that matters.
 */
function FlipObserver({
  onCommit,
  children,
}: {
  onCommit?: (ids: string[]) => void;
  children: React.ReactNode;
}) {
  React.useLayoutEffect(() => {
    onCommit?.(
      [...document.querySelectorAll<HTMLElement>("[data-board-ticket-slot]")].map(
        (slot) => slot.dataset.boardTicketSlot ?? "",
      ),
    );
  });
  return <>{children}</>;
}

function ticket(index: number, status: TicketStatus = "doing"): Ticket {
  return {
    id: `t${index}`,
    projectId: "p1",
    ticketNumber: index,
    title: `Ticket ${index}`,
    body: "",
    status,
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: index,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const NO_LABELS: readonly Label[] = [];
const NO_IDS: readonly string[] = [];

function column(count: number) {
  return Array.from({ length: count }, (_value, index) => ticket(index + 1));
}

interface RenderOptions {
  selectedIds?: readonly string[];
  dragActive?: boolean;
  /** Called once per commit with the cards in the DOM at FLIP time. */
  onCommit?: (ids: string[]) => void;
}

async function mount(tickets: Ticket[], options: RenderOptions = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render(tickets, options);
}

async function render(tickets: Ticket[], options: RenderOptions = {}) {
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <BoardSessionActivityProvider
          projectId="p1"
          ticketIds={new Set(tickets.map((one) => one.id))}
        >
          <TicketDialogHost projectId="p1">
            <DndContext>
              <FlipObserver onCommit={options.onCommit}>
                <BoardColumn
                  status="doing"
                  tickets={tickets}
                  projectId="p1"
                  ticketPrefix="VC"
                  projectLabels={NO_LABELS}
                  selectedIds={options.selectedIds ?? NO_IDS}
                  draggingIds={NO_IDS}
                  groupDragIds={NO_IDS}
                  onSelect={() => {}}
                  onOpen={() => {}}
                  composerInitiallyOpen={false}
                  onComposerClose={() => {}}
                  animateEnter={false}
                  dragActive={options.dragActive ?? false}
                />
              </FlipObserver>
            </DndContext>
          </TicketDialogHost>
        </BoardSessionActivityProvider>
      </TooltipProvider>,
    );
  });
}

function dropzone(): HTMLElement {
  const node = container?.querySelector<HTMLElement>("[data-column-dropzone]");
  if (node === null || node === undefined) throw new Error("column dropzone did not render");
  return node;
}

function scroller(): HTMLElement {
  const node = container?.querySelector<HTMLElement>("[data-column-scroller]");
  if (node === null || node === undefined) throw new Error("column scroller did not render");
  return node;
}

function mountedCards(): number {
  return container?.querySelectorAll("[data-board-ticket-slot]").length ?? 0;
}

function mountedIds(): string[] {
  return [...(container?.querySelectorAll<HTMLElement>("[data-board-ticket-slot]") ?? [])].map(
    (slot) => slot.dataset.boardTicketSlot ?? "",
  );
}

/**
 * Give the scroller a height and a scroll range.
 *
 * jsdom performs no layout, so a scroller reports `clientHeight` 0 and
 * `scrollHeight` 0 — and a scroll range of zero clamps every offset to zero,
 * which would make "scroll to the selected row" untestable rather than untrue.
 * These are the only two pixels this file invents, and they invent a plain
 * 600px column over 500 fallback-stride rows.
 */
function giveScrollerLayout(rows: number) {
  const node = scroller();
  Object.defineProperty(node, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(node, "scrollHeight", {
    value: rows * COLUMN_ROW_STRIDE_FALLBACK,
    configurable: true,
  });
}

/** Drive the scroller the way a wheel would: move it, then announce it. */
async function scrollTo(offset: number) {
  await act(async () => {
    scroller().scrollTop = offset;
    scroller().dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  sortableItems.calls = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom ships no `matchMedia`, and every card reads it through
  // `useReducedMotion`. Answers "no preference", which is the path that keeps
  // the transitions on — the bound under test must hold in the busier case.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  // …and no `ResizeObserver`, which the column installs to hear its own
  // viewport change. Inert here on purpose: every case below moves the window
  // by scrolling, which is the path a person actually takes.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("a column that fits", () => {
  it("mounts every card and renders no spacer", async () => {
    await mount(column(COLUMN_WINDOW_MINIMUM));

    expect(mountedCards()).toBe(COLUMN_WINDOW_MINIMUM);
    expect(dropzone().dataset.columnCount).toBe(String(COLUMN_WINDOW_MINIMUM));
    expect(dropzone().dataset.columnMounted).toBe(String(COLUMN_WINDOW_MINIMUM));
    expect(container?.querySelectorAll("[data-column-spacer]").length).toBe(0);
  });
});

describe("a column that does not fit", () => {
  it("mounts a window, holds every ticket, and says which number is which", async () => {
    await mount(column(500));

    expect(mountedCards()).toBe(COLUMN_WINDOW_MINIMUM);
    // What the column HOLDS is not bounded: the badge a person reads, the
    // published count, and the sortable list are all still 500.
    expect(dropzone().dataset.columnCount).toBe("500");
    expect(dropzone().dataset.columnMounted).toBe(String(COLUMN_WINDOW_MINIMUM));
    expect(container?.textContent).toContain("500");
  });

  it("hands SortableContext every id, not just the mounted ones", async () => {
    await mount(column(500));

    const items = sortableItems.calls.at(-1);
    expect(items?.length).toBe(500);
    expect(items?.at(0)).toBe("t1");
    expect(items?.at(-1)).toBe("t500");
  });

  it("stands a spacer in for each end, sized by the rows it replaces", async () => {
    await mount(column(500));
    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 100);

    const leading = container?.querySelector<HTMLElement>('[data-column-spacer="leading"]');
    const trailing = container?.querySelector<HTMLElement>('[data-column-spacer="trailing"]');
    const ids = mountedIds();
    const first = Number(ids[0]?.slice(1)) - 1;
    const last = first + ids.length;

    expect(first).toBeGreaterThan(0);
    expect(Number.parseFloat(leading?.style.height ?? "")).toBeCloseTo(
      first * COLUMN_ROW_STRIDE_FALLBACK - 8,
      0,
    );
    expect(Number.parseFloat(trailing?.style.height ?? "")).toBeCloseTo(
      (500 - last) * COLUMN_ROW_STRIDE_FALLBACK - 8,
      0,
    );
  });

  it("follows the scroll offset", async () => {
    await mount(column(500));
    expect(mountedIds()).toContain("t1");

    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 200);

    const ids = mountedIds();
    expect(ids).not.toContain("t1");
    expect(ids).toContain("t200");
    expect(ids.length).toBeLessThanOrEqual(COLUMN_WINDOW_MINIMUM + 12);
  });
});

describe("while a card is in the air", () => {
  it("grows the window and never shrinks it", async () => {
    await mount(column(500), { dragActive: true });
    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 200);
    const deep = mountedIds();
    expect(deep).toContain("t200");

    // Auto-scroll carries the gesture back up. Every card dnd-kit measured on
    // the way down has to still be mounted when it gets there.
    await scrollTo(0);
    const after = mountedIds();

    expect(after).toContain("t1");
    for (const id of deep) expect(after).toContain(id);
  });

  it("goes back to following the scroller once the card lands", async () => {
    await mount(column(500), { dragActive: true });
    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 200);
    await scrollTo(0);
    expect(mountedIds().length).toBeGreaterThan(COLUMN_WINDOW_MINIMUM);

    await render(column(500), { dragActive: false });

    expect(mountedIds().length).toBe(COLUMN_WINDOW_MINIMUM);
    expect(mountedIds()).toContain("t1");
  });
});

describe("a drop that grows the column", () => {
  /**
   * The regression `boundedWindow` exists for — `board-smoke.mjs` check 8.5.
   *
   * A column's window is state, and state is one commit behind the props that
   * moved it. A multi-card drop grows `tickets` in a render where the tracked
   * window is still the pre-drop one. The column does repair itself, but in a
   * layout effect — and `board.tsx`'s FLIP is the PARENT's layout effect, which
   * runs in that same commit, before the repair re-renders anything. So the
   * FLIP reads the DOM the stale window produced and finds no slot for the
   * cards that just landed; the drop animation is silently skipped.
   *
   * Asserting after `act` could never catch this: by then the column has
   * re-rendered and the DOM is right. This asserts at the FLIP's own moment,
   * which is why it is a rendered case and not an arithmetic one.
   */
  it("mounts the just-landed cards in the same commit the FLIP reads", async () => {
    const commits: string[][] = [];
    const onCommit = (ids: string[]) => commits.push(ids);
    await mount(column(3), { onCommit });
    expect(commits.at(-1)).toEqual(["t1", "t2", "t3"]);

    // Two cards land: the column now HOLDS five while its tracked window still
    // says three. `commits[0]` is the first commit after that growth, which is
    // the one the board's FLIP effect would have read.
    commits.length = 0;
    await render(column(5), { onCommit });

    expect(commits[0]).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("still mounts at least the minimum when the growth crosses it", async () => {
    const commits: string[][] = [];
    const onCommit = (ids: string[]) => commits.push(ids);
    await mount(column(COLUMN_WINDOW_MINIMUM - 1), { onCommit });

    commits.length = 0;
    await render(column(COLUMN_WINDOW_MINIMUM + 5), { onCommit });

    // Past the minimum the column is windowed again, so it does not owe the
    // FLIP every card — but it still owes it a full window rather than the
    // thirty-nine the pre-growth state remembered.
    expect(commits[0]?.length).toBe(COLUMN_WINDOW_MINIMUM);
  });
});

describe("a column the ticket list changed underneath", () => {
  it("renders an empty column with no cards and no spacers", async () => {
    await mount(column(0));

    expect(mountedCards()).toBe(0);
    expect(dropzone().dataset.columnCount).toBe("0");
    expect(dropzone().dataset.columnMounted).toBe("0");
    expect(container?.querySelectorAll("[data-column-spacer]").length).toBe(0);
  });

  it("mounts a filter's whole result when it shrinks below the minimum", async () => {
    await mount(column(500));
    giveScrollerLayout(500);
    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 400);
    expect(mountedIds()).not.toContain("t1");

    // A filter cuts the column to six while the scroller is still parked at
    // row 400 — an offset the new column has no rows at.
    await render(column(6));

    expect(mountedCards()).toBe(6);
    expect(mountedIds()).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(container?.querySelectorAll("[data-column-spacer]").length).toBe(0);
  });

  it("drops the drag's widened window once the card lands and the list has changed", async () => {
    await mount(column(500), { dragActive: true });
    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 200);
    await scrollTo(0);
    expect(mountedIds().length).toBeGreaterThan(COLUMN_WINDOW_MINIMUM);

    // The drop both ends the gesture and grows the column.
    await render(column(502), { dragActive: false });

    expect(mountedIds().length).toBe(COLUMN_WINDOW_MINIMUM);
    expect(dropzone().dataset.columnCount).toBe("502");
  });
});

describe("selection", () => {
  it("scrolls a selected row outside the window into view rather than mounting up to it", async () => {
    await mount(column(500));
    giveScrollerLayout(500);
    expect(mountedIds()).not.toContain("t300");

    await render(column(500), { selectedIds: ["t300"] });

    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(mountedIds()).toContain("t300");
    // The point of scrolling rather than widening: the window is still bounded.
    expect(mountedIds().length).toBeLessThanOrEqual(COLUMN_WINDOW_MINIMUM + 12);
    const selected = container?.querySelector('[data-board-ticket-slot="t300"] [aria-pressed]');
    expect(selected?.getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves the scroller alone when the selected row is already mounted", async () => {
    await mount(column(500));

    await render(column(500), { selectedIds: ["t2"] });

    expect(scroller().scrollTop).toBe(0);
    expect(mountedIds()).toContain("t2");
  });

  it("leaves the scroller alone when the selection names no row in this column", async () => {
    await mount(column(500));
    giveScrollerLayout(500);
    await scrollTo(COLUMN_ROW_STRIDE_FALLBACK * 100);
    const parked = scroller().scrollTop;

    // A card selected in a DIFFERENT column: `findIndex` answers -1 here, and a
    // column with nothing selected must not chase it.
    await render(column(500), { selectedIds: ["somewhere-else"] });

    expect(scroller().scrollTop).toBe(parked);
  });
});
