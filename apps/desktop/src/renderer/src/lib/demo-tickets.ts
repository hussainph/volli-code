// DEMO DATA — placeholder board tickets until the SQLite ticket layer lands;
// delete with it.

import { createTicket, type Ticket } from "@volli/shared";

/** Fixed epoch so demo tickets (and their tests) are deterministic. */
const BASE_TIMESTAMP = new Date("2026-01-01T00:00:00Z").getTime();

interface DemoTicketInput {
  title: string;
  priority: Ticket["priority"];
  tags: string[];
  harnessId: string;
  body?: string;
}

/** Backlog (4), Todo (3), Doing (2), Needs Review (2), Done (0 — the rail starts collapsed). */
const DEMO_TICKETS_BY_STATUS: Record<string, DemoTicketInput[]> = {
  backlog: [
    {
      title: "Design SQLite ticket schema",
      priority: "low",
      tags: ["board", "infra"],
      harnessId: "claude-code",
    },
    {
      title: "Prototype worktree archive flow",
      priority: "medium",
      tags: ["infra"],
      harnessId: "claude-code",
    },
    {
      title: "Spike: volli CLI socket handshake",
      priority: "high",
      tags: ["agent", "infra"],
      harnessId: "codex",
    },
    {
      title: "Sketch board column drag affordance",
      priority: "low",
      tags: ["board", "design"],
      harnessId: "claude-code",
    },
  ],
  todo: [
    {
      title: "Wire native notifications for ticket moves",
      priority: "medium",
      tags: ["agent"],
      harnessId: "claude-code",
      body: "Fire a native notification when a session finishes or needs review.",
    },
    {
      title: "Harden terminal engine reconnect",
      priority: "high",
      tags: ["terminal", "bug"],
      harnessId: "claude-code",
    },
    {
      title: "Add opencode harness adapter",
      priority: "medium",
      tags: ["agent", "infra"],
      harnessId: "opencode",
    },
  ],
  doing: [
    {
      title: "Implement worktree-per-ticket boot",
      priority: "high",
      tags: ["agent", "infra"],
      harnessId: "claude-code",
      body: "Boot the coding agent in an isolated git worktree when a ticket enters Doing.",
    },
    {
      title: "Fix ghostty config Cmd+Opt+arrow nav",
      priority: "medium",
      tags: ["terminal", "bug"],
      harnessId: "claude-code",
    },
  ],
  needs_review: [
    {
      title: "Polish board card hover states",
      priority: "low",
      tags: ["board", "design"],
      harnessId: "claude-code",
      body: "Tighten spacing and hover affordances on ticket cards.",
    },
    {
      title: "Restty GPU device-loss recovery",
      priority: "high",
      tags: ["terminal", "infra"],
      harnessId: "claude-code",
    },
  ],
  done: [],
};

/** Builds the placeholder demo board for a freshly-added project. */
export function buildDemoTickets(projectId: string, ticketPrefix: string): Ticket[] {
  const tickets: Ticket[] = [];
  let ticketNumber = 1;

  for (const [status, inputs] of Object.entries(DEMO_TICKETS_BY_STATUS)) {
    inputs.forEach((input, order) => {
      tickets.push(
        createTicket({
          prefix: ticketPrefix,
          projectId,
          ticketNumber: ticketNumber++,
          title: input.title,
          status: status as Ticket["status"],
          order,
          now: BASE_TIMESTAMP,
          body: input.body,
          priority: input.priority,
          tags: input.tags,
          harnessId: input.harnessId,
        }),
      );
    });
  }

  return tickets;
}
