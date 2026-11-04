// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { EMPTY_TICKET_FILTER, type Ticket } from "@volli/shared";
import { BoardHeader } from "./board-header";
import { TicketCardContent } from "./ticket-card";
import { TicketRowContent } from "./board-list-view";

const ticket: Ticket = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "A long ticket title that still keeps its two-line scanning measure",
  body: "",
  status: "doing",
  priority: "high",
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

function markup(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("Glass board", () => {
  it("scopes accent rings to the board and keeps a distinct resting arc with Motion off", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
    expect(css).toContain(":root .session-ring.board-session-ring");
    expect(css).toContain("--session-ring-seed: var(--canvas-accent)");
    expect(css).toContain("--session-ring-color: var(--primary-text)");
    expect(css).toContain(
      ':root[data-motion="off"] .board-session-ring[data-activity="working"]::before',
    );
    expect(css).toContain('.session-ring.board-session-ring[data-activity="working"]::before');
  });
  it.each([null, "working", "waiting"] as const)(
    "carries %s activity on the accent ring alone, keeping priority and key",
    (sessionActivity) => {
      const host = markup(
        renderToStaticMarkup(
          <TicketCardContent
            ticket={ticket}
            ticketPrefix="DRV"
            projectLabels={[]}
            sessionActivity={sessionActivity}
          />,
        ),
      );
      expect(host.querySelector("article")?.classList.contains("rounded-(--radius-card)")).toBe(
        true,
      );
      expect(
        host.querySelector(".session-ring.board-session-ring")?.getAttribute("data-activity"),
      ).toBe(sessionActivity);
      expect(host.querySelector('[aria-label="Priority: High"]')).not.toBeNull();
      expect(host.querySelector(".font-mono")?.textContent).toContain("1");
      expect(host.querySelector(".line-clamp-2")?.textContent).toBe(ticket.title);
      expect(host.textContent).not.toMatch(/working|waiting|claude/i);
      expect(host.querySelector('[data-slot="status-dot"]')).toBeNull();
    },
  );

  it("uses a compact key ring in the list instead of adding a status glyph", () => {
    const host = markup(
      renderToStaticMarkup(
        <TicketRowContent
          ticket={ticket}
          ticketPrefix="DRV"
          projectLabels={[]}
          sessionActivity="waiting"
          selected
        />,
      ),
    );
    const ring = host.querySelector('.board-session-ring[data-activity="waiting"]');
    expect(ring?.parentElement?.classList.contains("font-mono")).toBe(true);
    expect(host.textContent).not.toMatch(/working|waiting|claude/i);
    expect(host.querySelector('[aria-label="Priority: High"]')).not.toBeNull();
    expect(host.firstElementChild?.className).toContain("bg-(--accent-selected)");
  });

  it("groups facets, ordering and layout on the right, qualifying only the filtered count", () => {
    const render = (visible: number) =>
      markup(
        renderToStaticMarkup(
          <BoardHeader
            projectId="p1"
            ticketCount={visible}
            tickets={[ticket, { ...ticket, id: "t2" }]}
            filter={EMPTY_TICKET_FILTER}
          />,
        ),
      );
    const full = render(2);
    const priority = [...full.querySelectorAll("button")].find(
      (node) => node.textContent === "Priority",
    );
    expect(priority?.getAttribute("data-variant")).toBe("toolbar");
    expect(priority?.parentElement?.className).toContain("flex-wrap");
    expect(priority?.parentElement?.parentElement?.className).toContain("ml-auto");
    expect(full.querySelector('[aria-label="Board layout"]')).not.toBeNull();
    expect(full.querySelector('[aria-label="Archive"]')).not.toBeNull();
    expect(full.querySelector(".sr-only [data-slot=badge]")?.textContent).toBe("2");
    expect(render(1).textContent).toContain("1 of 2");
  });
});
