// @vitest-environment jsdom
/**
 * A drop that RUNS something (VC-221/VC-329's uncovered interleaving).
 *
 * `board-drag-measure-loop.test.tsx` next door drives the measure loop itself,
 * but every one of its gestures ends with Escape — dnd-kit's CANCEL path, which
 * writes nothing to the board and runs no drop animation. So the whole board
 * suite had zero coverage of the one interleaving the crash reports name:
 * release the card with a real `pointerup`, and have the Automation that
 * release triggers change the board WHILE dnd-kit is still tearing the gesture
 * down.
 *
 * **The interleaving, as the product actually performs it.** A release over an
 * armed column calls `moveTicket` with a `DeliberateMoveChoice`; main persists
 * the move AND starts the Run, then broadcasts both the new pending countdown
 * and a `data:changed` the renderer answers with `hydrateProjectRoster` — a
 * WHOLESALE slice replacement in which every ticket object is new. That
 * replacement is the board's filter → group → sort → `SortableContext` input.
 * The fake gateway below is that whole sequence, fired from inside the move
 * call so it lands in the microtask right after `onDragEnd`, which is where
 * main's reply lands in the app.
 *
 * **What is asserted.** The ticket is in the destination column, the Automation
 * was triggered exactly once (a re-entrant render loop re-runs the drop), and
 * React logged nothing — `Maximum update depth exceeded` (#185) and
 * `Too many re-renders` both arrive on `console.error` before `BoardBoundary`
 * catches them, so the boundary's own fallback is checked too.
 *
 * **Honest about jsdom**, in exactly the terms the sibling file sets out: the
 * runaway that reaches React's nested-update limiter needs real layout and real
 * scroll feedback, and jsdom has neither. What this file CAN run is every
 * commit the interleaving actually makes — the drop's own write, the roster
 * replacement, and dnd-kit's teardown and drop animation on top of both — over
 * the board's real DOM, driven by real pointer events through the real
 * `PointerSensor`. So it pins the commit chain rather than the crash.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Automation, Ticket, TicketStatus } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";

import { Board } from "./board";
import { BoardBoundary } from "./board-boundary";

/* --------------------------------------------------------- the layout shim */

/**
 * jsdom performs no layout, so a drag test has to supply one. Only the PIXELS
 * are invented: which element scrolls, which is the droppable and which holds
 * the cards are all read off the rendered markup, exactly as the sibling
 * file's larger shim does.
 */
const VIEWPORT = { width: 1024, height: 768 };
const HEADER_H = 48;
const GUTTER = 16;
const COLUMN_W = 288;
const COLUMN_GAP = 16;
const COLUMN_HEADER_H = 36;
const COLUMN_FOOTER_H = 40;
const CARD_H = 84;
const CARD_GAP = 8;
const LIST_PAD_X = 8;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function classesOf(element: Element): string {
  return typeof element.className === "string" ? element.className : "";
}

function scrolls(element: Element, axis: "x" | "y"): boolean {
  const classes = classesOf(element);
  return classes.includes(`overflow-${axis}-auto`) || classes.includes("overflow-auto");
}

function scrollerUnder(root: ParentNode, axis: "x" | "y"): Element | null {
  const found = root.querySelector(`[class*="overflow-${axis}-auto"], [class*="overflow-auto"]`);
  return found !== null && scrolls(found, axis) ? found : null;
}

function columnBoxes(root: Element, left: number, canvas: Box, out: [Element, Box][]): void {
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
  const dropzone = root.querySelector("[data-column-dropzone]");
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
    const sortable = card.parentElement;
    if (sortable !== null) out.push([sortable, box]);
    out.push([card, box]);
  });
}

function boardBoxes(): [Element, Box][] {
  const canvas = scrollerUnder(document, "x");
  if (canvas === null) return [];
  const canvasBox: Box = {
    left: 0,
    top: HEADER_H,
    width: VIEWPORT.width,
    height: VIEWPORT.height - HEADER_H,
  };
  const boxes: [Element, Box][] = [[canvas, canvasBox]];
  let x = canvasBox.left + GUTTER - canvas.scrollLeft;
  for (const child of canvas.children) {
    if (!child.hasAttribute("data-board-column")) continue;
    columnBoxes(child, x, canvasBox, boxes);
    x += COLUMN_W + COLUMN_GAP;
  }
  return boxes;
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

/**
 * The Web Animations stub is what the Escape-cancel gestures next door never
 * needed: a committed release runs dnd-kit's DROP ANIMATION, which calls
 * `node.animate(...)` on the overlay and awaits its `onfinish`. jsdom ships no
 * Web Animations API at all, so without this the commit path throws before the
 * interleaving under test can happen. It resolves on the next task, which is
 * the same ordering a real 200ms animation has relative to the IPC reply.
 */
function installAnimations(): () => void {
  const element = Element.prototype as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(element, "animate");
  const real = element["animate"];
  element["animate"] = function (this: Element) {
    const animation = {
      onfinish: null as null | (() => void),
      oncancel: null as null | (() => void),
      cancel() {},
      finish() {},
      play() {},
      pause() {},
      effect: null,
      playState: "finished",
    };
    setTimeout(() => animation.onfinish?.(), 0);
    return animation;
  };
  if (!Object.prototype.hasOwnProperty.call(element, "getAnimations")) {
    element["getAnimations"] = () => [];
  }
  return () => {
    if (had) element["animate"] = real;
    else Reflect.deleteProperty(element, "animate");
    Reflect.deleteProperty(element, "getAnimations");
  };
}

function installLayout(): () => void {
  const realRect = Element.prototype.getBoundingClientRect;
  const realStyle = window.getComputedStyle.bind(window);
  const element = Element.prototype as unknown as Record<string, unknown>;
  for (const name of ["scrollBy", "scrollTo", "scrollIntoView"]) element[name] = () => {};

  Element.prototype.getBoundingClientRect = function measured(this: Element) {
    return domRect(boardBoxes().findLast(([node]) => node === this)?.[1] ?? NO_BOX);
  };

  window.getComputedStyle = ((node: Element, pseudo?: string | null) => {
    const style = realStyle(node as HTMLElement, pseudo ?? undefined);
    const x = scrolls(node, "x");
    const y = scrolls(node, "y");
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

  document.elementFromPoint = ((x: number, y: number) => {
    const hit = boardBoxes().findLast(
      ([, box]) =>
        x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height,
    );
    return hit?.[0] ?? null;
  }) as typeof document.elementFromPoint;

  const restoreAnimations = installAnimations();
  return () => {
    restoreAnimations();
    Element.prototype.getBoundingClientRect = realRect;
    window.getComputedStyle = realStyle as typeof window.getComputedStyle;
    for (const name of ["scrollBy", "scrollTo", "scrollIntoView"]) {
      Reflect.deleteProperty(element, name);
    }
    Reflect.deleteProperty(document, "elementFromPoint");
  };
}

/* -------------------------------------------------------------- the board */

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

const AUTOMATION: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Implement",
  instructions: "/implement",
  // Armed in Doing: a plain release there is what starts the Run.
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  createdAt: 1,
  updatedAt: 1,
};

const TICKETS = [
  ticket("t1", 1, "todo"),
  ticket("t2", 2, "todo"),
  ticket("t3", 3, "doing"),
  ticket("t4", 4, "needs_review"),
];

const DRAGGED = "t1";

let root: Root | null = null;
let container: HTMLElement | null = null;
let restoreLayout: (() => void) | null = null;

async function mountBoard(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        {/* The real containment the app mounts the board behind, so a render
            fault shows up as the fallback card rather than as a bare throw. */}
        <BoardBoundary projectId="p1">
          <Board projectId="p1" ticketPrefix="PRB" />
        </BoardBoundary>
      </TooltipProvider>,
    );
  });
}

async function unmountBoard(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

/* ------------------------------------------------------------ the gesture */

interface Point {
  x: number;
  y: number;
}

function pointerEvent(type: string, at: Point): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    isPrimary: true,
    clientX: at.x,
    clientY: at.y,
  });
}

async function move(at: Point): Promise<void> {
  await act(async () => {
    document.dispatchEvent(pointerEvent("pointermove", at));
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

function ticketSlots(status: TicketStatus): string[] {
  return [...columnNamed(status).querySelectorAll<HTMLElement>("[data-board-ticket-slot]")].map(
    (slot) => slot.dataset.boardTicketSlot!,
  );
}

/** Which droppable dnd-kit says the card is over, read from its own live region. */
function overNow(): string | null {
  const spoken = document.querySelector('[role="status"]')?.textContent ?? "";
  return /droppable area (.+)\.$/.exec(spoken)?.[1] ?? null;
}

/**
 * The whole gesture, as a hand performs it: press a Todo card, travel into
 * Doing, and RELEASE there with a real `pointerup`. Every prior board drag test
 * ends with Escape instead, which is dnd-kit's cancel path and commits nothing.
 */
async function dragTodoCardIntoDoing(): Promise<void> {
  const card = columnNamed("todo").querySelector("article");
  if (card === null) throw new Error("no card in Todo");
  const grip = card.parentElement;
  if (grip === null) throw new Error("no sortable wrapper around the card");
  const from = centre(card);

  await act(async () => {
    grip.dispatchEvent(pointerEvent("pointerdown", from));
  });
  await move({ x: from.x, y: from.y + 6 });
  expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
    DRAGGED,
  );

  // Onto the Doing card, then onto Doing's own empty space below it — the
  // card↔column flip the measure loop feeds on, performed on the way in.
  const target = columnNamed("doing").querySelector("article");
  if (target === null) throw new Error("no card in Doing");
  const onCard = centre(target);
  await move(onCard);
  await move({ x: onCard.x, y: 500 });
  expect(overNow()).toBe("column:doing");

  await act(async () => {
    document.dispatchEvent(pointerEvent("pointerup", { x: onCard.x, y: 500 }));
  });
  // The drop animation and the gateway reply both settle on later tasks.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/* ------------------------------------------------------------------ setup */

/** Every Automation trigger the drop caused, in order. */
let triggered: { ticketId: string; toStatus: TicketStatus }[] = [];
let reactErrors: string[] = [];

/**
 * Main's whole answer to a release over an armed column, in one place.
 *
 * 1. the move is persisted and answered authoritatively;
 * 2. the Run is started — the countdown projection every window receives;
 * 3. the Run's own board effect arrives as a `data:changed` the renderer
 *    answers with `hydrateProjectRoster`, which replaces EVERY ticket object.
 *
 * Steps 2 and 3 are queued as microtask/task work off the move reply, which is
 * where they land in the app: adjacent to drag-end, inside dnd-kit's teardown.
 */
function moveGateway(input: {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
  toIndex: number;
}): Promise<{ ok: true; tickets: Ticket[] }> {
  const slice = useBoardStore.getState().ticketsByProject[input.projectId] ?? [];
  const moved = slice.map((row) =>
    row.id === input.ticketId ? Object.assign({}, row, { status: input.toStatus }) : row,
  );
  if (
    AUTOMATION.trigger.kind === "columns" &&
    AUTOMATION.trigger.columns.includes(input.toStatus)
  ) {
    triggered.push({ ticketId: input.ticketId, toStatus: input.toStatus });
    // The Run's effect on the board: the roster comes back with every row a
    // fresh object (what `hydrateProjectRoster` always produces) and the
    // dropped ticket carrying the Run's label.
    queueMicrotask(() => {
      useBoardStore.getState().hydrateProjectRoster(
        input.projectId,
        moved.map((row) => ({
          ...row,
          ...(row.id === input.ticketId ? { labels: ["running"], updatedAt: 2 } : {}),
        })),
        [{ id: "l1", projectId: input.projectId, name: "running", color: null }],
      );
    });
  }
  return Promise.resolve({ ok: true, tickets: moved });
}

beforeEach(() => {
  triggered = [];
  reactErrors = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    reactErrors.push(args.map((arg) => String(arg)).join(" "));
  });
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      automations: {
        list: vi.fn(async () => ({ ok: true, automations: [AUTOMATION] })),
        armings: vi.fn(async () => ({
          ok: true,
          armings: [{ projectId: "p1", status: "doing", automationId: "a1", armedAt: 1 }],
        })),
        columnOrders: vi.fn(async () => ({ ok: true, orders: [] })),
        enablement: vi.fn(async () => ({ ok: true, enabledAutomationIds: ["a1"] })),
      },
      tickets: { move: vi.fn(moveGateway) },
    },
  });
  useBoardStore.setState({
    ticketsByProject: { p1: TICKETS },
    labelsByProject: { p1: [] },
    filterByProject: {},
    selectedByProject: {},
    unloadedTicketBodies: {},
  });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    enabledIds: [],
    enablementRead: false,
    railReadAt: {},
  });
  restoreLayout = installLayout();
});

afterEach(async () => {
  await unmountBoard();
  restoreLayout?.();
  restoreLayout = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Anything React says about a render loop, whatever wording the build uses. */
function loopErrors(): string[] {
  return reactErrors.filter(
    (message) =>
      message.includes("Maximum update depth exceeded") ||
      message.includes("Too many re-renders") ||
      message.includes("Minified React error #185") ||
      message.includes("[board] render failed"),
  );
}

const BUDGET = 60_000;

describe("a released card whose landing column runs an automation", () => {
  it(
    "lands in the destination column, triggers the automation once, and logs no render loop",
    async () => {
      await mountBoard();
      expect(ticketSlots("todo")).toEqual(["t1", "t2"]);

      await dragTodoCardIntoDoing();

      // The board survived: the boundary never drew its fallback…
      expect(document.querySelector("[data-board-boundary-fallback]")).toBeNull();
      // …and React never reported a runaway commit chain.
      expect(loopErrors()).toEqual([]);
      // The card is where it was dropped, and nowhere else.
      expect(ticketSlots("doing")).toContain(DRAGGED);
      expect(ticketSlots("todo")).not.toContain(DRAGGED);
      // One release is one Run. A re-entrant drop path would raise this.
      expect(triggered).toEqual([{ ticketId: DRAGGED, toStatus: "doing" }]);
    },
    BUDGET,
  );
});
