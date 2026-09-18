import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { TicketTitle } from "./ticket-title";

vi.mock("@renderer/stores/board", () => ({
  useBoardStore: () => vi.fn(),
}));

const ticket: Ticket = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "Keyboard focus",
  body: "",
  status: "todo",
  priority: "medium",
  labels: [],
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

describe("TicketTitle", () => {
  it("keeps a visible semantic-token focus ring on the keyboard trigger", () => {
    const html = renderToStaticMarkup(<TicketTitle ticket={ticket} />);

    expect(html).toContain('role="button"');
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-ring/45");
    expect(html).toContain("focus-visible:outline-none");
  });
});
