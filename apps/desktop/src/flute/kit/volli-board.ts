/**
 * The release film's board fixture (VC-464): Volli's own project, holding the
 * 175 Done tickets that shipped in 0.2 (see release-tickets.ts). "The board
 * that built it" — every card on the wall is a real ticket, titled with text
 * commit history already published.
 *
 * Labels are fixture colour, sorted by the words in a title; nothing on a card
 * claims more than its title does. The project path is deliberately not under
 * /Users: nothing in frame may name a home directory.
 */
import { DEFAULT_HARNESS_ID, type Label, type Project, type Ticket, type TicketStatus } from "@volli/shared";

import { RELEASE_TICKETS } from "./release-tickets";

const NOW = 1_790_000_000_000;

export const VOLLI: Project = {
  id: "prj-volli-code",
  name: "Volli Code",
  path: "/code/volli-code",
  ticketPrefix: "VC",
  baseBranch: "main",
  setupCommand: null,
  themeOverride: null,
  colorIndex: 2,
  sortOrder: 0,
  createdAt: NOW - 90 * 86_400_000,
  updatedAt: NOW,
};

const LABEL_NAMES = ["automations", "browser", "chat", "perf", "models", "workspace", "release"];

export const VOLLI_LABELS: Label[] = LABEL_NAMES.map((name) => ({
  id: `lbl-${name}`,
  projectId: VOLLI.id,
  name,
  color: null,
}));

const RULES: [string, RegExp][] = [
  ["automations", /automation|armed|arming|schedule|trigger|run\b|kickoff|countdown/i],
  ["browser", /browser|cursor|tab\b|tabs\b/i],
  ["chat", /chat|island|subagent|composer|transcript|compaction|plan\/todo|session/i],
  ["perf", /perf|bound|window|cache|fold|jank|chug|fast|block|freeze|lag/i],
  ["models", /model|pi\b|fable|limit|usage|opencode/i],
  ["workspace", /split|cmd\+k|⌘k|rail|sidebar|quick open|search|label/i],
  ["release", /licen|notice|compliance|docs|release|provenance/i],
];

function labelsFor(title: string): string[] {
  const found = RULES.filter(([, rule]) => rule.test(title)).map(([name]) => name);
  return found.slice(0, 2);
}

const PRIORITIES = ["high", "medium", "low", "medium"] as const;

export function releaseTicket(
  number: number,
  overrides: Partial<Ticket> = {},
): Ticket {
  const source = RELEASE_TICKETS.find((ticket) => ticket.number === number);
  return {
    id: `vc-${number}`,
    projectId: VOLLI.id,
    ticketNumber: number,
    title: source?.title ?? `VC-${number}`,
    body: "",
    status: "done" as TicketStatus,
    priority: PRIORITIES[number % PRIORITIES.length]!,
    labels: labelsFor(source?.title ?? ""),
    usesWorktree: true,
    preferredHarnessId: DEFAULT_HARNESS_ID,
    order: number,
    worktreePath: null,
    // No branch: a card with a branch asks the bridge for its retention state,
    // and a wall of 175 of those is 175 reads for a badge nobody needs here.
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: NOW - 30 * 86_400_000,
    updatedAt: NOW,
    ...overrides,
  };
}

/** All 175, in the order their work first landed. */
export const RELEASE_BOARD: Ticket[] = RELEASE_TICKETS.map((ticket) => releaseTicket(ticket.number));
