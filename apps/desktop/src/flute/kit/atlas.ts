/**
 * "Atlas" (ATL-): the film's invented project, for shots about how the board
 * behaves rather than what Volli shipped — the 10,000-ticket board and the
 * automation beats. Invented work, so nothing here reads as Volli's own
 * tickets; the path is not under /Users.
 */
import { DEFAULT_HARNESS_ID, type Label, type Project, type Ticket, type TicketStatus } from "@volli/shared";

const NOW = 1_790_000_000_000;

export const ATLAS: Project = {
  id: "prj-atlas",
  name: "Atlas",
  path: "/code/atlas",
  ticketPrefix: "ATL",
  baseBranch: "main",
  setupCommand: null,
  themeOverride: null,
  colorIndex: 4,
  sortOrder: 0,
  createdAt: NOW - 400 * 86_400_000,
  updatedAt: NOW,
};

export const ATLAS_LABELS: Label[] = ["api", "web", "infra", "billing", "mobile", "search"].map((name) => ({
  id: `lbl-atl-${name}`,
  projectId: ATLAS.id,
  name,
  color: null,
}));

export const ATLAS_TITLES: [string, string[]][] = [
  ["Retry failed webhook deliveries with exponential backoff", ["api"]],
  ["Cache route tiles per zoom level at the edge", ["infra", "web"]],
  ["Prorate seat changes mid-cycle on annual plans", ["billing"]],
  ["Offline queue for check-ins on flaky connections", ["mobile"]],
  ["Rank exact SKU matches above fuzzy title hits", ["search"]],
  ["Paginate the audit log export past 50k rows", ["api", "web"]],
  ["Warm the search index on deploy, not first query", ["search", "infra"]],
  ["Dunning emails respect the account's locale", ["billing"]],
  ["Map pins cluster above 200 markers", ["web"]],
  ["Rotate signing keys without dropping sessions", ["infra", "api"]],
  ["Pull-to-refresh keeps the scroll position", ["mobile"]],
  ["Invoice PDFs render right-to-left scripts", ["billing", "web"]],
  ["Rate-limit headers on every public endpoint", ["api"]],
  ["Typo tolerance for two-letter queries", ["search"]],
  ["Blue-green deploys for the worker fleet", ["infra"]],
  ["Dark mode for the onboarding checklist", ["web", "mobile"]],
  ["Idempotency keys on payment capture", ["billing", "api"]],
  ["Debounce autosave while a field is focused", ["web"]],
  ["Background sync respects low-power mode", ["mobile"]],
  ["Shard the events table by tenant", ["infra"]],
  ["Synonyms per workspace in search settings", ["search", "web"]],
  ["Refund partial line items from the admin", ["billing"]],
  ["Stream CSV imports instead of buffering", ["api", "infra"]],
  ["Haptics on successful scan", ["mobile"]],
];


/** One Atlas card: `title` indexes ATLAS_TITLES (wrapping), `number` is its ATL- number. */
export function atlasTicket(title: number, number: number, status: TicketStatus, row: number, overrides: Partial<Ticket> = {}): Ticket {
  const [name, labels] = ATLAS_TITLES[title % ATLAS_TITLES.length];
  return {
    id: `atl-${number}`,
    projectId: ATLAS.id,
    ticketNumber: number,
    title: name,
    body: "",
    status,
    priority: (["high", "medium", "low", "medium"] as const)[(row + number) % 4]!,
    labels,
    usesWorktree: true,
    preferredHarnessId: DEFAULT_HARNESS_ID,
    order: row,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: NOW - (row + 3) * 86_400_000,
    updatedAt: NOW,
    ...overrides,
  };
}
