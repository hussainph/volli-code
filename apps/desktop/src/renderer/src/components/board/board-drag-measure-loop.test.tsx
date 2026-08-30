// @vitest-environment jsdom
/**
 * The measure loop itself, driven (VC-221).
 *
 * `board-column-dropzone.test.tsx` next door holds the DOM SHAPE the fix
 * introduced, and `dnd-kit-patch.test.ts` holds the guard in the shipped
 * artifact. Neither of them starts a drag, so neither can fail for the reason
 * the board actually died: both would still pass with the runtime loop intact.
 * This file is the one that runs it.
 *
 * **What killed the board.** dnd-kit answers `getScrollableAncestors` by
 * walking UP from a node and EXCLUDING that node. While a column's list was
 * both the droppable and the `overflow-y-auto` element, a card and the column
 * holding it disagreed about their own ancestry — the card counted the list,
 * the column did not. `over` flips between a card and its column on ordinary
 * pointer travel, and each flip handed `useRects` an `elements` array of a
 * different LENGTH, re-arming its layout effect. The new state moved
 * `scrollAdjustedTranslate`, which moved `collisionRect`, which flipped `over`
 * straight back: a closed cycle that reached React's nested-update limit inside
 * one commit chain and took the whole board out through `BoardBoundary` (error
 * #185, `Maximum update depth exceeded`). It needed no modifier — ⌥ was how it
 * was noticed, not why it happened, which is why the first case below presses
 * nothing at all.
 *
 * **What is asserted.** Not a magic number of measurements, which would only
 * pin today's dnd-kit. The claim is that the measure work does not GROW with
 * the number of card↔column flips: the same gesture at three times the flips
 * must re-measure the board's scroll ancestry exactly as often. That is the
 * difference between a cycle that terminates and one that feeds itself, and it
 * is the shape of assertion a magic bound cannot make. Verified to fail against
 * the pre-fix code: with the DOM merged again, or with `sameScrollableAncestors`
 * removed from the patch, or with both undone, the count goes 7 → 23 as the
 * flips go 4 → 12.
 *
 * Measurements rather than renders, deliberately. The renders are the half a
 * browser turns into error #185, but the commit count here is identical with
 * the fix and without it — the run-away needs the layout and scroll feed jsdom
 * does not have, so a render-count assertion would pass either way and pin
 * nothing. The measurement is the quantity that separates the two, so it is the
 * quantity this asserts.
 *
 * The canvas is what is counted — the board's horizontal scroller. It is a
 * scrollable ancestor of every card and every column droppable in both shapes,
 * and it is never itself a droppable, so a measurement of it is unambiguously
 * `useRects` walking the chain rather than dnd-kit measuring a drop target. Its
 * overflow is also the loop's precondition: the cycle needs the canvas to
 * overflow horizontally so `over` has somewhere to flip, which is why this
 * fixture stands three columns and the rail — 1104px of board — in a 1024px
 * window. Probe boards that fit never reproduced it.
 *
 * **The picker is grown mid-drag, in both shapes it has.** ⌥ over a standing
 * column and ⌥ over a collapsed pill draw the same Offered list from the same
 * builder (`column-offered-panel.tsx`), and both grow while a card is in the
 * air over a droppable dnd-kit is measuring. Each case below asserts the panel
 * really did grow before it counts anything, so the coverage cannot rot into a
 * gesture that quietly stopped opening it.
 *
 * **Honest about jsdom.** React's nested-update limiter cannot be reached here:
 * the feed that closes the cycle in a browser runs through real layout and real
 * scroll, and jsdom has neither. What jsdom CAN run is the loop's engine —
 * `getScrollableAncestors`, `useScrollableAncestors`'s identity, and
 * `useRects`'s layout effect — over the board's real DOM, driven by real
 * pointer events through the real `PointerSensor`. So this pins the cycle's
 * feed rather than its crash. The crash's own stack is in the ticket.
 *
 * **The layout shim, and what it does not decide.** jsdom performs no layout:
 * every rect is zero, `elementFromPoint` does not exist, and Tailwind's classes
 * are never applied, so `getComputedStyle().overflowY` answers `visible` for
 * everything. A drag test in jsdom therefore has to supply a layout, and this
 * one does — but only the PIXELS. Everything the fix is about is read from the
 * rendered DOM: which element carries `overflow-y-auto`, how the scroller and
 * the droppable nest, and which element holds the cards. Undo the fix and the
 * shim reports the pre-fix chain, because it derives that chain from the
 * pre-fix markup rather than being told it.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Automation, Ticket, TicketStatus } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";

import { Board } from "./board";
import { columnDroppableId } from "./board-dnd";

/* --------------------------------------------------------- the layout shim */

/**
 * The owner's board in a window narrow enough to overflow, which is the
 * condition the loop needs: three standing columns plus the rail come to
 * 1104px of content in 1024px of canvas, so `over` has somewhere to flip.
 * jsdom's own `innerWidth`/`innerHeight` are these numbers, and dnd-kit reads
 * them for its window rect — they have to agree.
 */
const VIEWPORT = { width: 1024, height: 768 };
const BOARD_HEADER_H = 48;
const GUTTER = 16;
const COLUMN_W = 288;
const COLUMN_GAP = 16;
const RAIL_W = 176;
const COLUMN_HEADER_H = 36;
const COLUMN_FOOTER_H = 40;
const CARD_H = 84;
const CARD_GAP = 8;
const LIST_PAD_X = 8;
const RAIL_HEADING_H = 20;
const PILL_H = 36;
const PILL_GAP = 4;
const PANEL_PAD = 4;
const PANEL_ROW_GAP = 4;
const PANEL_ROW_H = { expanded: 36, collapsed: 20 };

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Tailwind's classes are the only style information a jsdom tree carries. */
function classesOf(element: Element): string {
  return typeof element.className === "string" ? element.className : "";
}

function scrolls(element: Element, axis: "x" | "y"): boolean {
  const classes = classesOf(element);
  return classes.includes(`overflow-${axis}-auto`) || classes.includes("overflow-auto");
}

/**
 * The one element under `root` that scrolls on `axis`, found by its class the
 * way {@link scrolls} answers for it. A class selector rather than a walk
 * because this runs on every single `getBoundingClientRect`.
 */
function scrollerUnder(root: ParentNode, axis: "x" | "y"): Element | null {
  const found = root.querySelector(`[class*="overflow-${axis}-auto"], [class*="overflow-auto"]`);
  return found !== null && scrolls(found, axis) ? found : null;
}

/**
 * The Offered list, wherever it is hanging — over a standing column's cards or
 * under a collapsed pill. Absolutely positioned in both, so it is placed on top
 * of `place` rather than taking room from anything.
 */
function panelBoxes(host: Element, place: Omit<Box, "height">, out: [Element, Box][]): void {
  const panel = host.querySelector("[data-offered-panel]");
  if (panel === null) return;
  const expanded = panel.getAttribute("data-offered-panel") === "expanded";
  const rowHeight = expanded ? PANEL_ROW_H.expanded : PANEL_ROW_H.collapsed;
  const gap = expanded ? PANEL_ROW_GAP : 0;
  const rows = [...panel.children];
  const box: Box = {
    ...place,
    height: PANEL_PAD * 2 + rows.length * rowHeight + Math.max(0, rows.length - 1) * gap,
  };
  const floated = panel.parentElement;
  if (floated !== null) out.push([floated, box]);
  out.push([panel, box]);
  rows.forEach((row, index) => {
    out.push([
      row,
      {
        left: box.left + PANEL_PAD,
        top: box.top + PANEL_PAD + index * (rowHeight + gap),
        width: box.width - PANEL_PAD * 2,
        height: rowHeight,
      },
    ]);
  });
}

/**
 * A standing column. The scroller and the droppable are both FOUND rather than
 * assumed: the scroller is whichever descendant carries `overflow-y-auto`, and
 * the droppable is whatever element the cards hang under. Before the fix those
 * are one element and this reports one box for it; after the fix they are two
 * and it reports the nesting. That is the whole point — the shim never states
 * the shape, it reads it.
 */
function columnBoxes(root: Element, left: number, canvas: Box, out: [Element, Box][]): void {
  // Columns cap at 85% of the canvas so a strip of background stays grab-able.
  const column: Box = {
    left,
    top: canvas.top,
    width: COLUMN_W,
    height: Math.round(canvas.height * 0.85),
  };
  out.push([root, column]);

  const listTop = column.top + COLUMN_HEADER_H;
  const listHeight = column.height - COLUMN_HEADER_H - COLUMN_FOOTER_H;
  const scroller = scrollerUnder(root, "y");
  if (scroller !== null) {
    out.push([scroller, { left: column.left, top: listTop, width: COLUMN_W, height: listHeight }]);
  }

  const cards = [...root.querySelectorAll("article")];
  const dropzone = cards[0]?.parentElement?.parentElement ?? null;
  if (dropzone !== null && dropzone !== scroller) {
    const content = cards.length * CARD_H + Math.max(0, cards.length - 1) * CARD_GAP;
    out.push([
      dropzone,
      {
        left: column.left + LIST_PAD_X,
        top: listTop,
        width: COLUMN_W - LIST_PAD_X * 2,
        height: Math.max(listHeight, content),
      },
    ]);
  }
  cards.forEach((card, index) => {
    const box: Box = {
      left: column.left + LIST_PAD_X,
      top: listTop + index * (CARD_H + CARD_GAP),
      width: COLUMN_W - LIST_PAD_X * 2,
      height: CARD_H,
    };
    // The card's own droppable node is the sortable wrapper around the article.
    const sortable = card.parentElement;
    if (sortable !== null) out.push([sortable, box]);
    out.push([card, box]);
  });

  panelBoxes(
    root,
    { left: column.left + LIST_PAD_X, top: listTop, width: COLUMN_W - LIST_PAD_X * 2 },
    out,
  );
}

/** The rail of collapsed pills at the board's right end, and their panels. */
function railBoxes(rail: Element, left: number, canvas: Box, out: [Element, Box][]): void {
  const pills = [...rail.querySelectorAll("[data-board-column]")];
  out.push([
    rail,
    {
      left,
      top: canvas.top,
      width: RAIL_W,
      height: RAIL_HEADING_H + pills.length * (PILL_H + PILL_GAP),
    },
  ]);
  pills.forEach((pill, index) => {
    const box: Box = {
      left,
      top: canvas.top + RAIL_HEADING_H + index * (PILL_H + PILL_GAP),
      width: RAIL_W,
      height: PILL_H,
    };
    out.push([pill, box]);
    // The pill's BUTTON is the droppable; the wrapper around it names the column.
    const button = pill.querySelector("button");
    if (button !== null) out.push([button, box]);
    panelBoxes(pill, { left: box.left, top: box.top + box.height + PILL_GAP, width: RAIL_W }, out);
  });
}

/**
 * Every box on the board, in paint order — a parent before its children, and a
 * floating panel after the cards it covers, so the LAST match at a point is
 * what a pointer would actually hit.
 */
function boardBoxes(): { boxes: [Element, Box][]; canvas: Element | null } {
  const canvas = scrollerUnder(document, "x");
  if (canvas === null) return { boxes: [], canvas: null };
  const canvasBox: Box = {
    left: 0,
    top: BOARD_HEADER_H,
    width: VIEWPORT.width,
    height: VIEWPORT.height - BOARD_HEADER_H,
  };
  const boxes: [Element, Box][] = [[canvas, canvasBox]];
  let x = canvasBox.left + GUTTER - canvas.scrollLeft;
  for (const child of canvas.children) {
    if (child.hasAttribute("data-board-column")) {
      columnBoxes(child, x, canvasBox, boxes);
      x += COLUMN_W + COLUMN_GAP;
    } else if (child.querySelector("[data-board-column]") !== null) {
      railBoxes(child, x, canvasBox, boxes);
      x += RAIL_W + COLUMN_GAP;
    }
  }
  return { boxes, canvas };
}

const NO_BOX: Box = { left: 0, top: 0, width: 0, height: 0 };

function domRect(box: Box): DOMRect {
  return {
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  } as DOMRect;
}

/** How many times dnd-kit has measured the board's horizontal scroller. */
let canvasMeasures = 0;

function installLayout(): () => void {
  const realRect = Element.prototype.getBoundingClientRect;
  const realStyle = window.getComputedStyle.bind(window);
  // jsdom implements none of the scrolling methods; dnd-kit's layout-shift
  // compensation calls scrollBy on the first scrollable ancestor mid-drag.
  const element = Element.prototype as unknown as Record<string, unknown>;
  for (const name of ["scrollBy", "scrollTo", "scrollIntoView"]) element[name] = () => {};

  Element.prototype.getBoundingClientRect = function measured(this: Element) {
    const { boxes, canvas } = boardBoxes();
    if (canvas !== null && this === canvas) canvasMeasures += 1;
    return domRect(boxes.findLast(([node]) => node === this)?.[1] ?? NO_BOX);
  };

  window.getComputedStyle = ((node: Element, pseudo?: string | null) => {
    const style = realStyle(node as HTMLElement, pseudo ?? undefined);
    const x = scrolls(node, "x");
    const y = scrolls(node, "y");
    // Only overflow is answered from the classes — dnd-kit reads `position`
    // and `transform` through the same call and must still get jsdom's own.
    return new Proxy(style, {
      get(target, key) {
        if (key === "overflowX") return x ? "auto" : "visible";
        if (key === "overflowY") return y ? "auto" : "visible";
        if (key === "overflow") return x && y ? "auto" : "visible";
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;

  // The board's own hit test (`board.tsx#pointerLanding`) is one
  // `elementFromPoint` per pointer move. jsdom ships none.
  document.elementFromPoint = ((x: number, y: number) => {
    const { boxes } = boardBoxes();
    const hit = boxes.findLast(
      ([, box]) =>
        x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height,
    );
    return hit?.[0] ?? null;
  }) as typeof document.elementFromPoint;

  return () => {
    Element.prototype.getBoundingClientRect = realRect;
    window.getComputedStyle = realStyle as typeof window.getComputedStyle;
    for (const name of ["scrollBy", "scrollTo", "scrollIntoView", "elementFromPoint"]) {
      Reflect.deleteProperty(element, name);
    }
    Reflect.deleteProperty(document, "elementFromPoint");
  };
}

/* -------------------------------------------------------------- the board */

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreLayout: (() => void) | null = null;

function ticket(id: string, ticketNumber: number, status: TicketStatus): Ticket {
  return {
    id,
    projectId: "p1",
    ticketNumber,
    title: `Ticket ${ticketNumber}`,
    body: "",
    status,
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

function automation(id: string, name: string): Automation {
  return {
    id,
    projectId: "p1",
    name,
    instructions: "/review",
    // Offered by every column, so the pill has a list to grow too — arming is a
    // property of the column and has nothing to do with it being empty.
    trigger: { kind: "columns", columns: ["todo", "doing", "backlog", "needs_review", "done"] },
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const AUTOMATIONS = [automation("a1", "Implement"), automation("a2", "Two-opinion review")];

// Three standing columns and two empty ones, which is what makes the rail
// appear and the canvas overflow.
const TICKETS = [
  ticket("t1", 1, "todo"),
  ticket("t2", 2, "todo"),
  ticket("t3", 3, "doing"),
  ticket("t4", 4, "doing"),
  ticket("t5", 5, "doing"),
  ticket("t6", 6, "needs_review"),
];

const DRAGGED = "t3";
const DOING_DROPPABLE = columnDroppableId("doing");

async function mountBoard(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <Board projectId="p1" ticketPrefix="PRB" />
      </TooltipProvider>,
    );
  });
}

/* ------------------------------------------------------------ the gesture */

interface Point {
  x: number;
  y: number;
}

function pointerEvent(type: string, at: Point, alt: boolean): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    isPrimary: true,
    clientX: at.x,
    clientY: at.y,
    altKey: alt,
  });
}

/** A pointer move, seen by dnd-kit's sensor and by the board's own hit test alike. */
async function move(at: Point, alt = false): Promise<void> {
  await act(async () => {
    document.dispatchEvent(pointerEvent("pointermove", at, alt));
  });
}

async function press(type: "keydown" | "keyup", init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  });
}

function centre(element: Element): Point {
  const box = element.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

function columnNamed(status: TicketStatus): Element {
  const found = document.querySelector(`[data-board-column="${status}"]`);
  if (found === null) throw new Error(`no column for ${status}`);
  return found;
}

/** Whether `status` is currently drawing its Offered list at landing-target size. */
function grown(status: TicketStatus): boolean {
  return (
    columnNamed(status)
      .querySelector("[data-offered-panel]")
      ?.getAttribute("data-offered-panel") === "expanded"
  );
}

/**
 * Which droppable dnd-kit says the card is over, read back from its OWN live
 * region rather than from anything this file computed. It is what keeps the
 * cases below from going vacuous: a change that stopped `over` flipping would
 * make the measure counts trivially equal, and this is what would notice.
 */
function overNow(): string | null {
  const spoken = document.querySelector('[role="status"]')?.textContent ?? "";
  return /droppable area (.+)\.$/.exec(spoken)?.[1] ?? null;
}

interface Grip {
  /** A point on the column's list, where a card is. */
  card: Point;
  /** A point on the same column below its last card — the column itself. */
  empty: Point;
  /** A point on a collapsed pill in the rail. */
  pill: Point;
}

/** Pick the first Doing card up, past the sensor's 4px activation distance. */
async function pickUp(): Promise<Grip> {
  await mountBoard();
  const cards = [...columnNamed("doing").querySelectorAll("article")];
  const first = cards[0];
  const grip = first.parentElement;
  if (grip === null) throw new Error("no sortable wrapper around the card");
  const from = centre(first);

  await act(async () => {
    grip.dispatchEvent(pointerEvent("pointerdown", from, false));
  });
  await move({ x: from.x, y: from.y + 6 });
  expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
    DRAGGED,
  );

  return {
    card: from,
    // Below the three cards (which end at y=352) and well inside the column's
    // droppable, so this point is the column and nothing else.
    empty: { x: from.x, y: 450 },
    pill: centre(columnNamed("backlog")),
  };
}

interface Loop {
  measures: number;
  /** Each droppable the card was announced over, in order, repeats collapsed. */
  over: string[];
}

/**
 * `times` round trips between a card and the column holding it — the pointer
 * travel the crash came out of — counting what dnd-kit measures while it runs.
 */
async function flip(grip: Grip, times: number, alt = false): Promise<Loop> {
  canvasMeasures = 0;
  const over: string[] = [];
  const note = (): void => {
    const now = overNow();
    if (now !== null && over.at(-1) !== now) over.push(now);
  };
  for (let round = 0; round < times; round += 1) {
    await move(grip.card, alt);
    note();
    await move(grip.empty, alt);
    note();
  }
  return { measures: canvasMeasures, over };
}

/** The card↔column alternation `times` round trips are expected to produce. */
function alternating(times: number): string[] {
  return Array.from({ length: times * 2 }, (_, index) =>
    index % 2 === 0 ? DRAGGED : DOING_DROPPABLE,
  );
}

async function endDrag(): Promise<void> {
  await press("keydown", { key: "Escape", code: "Escape" });
}

async function unmountBoard(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

/* ------------------------------------------------------------------ setup */

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Every card reads this through `useReducedMotion`. "No preference" keeps the
  // transitions on, which is the busier case the shape has to hold in.
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
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      automations: {
        list: vi.fn(async () => ({ ok: true, automations: AUTOMATIONS })),
        armings: vi.fn(async () => ({
          ok: true,
          armings: [{ projectId: "p1", status: "doing", automationId: "a1", armedAt: 1 }],
        })),
        columnOrders: vi.fn(async () => ({ ok: true, orders: [] })),
        enablement: vi.fn(async () => ({ ok: true, enabledAutomationIds: ["a1", "a2"] })),
      },
    },
  });
  useBoardStore.setState({
    ticketsByProject: { p1: TICKETS },
    labelsByProject: { p1: [] },
    filterByProject: {},
    selectedByProject: {},
  });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByTicket: {},
    enabledIds: [],
    enablementRead: false,
  });
  canvasMeasures = 0;
  restoreLayout = installLayout();
});

afterEach(async () => {
  await unmountBoard();
  restoreLayout?.();
  restoreLayout = null;
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ cases */

/** Few and many round trips of the same gesture, on two freshly mounted boards. */
const FEW = 4;
const MANY = 12;
/**
 * Each case mounts two whole boards and drives thirty-odd real pointer events
 * through React's act queue, and runs slower again under coverage
 * instrumentation. Well clear of the default 5s, which it does exceed there.
 */
const BUDGET = 60_000;

describe("a card flipping between itself and the column holding it", () => {
  it(
    "does not re-measure the board's scroll ancestry more as the flips pile up",
    async () => {
      // No modifier anywhere in this case: the crash was reported as an ⌥ drag
      // and reproduces with ⌥ never pressed.
      const few = await flip(await pickUp(), FEW);
      await endDrag();
      await unmountBoard();

      const many = await flip(await pickUp(), MANY);
      await endDrag();

      // The gesture really happened, and it really alternated.
      expect(few.over).toEqual(alternating(FEW));
      expect(many.over).toEqual(alternating(MANY));
      // …and three times the flips cost exactly the same measure work. Pre-fix
      // this reads 7 against 23.
      expect(many.measures).toBe(few.measures);
      expect(many.measures).toBeLessThanOrEqual(2);
    },
    BUDGET,
  );

  it(
    "stays bounded while the ⌥ picker is grown over the standing column",
    async () => {
      const grip = await pickUp();
      await move(grip.card);
      await press("keydown", { key: "Alt", altKey: true });
      await move(grip.card, true);
      expect(grown("doing")).toBe(true);

      const few = await flip(grip, FEW, true);
      await endDrag();
      await unmountBoard();

      const second = await pickUp();
      await move(second.card);
      await press("keydown", { key: "Alt", altKey: true });
      await move(second.card, true);
      const many = await flip(second, MANY, true);
      // The panel is still grown at the end — the flips did not close it.
      expect(grown("doing")).toBe(true);
      await endDrag();

      expect(few.over).toEqual(alternating(FEW));
      expect(many.over).toEqual(alternating(MANY));
      expect(many.measures).toBe(few.measures);
      expect(many.measures).toBeLessThanOrEqual(2);
    },
    BUDGET,
  );

  it(
    "stays bounded after the ⌥ picker has been grown over a collapsed pill",
    async () => {
      // A pill is a column drawn small, and it grows the same list. Taking the
      // picker there and back is what puts a second droppable — with a shorter
      // scroll chain — between the flips.
      async function reachPastThePill(): Promise<Grip> {
        const grip = await pickUp();
        await press("keydown", { key: "Alt", altKey: true });
        await move(grip.pill, true);
        expect(grown("backlog")).toBe(true);
        await move(grip.card, true);
        expect(grown("doing")).toBe(true);
        return grip;
      }

      const few = await flip(await reachPastThePill(), FEW, true);
      await endDrag();
      await unmountBoard();

      const many = await flip(await reachPastThePill(), MANY, true);
      await endDrag();

      expect(few.over).toEqual(alternating(FEW));
      expect(many.over).toEqual(alternating(MANY));
      expect(many.measures).toBe(few.measures);
      expect(many.measures).toBeLessThanOrEqual(2);
    },
    BUDGET,
  );
});
