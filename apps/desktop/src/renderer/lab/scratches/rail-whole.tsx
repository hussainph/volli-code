/**
 * BOTH RAILS, WHOLE — the Ticket's and Home's, as VC-406 leaves them.
 *
 * The other VC-406 scratches each study one block: `ticket-rail-automations`
 * asks whether the offer list reads as rows, `home-rail-now` asks whether the
 * Session card reads as one object, `usage-surfaces` asks whether a metered
 * total stays honest at rail width. None of them can answer the question the
 * ticket actually asks, which is about the WHOLE column: does the page read in
 * tiers, does attention land where the design claims it does, and do the two
 * scopes look like one product rather than two rails that grew separately?
 *
 * So this mounts the shipping `TicketRail` and `HomeRail` — the real
 * components, the real page chrome, the real blocks reading the real stores —
 * inside the same `aside` the app frames them with (`ticket-detail.tsx` /
 * `home-surface.tsx`: `border-l border-sidebar-border bg-sidebar`, width from
 * the ui store). Nothing here re-implements a rail. Everything below the
 * fixtures is the app.
 *
 * Read it in this order:
 *   1. The two Now pages side by side at 300px — the resting width. The
 *      Ticket's, top to bottom, in the order attention goes: what it IS
 *      (Properties, as rows), what is HAPPENING on it (Sessions, with the
 *      record folded under the eyebrow's own label — press `SESSIONS ›`), and
 *      what can be RUN on it (Automations, no button under the rows). Under
 *      the scroller, two pinned rows that fold open UPWARD without moving:
 *      what it COST, and the worktree — press the fact at the right of the
 *      branch and the repository card's body unfolds above it.
 *   2. The Ticket's Diffs pill — press it. The page is the change set alone;
 *      the worktree row stays under it, as under every page, and its body
 *      still unfolds over the files it would commit. (Both columns read one
 *      `railMode`, as the app's two rails do, so this scratch mounts one
 *      Ticket rail rather than one per page.)
 *   3. The same rails at the 240px floor, where every truncation decision
 *      shows (the width control at the top switches both columns at once).
 *
 * WHAT TO LOOK FOR ACROSS THE PAIR, since that is what only this scratch can
 * show: one eyebrow recipe, one list row, one fold, one card frame — and the
 * same reading order at both scopes, so moving between Home and a Ticket is a
 * change of subject rather than a change of language.
 *
 * The comparison that settled this shape — the first pass beside the reorder,
 * the folds, the footer disclosures, Properties four ways — lived in
 * `rail-now-compare.tsx` and left with the port; it is in this branch's
 * history (`design(lab): the Now page compared`, rounds one and two).
 *
 * The honest limits of the lab here: Files and Search are not passed (both
 * navigators need a filesystem), so those two pills are present and their
 * pages are empty. The rail's resize grip is absent for the same reason the
 * width is a control rather than a drag: the frame is the app's, the sizing is
 * the scratch's.
 */
import * as React from "react";

import {
  reportSessionUsage,
  type Automation,
  type ChangeSetSnapshot,
  type ColumnArming,
  type ModelAccessSnapshot,
  type SessionUsageEntry,
  type SessionUsageReportQuery,
  type SessionUsageScope,
  type VenueSnapshot,
} from "@volli/shared";
import { EMPTY_TRANSCRIPT, type ChatSessionSlice } from "@volli/session-presentation";

import { HomeRail } from "@renderer/components/home/home-rail";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import { TicketChangesPanel } from "@renderer/components/ticket/ticket-changes-panel";
import { EMPTY_CHANGE_RECENCY_STATE } from "@renderer/components/ticket/ticket-change-recency";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey } from "@renderer/stores/venue";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import type { ApiOverrides } from "../fake-api";
import { NOW, project, ticketById } from "../fixtures";
import { appApi, seedBoard } from "../seed";

export const title = "Both rails, whole (VC-406)";
export const note = "The shipping TicketRail and HomeRail, framed as the app frames them";
/**
 * The whole window, for the reason `scratch.ts` names: a rail is a full-height
 * column, and inside the stage's padded box its scroller would be judged at a
 * height the app never gives it — the pinned usage footer in particular only
 * means anything when the page above it is tall enough to scroll.
 */
export const viewport = "window" as const;

/** The rail's two widths, from `stores/ui.ts`. */
const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;

/** The Ticket the rail is about: Doing, two Sessions, a worktree. */
const TICKET = ticketById("tkt-14");
/** The chat in front at Home, and the one whose money the Home card reports. */
const HOME_CHAT_ID = "chat-home-1";

// ─── fixtures ───────────────────────────────────────────────────────────────

const VENUE: VenueSnapshot = {
  kind: "main-checkout",
  path: "/Users/someone/code/voltaic",
  branch: "main",
  files: { committed: 6, modified: 3, added: 1, untracked: 2 },
  diff: { added: 214, removed: 31, base: "main" },
};

/**
 * What this project can be made to run. Two records over three columns, so the
 * block has both an armed row (Doing's, marked and first) and rows that name a
 * column other than this Ticket's — which is the whole reason it is a list.
 */
const AUTOMATIONS: readonly Automation[] = [
  {
    id: "automation-implement",
    projectId: project.id,
    name: "Implement",
    instructions: "/implement\nWork the ticket through verification.",
    trigger: { kind: "columns", columns: ["doing"] },
    runtime: null,
    createdAt: NOW - 4_000,
    updatedAt: NOW - 1_000,
  },
  {
    id: "automation-review",
    projectId: project.id,
    name: "Review every boundary in this ticket's diff",
    instructions: "/code-review",
    trigger: { kind: "columns", columns: ["doing", "needs_review"] },
    runtime: null,
    createdAt: NOW - 3_000,
    updatedAt: NOW - 1_000,
  },
  {
    id: "automation-merge",
    projectId: project.id,
    name: "Merge the PR",
    instructions: "/merge",
    trigger: { kind: "columns", columns: ["done"] },
    runtime: null,
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
  },
];

const ARMINGS: readonly ColumnArming[] = [
  { projectId: project.id, status: "doing", automationId: "automation-implement", armedAt: NOW },
];

/**
 * What this Ticket's worktree holds, for the Diffs page. Committed work plus
 * uncommitted work, because the repository card's job is to say which of those
 * the button in it would act on.
 */
const CHANGE_SET: ChangeSetSnapshot = {
  baseRevision: "a1b2c3d",
  headRevision: "f4e5d6c",
  revision: "f4e5d6c-dirty",
  truncated: false,
  insertions: 214,
  deletions: 31,
  totalCount: 5,
  files: [
    {
      path: "apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx",
      status: "modified",
      insertions: 63,
      deletions: 18,
      binary: false,
    },
    {
      path: "apps/desktop/src/renderer/src/components/automations/ticket-rail-automations.tsx",
      status: "modified",
      insertions: 88,
      deletions: 11,
      binary: false,
    },
    {
      path: "apps/desktop/src/renderer/src/components/usage/usage-card.tsx",
      status: "modified",
      insertions: 34,
      deletions: 2,
      binary: false,
    },
    {
      path: "apps/desktop/src/renderer/lab/scratches/rail-whole.tsx",
      status: "added",
      insertions: 29,
      deletions: 0,
      binary: false,
    },
    {
      path: "docs/DESIGN.md",
      status: "modified",
      insertions: 0,
      deletions: 0,
      binary: false,
    },
  ],
};

/** Uncommitted work on a branch that has never been pushed — the card's busiest row. */
const WORKTREE_STATUS = {
  uncommitted: true,
  sequencerActive: false,
  aheadOfBase: 3,
  behindBase: 0,
  unpushed: 3,
};

/** The catalogue the Home card names its model against (VC-406: drawn, not spelled). */
const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: NOW,
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      state: "available",
      accountLabel: "someone@example.com",
      billingSource: "subscription",
      recovery: null,
      signIn: [],
      hasStoredCredential: true,
    },
  ],
  models: [
    {
      providerId: "anthropic",
      modelId: "claude-opus-4-1",
      label: "Claude Opus 4.1",
      state: "available",
      reasoningLevels: ["low", "medium", "high"],
      contextWindow: 200_000,
      acceptsImageInput: true,
    },
  ],
};

/** A client that answers the one question the rail asks, and refuses the rest. */
const MODEL_ACCESS: ModelAccessClient = {
  inspect: () => Promise.resolve(SNAPSHOT),
  defaults: () => Promise.reject(new Error("not in the lab")),
  setDefault: () => Promise.reject(new Error("not in the lab")),
  hiddenModels: () => Promise.resolve([]),
  setHiddenModels: () => Promise.resolve([]),
  compactionPolicy: () => Promise.reject(new Error("not in the lab")),
  setCompactionPolicy: () => Promise.reject(new Error("not in the lab")),
  pickerView: () => Promise.reject(new Error("not in the lab")),
  setPickerView: () => Promise.reject(new Error("not in the lab")),
  beginSignIn: () => Promise.reject(new Error("not in the lab")),
  signOut: () => Promise.reject(new Error("not in the lab")),
} as unknown as ModelAccessClient;

/**
 * The chat in front at Home — a projection carrying exactly what the Now page
 * reads off it: which model it is pinned to, at what effort, and whether a
 * turn is open. The transcript is the package's own empty one; this scratch
 * never draws a message.
 */
const HOME_SLICE: ChatSessionSlice = {
  projection: {
    session: {
      id: HOME_CHAT_ID,
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Rename the worktree branch scheme",
      createdAt: NOW - 40 * 60_000,
    },
    status: "open",
    signal: null,
    modelSelection: {
      providerId: "anthropic",
      modelId: "claude-opus-4-1",
      reasoningLevel: "high",
    },
    modelTier: "deep",
    turnActive: true,
    lastActivityAt: NOW - 60_000,
    bornTicketless: true,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    liveExecutor: { id: "exec-1" },
    authority: null,
  },
  transcript: EMPTY_TRANSCRIPT,
  lifecycle: "working",
  sessionError: null,
  queue: [],
};

// ─── the ledger the usage blocks read ───────────────────────────────────────

function op(over: Partial<SessionUsageEntry> = {}): SessionUsageEntry {
  return {
    sessionId: "chat-14a",
    projectId: project.id,
    ticketId: TICKET.id,
    occurredAt: NOW - 30 * 60_000,
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 4_200,
    outputTokens: 1_100,
    cacheReadTokens: 38_000,
    cacheWriteTokens: 2_400,
    costUsd: 0.062,
    costBasis: "catalog-estimate",
    ...over,
  };
}

/**
 * One ledger for every scope on screen, so the Ticket's figure is genuinely a
 * slice of the project's rather than two numbers invented to look plausible
 * beside each other. A screenshot where the part exceeds the whole is the one
 * mistake a usage fixture must not make.
 */
const LEDGER: readonly SessionUsageEntry[] = [
  // This Ticket: a chat that did the work, a terminal companion that spent
  // nothing, and a second model on the review pass.
  ...Array.from({ length: 11 }, () => op()),
  ...Array.from({ length: 4 }, () =>
    op({ sessionId: "chat-14a", modelId: "claude-sonnet-4-5", costUsd: 0.018 }),
  ),
  ...Array.from({ length: 6 }, () => op({ sessionId: "ses-14a", costUsd: 0.041 })),
  // The rest of the project, including the Home chat in front.
  ...Array.from({ length: 90 }, () =>
    op({ sessionId: "chat-other", ticketId: "tkt-12", costUsd: 0.055 }),
  ),
  ...Array.from({ length: 24 }, () =>
    op({
      sessionId: "chat-other-2",
      ticketId: "tkt-11",
      providerId: "openai",
      modelId: "gpt-5.3-codex",
      costUsd: 0.028,
    }),
  ),
  ...Array.from({ length: 9 }, () =>
    op({ sessionId: HOME_CHAT_ID, ticketId: null, costUsd: 0.047 }),
  ),
];

function inScope(entry: SessionUsageEntry, scope: SessionUsageScope): boolean {
  switch (scope.kind) {
    case "project":
      return entry.projectId === scope.projectId;
    case "ticket":
      return entry.ticketId === scope.ticketId;
    case "session":
      return entry.sessionId === scope.sessionId;
    default:
      return false;
  }
}

// ─── setup ──────────────────────────────────────────────────────────────────

export function seed(): void {
  useProjectsStore.setState({ projects: [project], selectedProjectId: project.id });
  seedBoard();
  useWorkspaceStore.setState({ byProject: {} });
  useUiStore.setState({
    railMode: "now",
    homeRailMode: "now",
    railWidth: RAIL_DEFAULT,
    railCollapsed: false,
    costVisible: true,
  });
  // Seeded as ALREADY-READ, for the reason the automations scratch spells out:
  // the rail refuses to draw a row from a cache it has not confirmed at the
  // current planning version, and a cold slice would hold this page at
  // "Reading automations…" — which is not the state this scratch is for. The
  // doors below still answer; this is the warm arrival they produce.
  useAutomationsStore.setState({
    byProject: { [project.id]: [...AUTOMATIONS] },
    armingByProject: { [project.id]: [...ARMINGS] },
    orderByProject: { [project.id]: [] },
    runsByProject: {},
    enabledIds: ["automation-implement"],
    enablementRead: true,
    railReadAt: {
      enablement: 0,
      [`list:${project.id}`]: 0,
      [`arming:${project.id}`]: 0,
      [`order:${project.id}`]: 0,
    },
    editor: null,
  });
  useChatSessionsStore.setState({ sessions: { [HOME_CHAT_ID]: HOME_SLICE } });
  useVenueStore.setState({
    byScope: { [venueKey(project.id, null)]: { status: "ready", venue: VENUE } },
  });
}

export const api: ApiOverrides = {
  ...appApi,
  automations: {
    list: () => Promise.resolve({ ok: true, automations: AUTOMATIONS }),
    armings: () => Promise.resolve({ ok: true, armings: ARMINGS }),
    enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-implement"] }),
    columnOrders: () => Promise.resolve({ ok: true, orders: [] }),
    runsForTicket: () => Promise.resolve({ ok: true, runs: [] }),
  },
  venue: {
    snapshot: () => Promise.resolve({ ok: true, reading: { state: "measured", venue: VENUE } }),
  },
  worktree: {
    status: () => Promise.resolve({ ok: true, status: WORKTREE_STATUS }),
    changeSet: () => Promise.resolve({ ok: true, changeSet: CHANGE_SET }),
    branches: () =>
      Promise.resolve({
        ok: true,
        branches: ["main", "volli/VLT-14-inline-diff-gutter"],
        current: "main",
        remotes: ["origin/main"],
        fetchedAt: NOW - 20 * 60_000,
      }),
    // The watch succeeds and then nothing ever changes, which is the truth in a
    // lab with no worktree behind it — the same ruling `seed.ts` makes for
    // `files.watchDir`. Left failing, its fault is drawn TWICE on this page:
    // "Updates paused" in the panel and "Worktree unreadable" over the card,
    // since the card shares the watch (`worktree-change-watch.ts`).
    watchChangeSet: () => Promise.resolve({ ok: true }),
    pauseChangeSet: () => Promise.resolve({ ok: true }),
    resumeChangeSet: () => Promise.resolve({ ok: true }),
    unwatchChangeSet: () => Promise.resolve({ ok: true }),
  },
  sessions: {
    ...(appApi.sessions as Record<string, unknown>),
    // The real report function over the fixture ledger, so every figure on
    // screen is one `reportSessionUsage` produced — the same call main makes.
    usageReport: (input: {
      scope: SessionUsageScope;
      sinceMs?: number;
      groupBy?: SessionUsageReportQuery["groupBy"];
    }) =>
      Promise.resolve({
        ok: true,
        report: reportSessionUsage(
          LEDGER.filter((entry) => inScope(entry, input.scope)),
          { groupBy: input.groupBy, since: input.sinceMs },
        ),
      }),
  },
};

// ─── the scratch ────────────────────────────────────────────────────────────

/** The app's own rail frame — `ticket-detail.tsx` and `home-surface.tsx` share it. */
function RailFrame({ width, children }: React.PropsWithChildren<{ width: number }>) {
  return (
    <div
      className="relative flex min-h-0 flex-1 shrink-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-sidebar"
      style={{ width }}
    >
      {children}
    </div>
  );
}

function TicketColumn({ width = RAIL_DEFAULT }: { width?: number }) {
  return (
    <RailFrame width={width}>
      <TicketRail
        projectId={project.id}
        ticket={TICKET}
        creating={false}
        onNewSession={() => {}}
        onNewChat={() => {}}
        onActivateSession={() => {}}
        onActivateChat={() => {}}
        activeTabId={chatTabId("chat-14a")}
        changesContent={
          <TicketChangesPanel
            ticket={TICKET}
            activeTabId={chatTabId("chat-14a")}
            recency={EMPTY_CHANGE_RECENCY_STATE}
            onOpenDiff={() => {}}
          />
        }
      />
    </RailFrame>
  );
}

function HomeColumn({ width = RAIL_DEFAULT }: { width?: number }) {
  return (
    <RailFrame width={width}>
      <HomeRail project={project} activeTabId={chatTabId(HOME_CHAT_ID)} />
    </RailFrame>
  );
}

/**
 * The width the rail is actually resized to, pushed into the store so the
 * blocks that read `railWidth` (the ticket rail's narrow inset) agree with the
 * frame they are drawn in.
 */
function useRailWidth(width: number): void {
  React.useEffect(() => {
    useUiStore.setState({ railWidth: width });
  }, [width]);
}

export default function BothRailsWhole() {
  const [width, setWidth] = React.useState(RAIL_DEFAULT);
  useRailWidth(width);

  return (
    <TooltipProvider>
      <ModelAccessProvider client={MODEL_ACCESS}>
        <div className="flex h-svh min-h-0 flex-col gap-4 p-6">
          <Intro width={width} onWidth={setWidth} />
          <div className="flex min-h-0 flex-1 items-stretch gap-6">
            <Labelled label="Ticket · VLT-14, Doing">
              <TicketColumn width={width} />
            </Labelled>
            <Labelled label="Home · the project scope">
              <HomeColumn width={width} />
            </Labelled>
          </div>
        </div>
      </ModelAccessProvider>
    </TooltipProvider>
  );
}

function Intro({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  return (
    <div className="flex shrink-0 flex-col gap-3">
      <p className="max-w-[70ch] text-ui text-muted-foreground">
        Both rails, whole and live — the shipping components in the app&rsquo;s own frame. The
        Ticket reads in the order attention goes: what it{" "}
        <strong className="text-foreground">is</strong>, what is{" "}
        <strong className="text-foreground">happening</strong> on it (the record folded under the
        eyebrow), what can be <strong className="text-foreground">run</strong> on it — and, pinned
        under the scroller, what it <strong className="text-foreground">cost</strong> and where its{" "}
        <strong className="text-foreground">worktree</strong> stands, each a row that folds open
        upward without moving. Home is the same language one scope up.
      </p>
      <div className="flex items-center gap-2">
        {[RAIL_DEFAULT, RAIL_FLOOR].map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => onWidth(candidate)}
            className={
              candidate === width
                ? "rounded-md bg-accent px-3 py-1 font-mono text-ui text-accent-foreground"
                : "rounded-md px-3 py-1 font-mono text-ui text-muted-foreground hover:bg-accent/40"
            }
          >
            {candidate}px
          </button>
        ))}
      </div>
    </div>
  );
}

function Labelled({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <span className="font-mono text-caption tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}
