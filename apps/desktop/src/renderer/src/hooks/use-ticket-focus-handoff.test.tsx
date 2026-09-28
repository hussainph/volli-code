// @vitest-environment jsdom
/**
 * The keyboard journey into a ticket and back, across the seam that makes it
 * hard (VC-419): the two surfaces are never mounted at the same time, so what
 * is asserted here is that a journey recorded by a card that has already been
 * destroyed is still honoured by the surface that mounts next — and that it is
 * honoured ONLY when focus is genuinely nobody's.
 *
 * The board is stood up as plain markup rather than through `board.tsx`,
 * deliberately: the hook's whole contract with the board is two DOM facts (the
 * focus attribute and the column scope) plus two values it is handed (what is
 * shown, and a way to reveal what is not). A rendered board would test dnd-kit
 * and the column window instead, which the built-app probe
 * (`e2e/vc419-keyboard-ticket-focus.mjs`) is what actually covers.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  forgetTicketFocusOrigin,
  rememberTicketFocusOrigin,
  TICKET_FOCUS_ATTRIBUTE,
  useTicketEntryFocus,
  useTicketFocusRestore,
} from "./use-ticket-focus-handoff";

const PROJECT = "p1";

let container: HTMLDivElement;
let root: Root;
/** The surface the hooks read: a board's cards, or a ticket's tab strip. */
let surface: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  forgetTicketFocusOrigin();
  surface = document.createElement("div");
  document.body.append(surface);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  surface.remove();
  forgetTicketFocusOrigin();
  vi.unstubAllGlobals();
});

/** One column of focusable cards, as `ticket-card.tsx` draws them. */
function drawCard(parent: HTMLElement, id: string): HTMLElement {
  const card = document.createElement("div");
  card.setAttribute(TICKET_FOCUS_ATTRIBUTE, id);
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  parent.append(card);
  return card;
}

function drawColumn(ticketIds: readonly string[], status = "todo"): HTMLElement[] {
  surface.innerHTML = "";
  const column = document.createElement("div");
  column.setAttribute("data-board-column", status);
  surface.append(column);
  return ticketIds.map((id) => drawCard(column, id));
}

/** A ticket workspace's primary strip, as `tab-strip.tsx` draws it. */
function drawTicketTabs(): { selected: HTMLElement; first: HTMLElement } {
  surface.innerHTML = "";
  const strip = document.createElement("div");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "Ticket tabs");
  const first = document.createElement("div");
  first.setAttribute("role", "tab");
  first.tabIndex = 0;
  const selected = document.createElement("div");
  selected.setAttribute("role", "tab");
  selected.setAttribute("aria-selected", "true");
  selected.tabIndex = 0;
  strip.append(first, selected);
  surface.append(strip);
  return { selected, first };
}

function TicketView({ ticketId }: { ticketId: string }) {
  useTicketEntryFocus(PROJECT, ticketId);
  return null;
}

function BoardView({
  projectId = PROJECT,
  shownIds,
  onReveal,
}: {
  projectId?: string;
  shownIds: readonly string[];
  onReveal?: (ticketId: string | null) => void;
}) {
  useTicketFocusRestore({ projectId, shownIds, onReveal: onReveal ?? (() => {}) });
  return null;
}

/** Let the hook's poll run for a few ticks of real time (POLL_MS is 50ms). */
async function settle(ms = 180): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("useTicketEntryFocus", () => {
  it("puts focus on the primary strip's selected tab after a keyboard open", () => {
    const [card] = drawColumn(["a", "b"]);
    rememberTicketFocusOrigin(PROJECT, "a", card!);
    const { selected } = drawTicketTabs();

    act(() => root.render(<TicketView ticketId="a" />));

    expect(document.activeElement).toBe(selected);
  });

  it("falls back to the first tab when nothing is marked selected", () => {
    const [card] = drawColumn(["a"]);
    rememberTicketFocusOrigin(PROJECT, "a", card!);
    const { first, selected } = drawTicketTabs();
    selected.removeAttribute("aria-selected");

    act(() => root.render(<TicketView ticketId="a" />));

    expect(document.activeElement).toBe(first);
  });

  it("waits for a strip that is one commit late", async () => {
    const [card] = drawColumn(["a"]);
    rememberTicketFocusOrigin(PROJECT, "a", card!);
    surface.innerHTML = "";

    act(() => root.render(<TicketView ticketId="a" />));
    expect(document.activeElement).toBe(document.body);

    const { selected } = drawTicketTabs();
    await settle();
    expect(document.activeElement).toBe(selected);
  });

  it("does nothing for a ticket opened any other way — a double-click keeps the pointer's focus", () => {
    const { selected } = drawTicketTabs();

    act(() => root.render(<TicketView ticketId="a" />));

    expect(document.activeElement).not.toBe(selected);
  });

  it("does nothing for a DIFFERENT ticket than the one the keyboard opened", () => {
    const [card] = drawColumn(["a"]);
    rememberTicketFocusOrigin(PROJECT, "a", card!);
    const { selected } = drawTicketTabs();

    act(() => root.render(<TicketView ticketId="other" />));

    expect(document.activeElement).not.toBe(selected);
  });

  it("never takes focus away from something that already holds it", () => {
    const [card] = drawColumn(["a"]);
    rememberTicketFocusOrigin(PROJECT, "a", card!);
    const { selected } = drawTicketTabs();
    const composer = document.createElement("input");
    surface.append(composer);
    composer.focus();

    act(() => root.render(<TicketView ticketId="a" />));

    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(selected);
  });
});

describe("useTicketFocusRestore", () => {
  it("returns focus to the card the journey started from", () => {
    const cards = drawColumn(["a", "b", "c"]);
    rememberTicketFocusOrigin(PROJECT, "b", cards[1]!);
    // The board is rebuilt on the way back: new elements, same ticket ids.
    const rebuilt = drawColumn(["a", "b", "c"]);

    act(() => root.render(<BoardView shownIds={["a", "b", "c"]} />));

    expect(document.activeElement).toBe(rebuilt[1]);
  });

  it("takes the neighbour when the origin is no longer shown", () => {
    const cards = drawColumn(["a", "b", "c"]);
    rememberTicketFocusOrigin(PROJECT, "b", cards[1]!);
    const rebuilt = drawColumn(["a", "c"]);

    act(() => root.render(<BoardView shownIds={["a", "c"]} />));

    expect(document.activeElement).toBe(rebuilt[1]);
  });

  it("asks the column to reveal an origin its window left unmounted, then focuses it", async () => {
    const cards = drawColumn(["a", "b", "deep"]);
    rememberTicketFocusOrigin(PROJECT, "deep", cards[2]!);
    // The rebuilt board mounts only the top of the column — `deep` is held but
    // not drawn, exactly as a windowed column leaves it (VC-316).
    drawColumn(["a", "b"]);
    const revealed: (string | null)[] = [];

    act(() =>
      root.render(<BoardView shownIds={["a", "b", "deep"]} onReveal={(id) => revealed.push(id)} />),
    );
    expect(revealed).toEqual(["deep"]);
    expect(document.activeElement).toBe(document.body);

    // The column scrolls, the card mounts, and the wait finds it.
    const mounted = drawColumn(["a", "b", "deep"]);
    await settle();
    expect(document.activeElement).toBe(mounted[2]);
    // …and the request is released, so nothing pins the column afterwards.
    expect(revealed).toEqual(["deep", null]);
  });

  it("gives up on a card that never arrives, without leaving the reveal request on", async () => {
    const cards = drawColumn(["a", "deep"]);
    rememberTicketFocusOrigin(PROJECT, "deep", cards[1]!);
    drawColumn(["a"]);
    const revealed: (string | null)[] = [];

    act(() =>
      root.render(<BoardView shownIds={["a", "deep"]} onReveal={(id) => revealed.push(id)} />),
    );
    expect(revealed).toEqual(["deep"]);

    // Budget is 1.5s; this is the surface giving the column every chance and
    // then standing down rather than polling forever.
    await settle(1800);
    expect(revealed.at(-1)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("ignores a journey that belongs to another project's board", () => {
    const cards = drawColumn(["a", "b"]);
    rememberTicketFocusOrigin("other-project", "b", cards[1]!);
    const rebuilt = drawColumn(["a", "b"]);

    act(() => root.render(<BoardView shownIds={["a", "b"]} />));

    expect(document.activeElement).not.toBe(rebuilt[1]);
  });

  it("does nothing when the ticket was opened with the mouse", () => {
    const rebuilt = drawColumn(["a", "b"]);

    act(() => root.render(<BoardView shownIds={["a", "b"]} />));

    expect(document.activeElement).not.toBe(rebuilt[0]);
    expect(document.activeElement).not.toBe(rebuilt[1]);
  });

  it("never takes focus away from something a person is already using", () => {
    const cards = drawColumn(["a", "b"]);
    rememberTicketFocusOrigin(PROJECT, "b", cards[1]!);
    drawColumn(["a", "b"]);
    const composer = document.createElement("input");
    surface.append(composer);
    composer.focus();

    act(() => root.render(<BoardView shownIds={["a", "b"]} />));

    expect(document.activeElement).toBe(composer);
  });

  it("restores once: a second board mount does not re-run a spent journey", () => {
    const cards = drawColumn(["a", "b"]);
    rememberTicketFocusOrigin(PROJECT, "b", cards[1]!);
    const rebuilt = drawColumn(["a", "b"]);

    act(() => root.render(<BoardView shownIds={["a", "b"]} />));
    expect(document.activeElement).toBe(rebuilt[1]);

    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => root.render(<BoardView shownIds={["a", "b"]} />));

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when nothing of the neighbourhood is on this board", () => {
    const cards = drawColumn(["a", "b"]);
    rememberTicketFocusOrigin(PROJECT, "b", cards[1]!);
    const rebuilt = drawColumn(["x", "y"]);

    act(() => root.render(<BoardView shownIds={["x", "y"]} />));

    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(rebuilt[0]);
  });

  it("records the neighbourhood of the origin's own column, not the whole board", () => {
    // Two columns side by side: the card after the last card of Todo is the
    // first card of Doing, which must never be offered as its neighbour.
    surface.innerHTML = "";
    const todo = document.createElement("div");
    todo.setAttribute("data-board-column", "todo");
    const doing = document.createElement("div");
    doing.setAttribute("data-board-column", "doing");
    surface.append(todo, doing);
    drawCard(todo, "todo-1");
    const last = drawCard(todo, "todo-2");
    drawCard(doing, "doing-1");

    rememberTicketFocusOrigin(PROJECT, "todo-2", last);
    const rebuilt = drawColumn(["todo-1", "doing-1"]);

    act(() => root.render(<BoardView shownIds={["todo-1", "doing-1"]} />));

    // `todo-1` — the card above it in its own column — not the Doing card that
    // happens to follow it in document order.
    expect(document.activeElement).toBe(rebuilt[0]);
  });
});
