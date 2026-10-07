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
import type { Automation, PendingArmedRun, Ticket, TicketStatus } from "@volli/shared";

import { ArmedRunWindows } from "@renderer/components/automations/armed-run-window";
import {
  receivePendingArmedRuns,
  useArmedRunStore,
} from "@renderer/components/automations/armed-run";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { createFakeHostSource, hostSnapshot, remoteHost } from "@renderer/stores/host-sources";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import { Board } from "./board";
import { BoardBoundary } from "./board-boundary";

/* ------------------------------------------------- the churn instrument */

/**
 * How many droppable and sortable shells re-rendered, counted at the hooks
 * themselves. This is THE measurement that distinguishes the fixed board from
 * the broken one, because it measures the mechanism rather than its worst
 * outcome: a mid-gesture store write used to re-render `Board`, and a `Board`
 * render rebuilds every shell under `DndContext` and feeds dnd-kit's
 * measurement loop. On the pre-fix board a single roster replacement scores 4
 * sortables and 5 droppables; frozen, it scores nothing at all.
 *
 * jsdom cannot reach the runaway itself (React's nested-update limiter needs
 * real layout and real scroll feedback), so asserting zero churn is how this
 * environment can still fail when the freeze is removed. Wrapping the package
 * entry catches the board's own calls; dnd-kit's internals import these
 * directly and are unaffected.
 */
const renders = vi.hoisted(() => ({ sortable: 0, droppable: 0 }));
vi.mock("@dnd-kit/sortable", async (importActual) => {
  const actual = await importActual<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: (...args: Parameters<typeof actual.useSortable>) => {
      renders.sortable += 1;
      return actual.useSortable(...args);
    },
  };
});
vi.mock("@dnd-kit/core", async (importActual) => {
  const actual = await importActual<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDroppable: (...args: Parameters<typeof actual.useDroppable>) => {
      renders.droppable += 1;
      return actual.useDroppable(...args);
    },
  };
});

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

/**
 * The armed countdown stack, where `armed-run-window.tsx` puts it: fixed to
 * the window, `bottom-6`, centred, `w-80` cards stacking UP from the bottom
 * edge with `gap-2`, painted over the board at `z-50`. Invented pixels again,
 * but the geometry is the product's: three windows still counting down reach
 * up over the bottom of the middle columns, which is exactly where a hand
 * aiming low at a column ends up.
 */
const COUNTDOWN_W = 320;
const COUNTDOWN_H = 48;
const COUNTDOWN_GAP = 8;
const COUNTDOWN_BOTTOM = 24;

function countdownBoxes(): [Element, Box][] {
  const cards = [...document.querySelectorAll("[data-armed-run-window]")];
  const stack = cards[0]?.parentElement;
  if (stack == null) return [];
  const height = cards.length * COUNTDOWN_H + (cards.length - 1) * COUNTDOWN_GAP;
  const top = VIEWPORT.height - COUNTDOWN_BOTTOM - height;
  const boxes: [Element, Box][] = [[stack, { left: 0, top, width: VIEWPORT.width, height }]];
  cards.forEach((card, index) => {
    boxes.push([
      card,
      {
        left: (VIEWPORT.width - COUNTDOWN_W) / 2,
        top: top + index * (COUNTDOWN_H + COUNTDOWN_GAP),
        width: COUNTDOWN_W,
        height: COUNTDOWN_H,
      },
    ]);
  });
  return boxes;
}

/** Everything laid out, in paint order: the board, then the chrome over it. */
function layoutBoxes(): [Element, Box][] {
  return [...boardBoxes(), ...countdownBoxes()];
}

/**
 * What a browser's hit test reports at (x, y), topmost first. An element
 * styled `pointer-events-none` is not hit-testable and never appears — the
 * countdown's full-width wrapper is one, and its cards opt back in with
 * `pointer-events-auto` because Cancel must stay clickable.
 */
function hitsAt(x: number, y: number): Element[] {
  return layoutBoxes()
    .filter(
      ([node, box]) =>
        !classesOf(node).includes("pointer-events-none") &&
        x >= box.left &&
        x <= box.left + box.width &&
        y >= box.top &&
        y <= box.top + box.height,
    )
    .map(([node]) => node)
    .toReversed();
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
    return domRect(layoutBoxes().findLast(([node]) => node === this)?.[1] ?? NO_BOX);
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

  // jsdom ships neither hit test; a browser always ships both, and they agree.
  document.elementFromPoint = ((x: number, y: number) =>
    hitsAt(x, y)[0] ?? null) as typeof document.elementFromPoint;
  document.elementsFromPoint = ((x: number, y: number) =>
    hitsAt(x, y)) as typeof document.elementsFromPoint;

  const restoreAnimations = installAnimations();
  return () => {
    restoreAnimations();
    Element.prototype.getBoundingClientRect = realRect;
    window.getComputedStyle = realStyle as typeof window.getComputedStyle;
    for (const name of ["scrollBy", "scrollTo", "scrollIntoView"]) {
      Reflect.deleteProperty(element, name);
    }
    Reflect.deleteProperty(document, "elementFromPoint");
    Reflect.deleteProperty(document, "elementsFromPoint");
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
        {/* Beside the board, as app-shell mounts it: floating chrome that
            outlives the board and paints over it. Renders nothing until a
            countdown is pending. */}
        <ArmedRunWindows />
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

function pointerEvent(type: string, at: Point, alt = false): PointerEvent {
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

function centre(element: Element): Point {
  const box = element.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

function columnNamed(status: TicketStatus): Element {
  const found = document.querySelector(`[data-board-column="${status}"]`);
  if (found === null) throw new Error(`no column for ${status}`);
  return found;
}

/** Whether `status` is drawing its Offered list at landing-target size (⌥ held). */
function grown(status: TicketStatus): boolean {
  return (
    columnNamed(status)
      .querySelector("[data-offered-panel]")
      ?.getAttribute("data-offered-panel") === "expanded"
  );
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

/**
 * Lift the Todo card, travel until dnd-kit has settled over Doing, and zero the
 * churn counters — so whatever a test does next is the only thing they count.
 * The gesture is left LIVE and un-released on purpose: mid-air is the state in
 * which a store write used to take the board out.
 */
async function liftTodoCardAndSettle(): Promise<Point> {
  const card = columnNamed("todo").querySelector("article");
  if (card === null) throw new Error("no card in Todo");
  const grip = card.parentElement;
  if (grip === null) throw new Error("no sortable wrapper around the card");
  const from = centre(card);
  await act(async () => {
    grip.dispatchEvent(pointerEvent("pointerdown", from));
  });
  await move({ x: from.x, y: from.y + 6 });
  const target = columnNamed("doing").querySelector("article");
  if (target === null) throw new Error("no card in Doing");
  const onCard = centre(target);
  await move(onCard);
  await move({ x: onCard.x, y: 500 });
  // One more pixel so any measurement the previous move provoked has landed
  // before the counters are zeroed.
  await move({ x: onCard.x, y: 501 });
  expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
    DRAGGED,
  );
  renders.sortable = 0;
  renders.droppable = 0;
  return { x: onCard.x, y: 501 };
}

/**
 * A Run's `data:changed`, as the renderer receives it: every ticket object and
 * the label slice replaced, nothing a person can see changed. `mutate` lets a
 * caller also move a row, which is the harsher case because it changes column
 * topology rather than only identities.
 */
function replaceRoster(mutate: (row: Ticket) => Ticket = (row) => Object.assign({}, row)): void {
  const slice = useBoardStore.getState().ticketsByProject["p1"] ?? [];
  useBoardStore
    .getState()
    .hydrateProjectRoster("p1", slice.map(mutate), [
      { id: "l1", projectId: "p1", name: "running", color: null },
    ]);
}

/** The counters since they were last zeroed, as one comparable object. */
function churn(): { sortable: number; droppable: number } {
  return { sortable: renders.sortable, droppable: renders.droppable };
}

const NO_CHURN = { sortable: 0, droppable: 0 };

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
  renders.sortable = 0;
  renders.droppable = 0;
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
  useArmedRunStore.setState({ pending: {} });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    enabledIds: [],
    enablementRead: false,
    railReadAt: {},
  });
  // The board reads view and sort from here, so a test that writes them
  // mid-gesture needs a known starting point.
  useWorkspaceStore.setState({ byProject: { p1: { ...DEFAULT_WORKSPACE_UI } } });
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
  it.each([false, true])(
    "retains pointer and Option input before drag-start commits (already held: %s)",
    async (alreadyHeld) => {
      await mountBoard();
      const card = columnNamed("todo").querySelector("article")!;
      const from = centre(card);
      const doing = centre(columnNamed("doing"));
      await act(async () => {
        card.parentElement!.dispatchEvent(pointerEvent("pointerdown", from, alreadyHeld));
        // One browser task: activation, arrival and Option all precede React's
        // passive effects for the newly active drag. No compensating nudge.
        document.dispatchEvent(
          pointerEvent("pointermove", { x: from.x, y: from.y + 6 }, alreadyHeld),
        );
        document.dispatchEvent(pointerEvent("pointermove", doing, alreadyHeld));
        if (!alreadyHeld) {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
        }
      });
      expect(document.querySelector("[data-board-drag]")).not.toBeNull();
      expect(grown("doing")).toBe(true);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
      });
      expect(grown("doing")).toBe(false);
      expect(columnNamed("doing").querySelector("[data-offered-panel]")).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
        );
      });
      expect(document.querySelector("[data-board-drag]")).toBeNull();
      // The permanently mounted listeners must do no hit test or consume
      // digits at rest, and must never revive the just-ended picker.
      const hitTest = vi.spyOn(document, "elementsFromPoint");
      const digit = new KeyboardEvent("keydown", {
        key: "1",
        code: "Digit1",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        document.dispatchEvent(pointerEvent("pointermove", doing, true));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
        window.dispatchEvent(digit);
      });
      expect(hitTest).not.toHaveBeenCalled();
      expect(digit.defaultPrevented).toBe(false);
      expect(columnNamed("doing").querySelector("[data-offered-panel]")).toBeNull();
      expect(loopErrors()).toEqual([]);
    },
  );

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

/**
 * The freeze itself, measured rather than inferred.
 *
 * Every test here fails on the pre-fix board — that is the point of them. The
 * test above passes with or without the freeze, because jsdom cannot reach the
 * runaway the freeze prevents; these assert the MECHANISM the freeze removes,
 * which jsdom reproduces exactly.
 */
describe("a store write that lands while a card is in the air", () => {
  it(
    "re-renders no droppable and no sortable when an automation replaces the whole roster",
    async () => {
      await mountBoard();
      await liftTodoCardAndSettle();

      await act(async () => {
        replaceRoster();
      });

      // Pre-fix: 4 sortables and 5 droppables, every one of them feeding
      // dnd-kit a fresh rect mid-gesture.
      expect(churn()).toEqual(NO_CHURN);
      // And the gesture is untouched: same card in the air, same topology.
      expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
        DRAGGED,
      );
      expect(loopErrors()).toEqual([]);
    },
    BUDGET,
  );

  it(
    "re-renders nothing when the automation also moves a ticket to another column",
    async () => {
      await mountBoard();
      await liftTodoCardAndSettle();

      // The harsher roster: a row LEAVES a column. Column topology is the input
      // dnd-kit's droppable set is built from, so this is the write most likely
      // to reach the measurement loop.
      await act(async () => {
        replaceRoster((row) =>
          row.id === "t2"
            ? Object.assign({}, row, { status: "needs_review" as TicketStatus })
            : row,
        );
      });

      expect(churn()).toEqual(NO_CHURN);
      expect(loopErrors()).toEqual([]);
    },
    BUDGET,
  );

  it(
    "re-renders nothing for a label, filter, sort or view write",
    async () => {
      await mountBoard();
      await liftTodoCardAndSettle();

      // Each of these is a read the board holds ABOVE `DndContext`, and each was
      // its own open door before VC-446 froze it.
      await act(async () => {
        useBoardStore.setState({
          labelsByProject: { p1: [{ id: "l9", projectId: "p1", name: "fresh", color: null }] },
        });
      });
      expect(churn()).toEqual(NO_CHURN);

      // A filter that would hide every card on the board, if it were read.
      await act(async () => {
        useBoardStore.setState({
          filterByProject: { p1: { search: "nothing-matches", priorities: [], labels: [] } },
        });
      });
      expect(churn()).toEqual(NO_CHURN);
      // Still four cards' worth of columns, because the filter is frozen out.
      expect(ticketSlots("doing")).not.toEqual([]);

      await act(async () => {
        useWorkspaceStore.setState({
          byProject: {
            p1: { ...DEFAULT_WORKSPACE_UI, boardSort: { key: "title", direction: "asc" } },
          },
        });
      });
      expect(churn()).toEqual(NO_CHURN);

      // The view switch is the one that does not merely re-render but UNMOUNTS
      // the active sortable under dnd-kit. A keyboard drag leaves the pointer
      // free to press the toggle, so it is reachable rather than theoretical.
      await act(async () => {
        useWorkspaceStore.setState({
          byProject: { p1: { ...DEFAULT_WORKSPACE_UI, boardView: "list" } },
        });
      });
      expect(churn()).toEqual(NO_CHURN);
      // Still the board view, still holding the card.
      expect(document.querySelector('[data-board-column="doing"]')).not.toBeNull();
      expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
        DRAGGED,
      );
      expect(loopErrors()).toEqual([]);
    },
    BUDGET,
  );

  it(
    "reads the store live again once the gesture has ended",
    async () => {
      await mountBoard();

      // The counterpart to every test above: a freeze that is never released is
      // a board that stops updating. Drive the whole gesture to completion, then
      // prove the reads came back.
      await dragTodoCardIntoDoing();
      expect(ticketSlots("doing")).toContain(DRAGGED);
      renders.sortable = 0;
      renders.droppable = 0;

      await act(async () => {
        replaceRoster((row) =>
          row.id === "t4" ? Object.assign({}, row, { status: "todo" as TicketStatus }) : row,
        );
      });

      // At rest a roster replacement SHOULD re-render — that is the board doing
      // its job. If this reads zero, the snapshot leaked past the gesture.
      expect(renders.sortable).toBeGreaterThan(0);
      // And the moved ticket actually arrived, which only a live read can show.
      expect(ticketSlots("todo")).toContain("t4");
      expect(loopErrors()).toEqual([]);
    },
    BUDGET,
  );
});

/** One countdown still running, as main projects it to every window. */
function pendingRun(ticketId: string, openedAt: number): PendingArmedRun {
  return {
    id: `arrival-${ticketId}`,
    ticketId,
    projectId: "p1",
    ticketDisplayId: `PRB-${ticketId}`,
    automationId: AUTOMATION.id,
    automationName: AUTOMATION.name,
    status: "doing",
    origin: "armed",
    openedAt,
    startAt: Date.now() + 60_000,
  };
}

/**
 * The countdown is floating chrome that must stay clickable — its Cancel is
 * the only way to stop a Run about to start — so it is painted over the board
 * and wins the browser's hit test wherever it sits. The ⌥ picker reads the
 * column under the hand from that same hit test, so a drag aimed low at a
 * column could land "in no column" and the picker never opened (VC-451).
 */
describe("a card in the air over a running countdown", () => {
  it(
    "opens the column's picker when ⌥ is held with the pointer over a countdown card",
    async () => {
      await mountBoard();
      // Three drops in quick succession, all still counting down: the stack
      // reaches up over the bottom of the middle columns.
      await act(async () => {
        receivePendingArmedRuns([pendingRun("t2", 1), pendingRun("t3", 2), pendingRun("t4", 3)]);
      });
      await liftTodoCardAndSettle();

      const doing = columnNamed("doing").getBoundingClientRect();
      const aim = { x: Math.round(doing.left + doing.width / 2), y: doing.bottom - 10 };
      // The premise, checked rather than assumed: the topmost thing under the
      // hand is a countdown card, not anything inside the column.
      expect(
        document.elementFromPoint(aim.x, aim.y)?.closest("[data-armed-run-window]"),
      ).not.toBeNull();

      await move(aim, true);

      expect(grown("doing")).toBe(true);
      expect(loopErrors()).toEqual([]);
    },
    BUDGET,
  );
});

function cloud(enabled: boolean): void {
  useExperimentsStore.setState({ snapshot: { cloud: { enabled, source: "storage" } } });
}

function writeControls(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-board-column] button")].filter(
    (button) => button.textContent?.trim() === "New" || button.hasAttribute("data-column-arming"),
  );
}
/**
 * Read-only (VC-576): while the project's host cannot serve, a move is a
 * write like any other — no card lifts, and the column's create and arm
 * controls stand down, greyed as in the lab. Reading still works.
 */
describe("a read-only board", () => {
  let detach: (() => void) | null = null;
  const remote = createFakeHostSource(
    hostSnapshot(
      [remoteHost("h1", "hetzner-1", { link: { status: "offline", since: 0, retryAt: null } })],
      { p1: "h1" },
    ),
  );

  beforeEach(() => {
    detach = useHostConnectionStore.getState().attach(remote);
  });

  afterEach(() => {
    act(() => remote.setHost("h1", { link: { status: "offline", since: 0, retryAt: null } }));
    detach?.();
    detach = null;
    useExperimentsStore.setState({ snapshot: null });
  });

  async function pressAndTravel(): Promise<void> {
    const card = columnNamed("todo").querySelector("article");
    const grip = card?.parentElement;
    if (!card || !grip) throw new Error("no card in Todo");
    const from = centre(card);
    await act(async () => {
      grip.dispatchEvent(pointerEvent("pointerdown", from));
    });
    await move({ x: from.x, y: from.y + 6 });
  }

  it(
    "lifts no card, moves nothing, and stands New and Arm down",
    async () => {
      cloud(true);
      await mountBoard();
      await pressAndTravel();
      expect(document.querySelector("[data-board-drag]")).toBeNull();
      await act(async () => {
        document.dispatchEvent(pointerEvent("pointerup", { x: 400, y: 500 }));
      });
      expect(window.api.tickets.move).not.toHaveBeenCalled();
      expect(ticketSlots("todo")).toEqual(["t1", "t2"]);

      const controls = writeControls();
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.disabled).toBe(true);
        expect(control.hasAttribute("data-host-read-only")).toBe(true);
      }
    },
    BUDGET,
  );

  it(
    "drags again, with every control back, once the host serves",
    async () => {
      cloud(true);
      await mountBoard();
      act(() => remote.setHost("h1", { link: { status: "open" } }));
      for (const control of writeControls()) {
        expect(control.hasAttribute("data-host-read-only")).toBe(false);
      }
      await pressAndTravel();
      expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
        DRAGGED,
      );
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    },
    BUDGET,
  );

  it(
    "changes nothing with the flag off, whatever the host is doing",
    async () => {
      cloud(false);
      await mountBoard();
      for (const control of writeControls()) {
        expect(control.hasAttribute("data-host-read-only")).toBe(false);
        expect(control.disabled).toBe(false);
      }
      await pressAndTravel();
      expect(document.querySelector("[data-board-drag]")?.getAttribute("data-board-drag")).toBe(
        DRAGGED,
      );
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    },
    BUDGET,
  );
});
