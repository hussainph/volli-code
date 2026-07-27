/**
 * Demo data for lab scratches — real `@volli/shared` domain types, not
 * loose object literals, so a model change breaks the lab at typecheck rather
 * than at "why does this card render blank".
 *
 * The content is the house demo project (voltaic / VLT-14) so scratches read
 * like the product instead of like `foo`/`bar`. Fake data that *looks* fake
 * makes designs lie to you: titles are realistic lengths, one is long enough
 * to exercise the card's two-line clamp, and labels/priorities are spread so
 * every visual branch appears without hand-tuning per scratch.
 *
 * Timestamps are a frozen constant rather than `Date.now()`, so a scratch
 * renders identically on every reload — relative-time strings stay put, and
 * screenshots of two design variants differ only where the design differs.
 */
import type { Label, Project, Ticket } from "@volli/shared";

/** Frozen clock: 2026-01-15T10:00:00Z. See module doc for why it is not `Date.now()`. */
export const NOW = 1_768_471_200_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const project: Project = {
  id: "prj-voltaic",
  name: "Voltaic",
  path: "/Users/demo/code/voltaic",
  ticketPrefix: "VLT",
  baseBranch: "main",
  setupCommand: null,
  themeOverride: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: NOW - 30 * DAY,
  updatedAt: NOW - HOUR,
};

export const labels: Label[] = [
  { id: "lbl-editor", projectId: project.id, name: "editor", color: null },
  { id: "lbl-perf", projectId: project.id, name: "perf", color: null },
  { id: "lbl-infra", projectId: project.id, name: "infra", color: null },
  { id: "lbl-bug", projectId: project.id, name: "bug", color: null },
];

/** Every field a card reads; per-ticket overrides supply only what differs. */
function ticket(
  overrides: Partial<Ticket> & Pick<Ticket, "id" | "ticketNumber" | "title">,
): Ticket {
  return {
    projectId: project.id,
    body: "",
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

export const tickets: Ticket[] = [
  ticket({
    id: "tkt-14",
    ticketNumber: 14,
    title: "Inline diff gutter drops decorations on rapid scroll",
    status: "doing",
    priority: "high",
    labels: ["editor", "bug"],
    order: 0,
    worktreePath: "/Users/demo/code/voltaic-worktrees/VLT-14",
    branch: "volli/VLT-14-inline-diff-gutter",
    baseBranch: "main",
    body: "Scrolling the changeset view faster than the decoration debounce leaves stale gutter marks behind.",
  }),
  ticket({
    id: "tkt-12",
    ticketNumber: 12,
    title: "Warm-park sessions after 10 minutes idle",
    status: "doing",
    priority: "medium",
    labels: ["perf"],
    order: 1,
  }),
  ticket({
    id: "tkt-9",
    ticketNumber: 9,
    title: "Persist the harness picker's last choice per project instead of globally",
    status: "todo",
    priority: "low",
    labels: ["infra"],
    order: 0,
  }),
  ticket({
    id: "tkt-7",
    ticketNumber: 7,
    title: "Command palette: fuzzy-match ticket titles",
    status: "todo",
    priority: "medium",
    order: 1,
  }),
];
