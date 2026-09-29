// @vitest-environment jsdom
/**
 * What a ticket FOLDER's peek shows, and the one thing it can do (D2).
 *
 * The card exists for a reason a screenshot states badly: a folder of three
 * Sessions all titled `Chat` expands into three rows that say nothing, so the
 * card owes each of them ONE line about what it did. That is asserted here per
 * Session, together with the two properties that make the card read-only by
 * construction — pressing a Session drills rather than opens, and there is no
 * field, no form and no Send or Answer anywhere in it (plan §3.5, D3).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import {
  TicketPeekCard,
  type TicketPeekCardProps,
  type TicketPeekSession,
} from "./ticket-peek-card";

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const TICKET: Ticket = {
  id: "tkt-14",
  projectId: "p1",
  ticketNumber: 14,
  title: "Sticky gutter marks lag a flick",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

const SESSIONS: readonly TicketPeekSession[] = [
  {
    rowId: "chat:chat-a1",
    title: "Gutter marks",
    age: "2m",
    summary: "The gutter recomputes from the DOM range, one frame behind the flick.",
    glyph: <span data-glyph="chat:chat-a1" />,
  },
  {
    rowId: "session:pane-9",
    title: "Claude Code",
    age: "22m",
    // Nothing readable in the tail: the card says so rather than inventing prose.
    summary: null,
    glyph: <span data-glyph="session:pane-9" />,
  },
];

function render(overrides: Partial<TicketPeekCardProps> = {}): {
  onDrill: ReturnType<typeof vi.fn<(rowId: string) => void>>;
  onOpenTicket: ReturnType<typeof vi.fn<() => void>>;
} {
  const ports = {
    onDrill: vi.fn<(rowId: string) => void>(),
    onOpenTicket: vi.fn<() => void>(),
  };
  root = createRoot(container);
  act(() => {
    root?.render(
      <TicketPeekCard
        ticket={TICKET}
        ticketPrefix="VLT"
        sessions={SESSIONS}
        position={{ left: 288, top: 120, maxHeight: 600 }}
        cardWidth={360}
        {...ports}
        {...overrides}
      />,
    );
  });
  return ports;
}

function rows(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[data-peek-drill]")];
}

function press(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the ticket it stands for", () => {
  it("names the ticket, its column and how many Sessions are behind the folder", () => {
    render();
    const card = container.querySelector("[data-peek-card]");
    expect(card?.getAttribute("data-peek-subject")).toBe("ticket");
    expect(card?.getAttribute("role")).toBe("note");
    expect(card?.getAttribute("aria-label")).toBe("Peek at VLT-14, 2 sessions");
    expect(container.querySelector("[data-peek-ticket-title]")?.textContent).toBe(
      "Sticky gutter marks lag a flick",
    );
    expect(container.textContent).toContain("VLT-14");
    expect(container.textContent).toContain("Doing");
  });

  it("counts a single Session in the singular", () => {
    render({ sessions: [SESSIONS[0]!] });
    expect(container.querySelector("[data-peek-card]")?.getAttribute("aria-label")).toBe(
      "Peek at VLT-14, 1 session",
    );
  });

  it("opens the ticket through its port", () => {
    const ports = render();
    press(container.querySelector("[aria-label='Open VLT-14']")!);
    expect(ports.onOpenTicket).toHaveBeenCalledTimes(1);
    expect(ports.onDrill).not.toHaveBeenCalled();
  });
});

describe("one line per Session", () => {
  it("gives each Session its mark, its title, its age and its own summary", () => {
    render();
    const lines = rows();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.dataset.peekDrill).toBe("chat:chat-a1");
    expect(lines[0]?.textContent).toContain("Gutter marks");
    expect(lines[0]?.textContent).toContain("2m");
    expect(lines[0]?.textContent).toContain(
      "The gutter recomputes from the DOM range, one frame behind the flick.",
    );
    // The row's own glyph, passed straight through — the list reads as the
    // sidebar in miniature rather than as a second mark map.
    expect(lines[0]?.querySelector("[data-glyph='chat:chat-a1']")).not.toBeNull();
    expect(lines[1]?.textContent).toContain("Claude Code");
    expect(lines[1]?.textContent).toContain("22m");
  });

  it("admits a Session with nothing readable instead of inventing a line", () => {
    render();
    expect(rows()[1]?.textContent).toContain("No summary yet");
  });

  it("lists the Sessions in the order the folder gave them", () => {
    render();
    expect(rows().map((line) => line.dataset.peekDrill)).toEqual([
      "chat:chat-a1",
      "session:pane-9",
    ]);
  });

  it("has an empty list, and no rows, for a folder whose Sessions have all gone", () => {
    render({ sessions: [] });
    expect(rows()).toHaveLength(0);
    expect(container.querySelector("ul")).not.toBeNull();
  });
});

describe("pressing a Session", () => {
  it("drills into that Session's own peek rather than opening it", () => {
    const ports = render();
    press(rows()[1]!);
    expect(ports.onDrill).toHaveBeenCalledTimes(1);
    expect(ports.onDrill).toHaveBeenCalledWith("session:pane-9");
    // Drilling is not navigation: nothing was opened.
    expect(ports.onOpenTicket).not.toHaveBeenCalled();
  });
});

describe("what a folder's card cannot do", () => {
  it("offers no reply anywhere: no field, no form, no Send and no Answer", () => {
    render();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    const labels = [...container.querySelectorAll("button")].map(
      (node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`,
    );
    expect(labels.some((label) => /send|answer|reply/i.test(label))).toBe(false);
    // Every button in the card is either the ticket's door or a drill.
    expect(labels).toHaveLength(rows().length + 1);
  });

  it("takes no port that could deliver words to any of the Sessions it lists", () => {
    // The props are the whole surface area: a folder card that could send would
    // have to be handed somewhere to send to, and it is not.
    const props: Array<keyof TicketPeekCardProps> = [
      "ticket",
      "ticketPrefix",
      "sessions",
      "position",
      "cardWidth",
      "onDrill",
      "onOpenTicket",
      "onPointerEnter",
      "onPointerLeave",
      "ref",
    ];
    expect(props.some((name) => /send|answer|pin|read/i.test(name))).toBe(false);
  });
});
