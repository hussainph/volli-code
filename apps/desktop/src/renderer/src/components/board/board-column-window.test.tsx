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

async function mount(
  tickets: Ticket[],
  options: { selectedIds?: readonly string[]; dragActive?: boolean } = {},
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render(tickets, options);
}

async function render(
  tickets: Ticket[],
  options: { selectedIds?: readonly string[]; dragActive?: boolean } = {},
) {
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <BoardSessionActivityProvider
          projectId="p1"
          ticketIds={new Set(tickets.map((one) => one.id))}
        >
          <TicketDialogHost projectId="p1">
            <DndContext>
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
});
