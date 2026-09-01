// @vitest-environment jsdom
/**
 * A column's droppable is never its own scroll container (VC-221).
 *
 * This is one structural claim, and it is the one a board-killing crash came
 * out of. dnd-kit answers `getScrollableAncestors` by walking UP from a node
 * and excluding that node itself, so while the column's list was both the
 * droppable and the `overflow-y-auto` element, a card and the column holding it
 * disagreed about their own ancestry — the card counted the list, the column
 * did not. `over` flips between a card and its column on ordinary pointer
 * travel, and each flip handed `useRects` an `elements` array of a different
 * LENGTH. That is the first thing the patch's `sameMeasuredRects` checks, so
 * its guard could not absorb it: the new state moved `scrollAdjustedTranslate`,
 * which moved `collisionRect`, which flipped `over` straight back. The cycle
 * reached React's nested-update limit inside one commit chain and took the
 * whole board out through `BoardBoundary` — React error #185, `Maximum update
 * depth exceeded`, reported constantly on the owner's display and needing no
 * modifier at all (⌥ was how it was noticed, not why it happened).
 *
 * The other half of the fix lives in `patches/@dnd-kit__core@6.3.1.patch` and
 * is asserted by `dnd-kit-patch.test.ts`. This half is the DOM shape, and it is
 * asserted structurally rather than through computed style on purpose: jsdom
 * applies no Tailwind, so `getComputedStyle().overflowY` answers `visible` for
 * every one of these elements and a style-based test would pass no matter which
 * element carried the overflow. What actually has to hold is the nesting —
 * every card and the dropzone share one scroller, and the dropzone is not it.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DndContext } from "@dnd-kit/core";
import type { Label, Ticket } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { BoardColumn } from "./board-column";
import { BoardSessionActivityProvider } from "./session-activity-context";
import { TicketDialogHost } from "./ticket-dialog-host";

let root: Root | null = null;
let container: HTMLElement | null = null;

// Fully typed rather than cast: a cast here would have let the fixture drift
// from the record the card actually reads, which is how the first draft of this
// test failed inside `TicketCardContent` instead of on its own claim.
function ticket(id: string, ticketNumber: number): Ticket {
  return {
    id,
    projectId: "p1",
    ticketNumber,
    title: `Ticket ${ticketNumber}`,
    body: "",
    status: "doing",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: ticketNumber,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const TICKETS = [ticket("t1", 1), ticket("t2", 2), ticket("t3", 3)];
const NO_LABELS: readonly Label[] = [];

async function mount(tickets: Ticket[]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      // The providers a column expects to hang under on the real board: the
      // arming bolt is a Radix tooltip, and every card's context menu asks the
      // board-level dialog host rather than carrying its own.
      <TooltipProvider>
        <TicketDialogHost projectId="p1">
          <BoardSessionActivityProvider
            projectId="p1"
            ticketIds={new Set(tickets.map((t) => t.id))}
          >
            <DndContext>
              <BoardColumn
                status="doing"
                tickets={tickets}
                projectId="p1"
                ticketPrefix="PRB"
                projectLabels={NO_LABELS}
                selectedId={null}
                onSelect={() => {}}
                onOpen={() => {}}
                composerInitiallyOpen={false}
                onComposerClose={() => {}}
                animateEnter={false}
              />
            </DndContext>
          </BoardSessionActivityProvider>
        </TicketDialogHost>
      </TooltipProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom ships no `matchMedia`, and every card reads it through
  // `useReducedMotion`. Answers "no preference", which is the path that keeps
  // the transitions on — the shape under test must hold in the busier case.
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
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("a column's dropzone", () => {
  it("is not the element that scrolls", async () => {
    await mount(TICKETS);

    const scroller = container?.querySelector('[data-column-scroller="doing"]');
    const dropzone = container?.querySelector('[data-column-dropzone="doing"]');
    expect(scroller).not.toBeNull();
    expect(dropzone).not.toBeNull();
    // The whole bug in one assertion: the same element cannot be both.
    expect(dropzone).not.toBe(scroller);
    // The overflow lives on the scroller and nowhere below it.
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(dropzone?.className).not.toContain("overflow");
  });

  it("hangs BENEATH the scroller, so the chain above it is the cards' chain", async () => {
    await mount(TICKETS);

    const scroller = container?.querySelector('[data-column-scroller="doing"]');
    const dropzone = container?.querySelector<HTMLElement>('[data-column-dropzone="doing"]');
    // Order matters, and this is the half that fixes it. With the scroller
    // INSIDE the dropzone the two chains would differ again, just the other way
    // round — so "they are different elements" is not enough on its own.
    expect(scroller?.contains(dropzone ?? null)).toBe(true);
    expect(dropzone?.contains(scroller ?? null)).toBe(false);
  });

  it("holds every card, so a card and its column walk the same ancestors", async () => {
    await mount(TICKETS);

    const dropzone = container?.querySelector<HTMLElement>('[data-column-dropzone="doing"]');
    const cards = [...(container?.querySelectorAll("article") ?? [])];
    expect(cards).toHaveLength(TICKETS.length);
    for (const card of cards) expect(dropzone?.contains(card)).toBe(true);

    // The invariant dnd-kit actually reads, spelled out: walking up from a card
    // and from the dropzone crosses the SAME scrollable elements, because the
    // only one between them is the shared scroller above the dropzone.
    const scrollersAbove = (from: Element | null | undefined): Element[] => {
      const found: Element[] = [];
      let node = from?.parentElement ?? null;
      while (node !== null && container?.contains(node) === true) {
        if (node.hasAttribute("data-column-scroller")) found.push(node);
        node = node.parentElement;
      }
      return found;
    };
    const firstCard = cards[0];
    expect(firstCard).toBeDefined();
    expect(scrollersAbove(firstCard)).toEqual(scrollersAbove(dropzone));
  });

  it("still stands with no cards, so an emptied column keeps the same shape", async () => {
    await mount([]);

    const scroller = container?.querySelector('[data-column-scroller="doing"]');
    const dropzone = container?.querySelector('[data-column-dropzone="doing"]');
    expect(dropzone).not.toBeNull();
    expect(dropzone).not.toBe(scroller);
    expect(scroller?.contains(dropzone ?? null)).toBe(true);
  });
});
