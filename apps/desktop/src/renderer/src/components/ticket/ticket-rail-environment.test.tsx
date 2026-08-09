import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { TicketRail } from "./ticket-rail";

const ticket: Ticket = {
  id: "ticket-6",
  projectId: "project-1",
  ticketNumber: 6,
  title: "Inspector",
  body: "Read @docs/plan.md.",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: "/worktrees/VC-6-inspector",
  branch: "volli/VC-6-inspector",
  baseBranch: "main",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

const noop = (): void => {};

describe("TicketRail", () => {
  it("keeps the Environment/Sources inspector pinned above the selected rail navigator", () => {
    const html = renderToStaticMarkup(
      <TicketRail
        projectId="project-1"
        ticket={ticket}
        creating={false}
        onNewSession={noop}
        onNewChat={noop}
        onActivateSession={noop}
        onActivateChat={noop}
        activeTabId="doc"
        onOpenSource={noop}
      />,
    );

    expect(html).toContain('data-testid="ticket-environment-inspector"');
    expect(html).toContain("Environment");
    expect(html).toContain("Sources");
    expect(html).toContain("Loading changes…");
  });
});
