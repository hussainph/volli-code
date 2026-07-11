/**
 * The ticket domain model: a ticket is a board card and, once it moves to
 * Doing, a terminal workspace. Mirrors the Swift reference model
 * (`../volli-swift`) but omits status entry-automation flags
 * (`launchesAgentOnEntry` and friends) until the automation layer lands.
 */

/** Fixed board columns, left to right. */
export const TICKET_STATUSES = ["backlog", "todo", "doing", "needs_review", "done"] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Human-readable label for each {@link TicketStatus}. */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "Doing",
  needs_review: "Needs Review",
  done: "Done",
};

export const TICKET_PRIORITIES = ["low", "medium", "high"] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Human-readable label for each {@link TicketPriority}. */
export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** First-class agent-harness adapters. Custom harnesses arrive later as plain strings. */
export const HARNESS_IDS = ["claude-code", "codex", "opencode"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/** Human-readable label for each first-class {@link HarnessId}. */
export const HARNESS_LABELS: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "Opencode",
};

export const DEFAULT_HARNESS_ID: HarnessId = "claude-code";

/** A board card and, once it reaches Doing, a terminal workspace. */
export interface Ticket {
  /** `<PREFIX>-<n>`, e.g. `"VC-12"`. */
  id: string;
  projectId: string;
  ticketNumber: number;
  title: string;
  /** Markdown; becomes the agent prompt later. */
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  tags: string[];
  /** Whether this ticket boots its agent in an isolated git worktree. Default `true`. */
  usesWorktree: boolean;
  /**
   * The agent harness to launch. A plain string rather than {@link HarnessId}
   * so custom, non-first-class harnesses can be stored once that lands.
   */
  harnessId: string;
  /** Position within its status column. */
  order: number;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** Builds a ticket id from a project's ticket prefix and a ticket number. */
export function ticketId(prefix: string, ticketNumber: number): string {
  return `${prefix}-${ticketNumber}`;
}

export interface CreateTicketInput {
  prefix: string;
  projectId: string;
  ticketNumber: number;
  title: string;
  status: TicketStatus;
  /** Position within its status column. */
  order: number;
  /** Epoch milliseconds, stamped onto both `createdAt` and `updatedAt`. */
  now: number;
  /** Defaults to `""`. */
  body?: string;
  /** Defaults to `"medium"`. */
  priority?: TicketPriority;
  /** Defaults to `[]`. */
  tags?: string[];
  /** Defaults to `true`. */
  usesWorktree?: boolean;
  /** Defaults to {@link DEFAULT_HARNESS_ID}. */
  harnessId?: string;
}

/** Creates a {@link Ticket}. Pure and deterministic — the caller supplies `now`. */
export function createTicket(input: CreateTicketInput): Ticket {
  return {
    id: ticketId(input.prefix, input.ticketNumber),
    projectId: input.projectId,
    ticketNumber: input.ticketNumber,
    title: input.title,
    body: input.body ?? "",
    status: input.status,
    priority: input.priority ?? "medium",
    tags: input.tags ?? [],
    usesWorktree: input.usesWorktree ?? true,
    harnessId: input.harnessId ?? DEFAULT_HARNESS_ID,
    order: input.order,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
