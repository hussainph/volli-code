import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TICKET_PRIORITIES, TICKET_STATUSES, type Ticket } from "@volli/shared";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";

const ticket: Ticket = {
  id: "ticket-1",
  projectId: "project-1",
  ticketNumber: 1,
  title: "Example",
  body: "",
  status: TICKET_STATUSES[1],
  priority: TICKET_PRIORITIES[1],
  labels: ["Bug", "Docs"],
  usesWorktree: false,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("TicketProperties", () => {
  it("renders Properties as three value-first roster rows", () => {
    const html = renderToStaticMarkup(<TicketProperties projectId="project-1" ticket={ticket} />);
    expect(html).toContain("Properties");
    expect(html).toContain('data-testid="ticket-rail-properties"');
    expect(html).toContain(RAIL_PANEL_INSET);
    expect(html).toContain(`aria-label="Status: ${ticket.status === "todo" ? "Todo" : "Backlog"}"`);
    expect(html).toContain(
      `aria-label="Priority: ${ticket.priority === "medium" ? "Medium" : "Low"}"`,
    );
    expect(html).toContain("Status</span>");
    expect(html).toContain("Priority</span>");
    expect(html).toContain("Labels</span>");
    expect(html).toContain("Bug");
    expect(html).toContain("Docs");
  });

  it("shows No labels for an empty label set", () => {
    const html = renderToStaticMarkup(
      <TicketProperties projectId="project-1" ticket={{ ...ticket, labels: [] }} />,
    );
    expect(html).toContain("No labels");
  });
});
