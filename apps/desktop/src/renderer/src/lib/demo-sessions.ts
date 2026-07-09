// DEMO DATA — placeholder active-session rows until the ticket/session layer
// lands; delete with it.

export interface DemoSession {
  ticketNumber: number;
  title: string;
  status: "running" | "needs-review";
}

export const DEMO_SESSIONS: DemoSession[] = [
  { ticketNumber: 42, title: "Add streaming data adapter", status: "running" },
  { ticketNumber: 37, title: "Fix flaky worktree cleanup", status: "needs-review" },
  { ticketNumber: 51, title: "Migrate settings persistence", status: "running" },
];
