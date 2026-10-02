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
 *   3. The Ticket's Files pill — the directory leads, with New File,
 *      attachments and filter icons alongside, over one-line rows. The
 *      paperclip opens attachment management without a permanent pill strip.
 *      Walk into `apps/`: the paperclip still belongs to the Ticket, not the
 *      folder. Home uses the same header without the attachment menu.
 *   4. Search, at both scopes — type `rail` (five lines across two files, so the
 *      per-file grouping and the count at the right of each heading are both
 *      doing something), then `zzz` (“No matches”, said only because a read
 *      landed). Switch pages and come back: the words are still there,
 *      remembered per checkout, as the Files navigator's folder and filter are.
 *   5. Home's own footer: the Main checkout under EVERY Home page (VC-406) —
 *      switch Home to Files or Search and the branch row stays, which is the
 *      whole reason it stopped being the bottom half of a card on Now. Press
 *      the fact at its right and the reading unfolds upward.
 *   6. The same rails at 240 / 300 / 360 — the floor, the resting width, and a
 *      width someone has dragged out to. The control at the top switches both
 *      columns at once; 240 is at or under the narrow step (270) that BOTH
 *      rails now read from `RAIL_NARROW_MAX_WIDTH`, so it is where every
 *      truncation decision and the tighter 12px gutter show — on Home too,
 *      which spent one revision pinned to the roomy inset.
 *   7. Both of the above in light AND dark, through the LAB'S OWN appearance
 *      control (the floating theme toolbar, top right — `theme-toolbar.tsx`
 *      over the production theme store). This scratch deliberately adds no
 *      second theme switch: the toolbar already drives the real Canvas +
 *      Appearance pipeline, which is the thing worth judging a rail against.
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
 * ALL FOUR NAVIGATOR PAGES MOUNT FOR REAL, over a fixture filesystem. This
 * scratch used to pass the Ticket rail no `filesContent` / `searchContent` at
 * all, on the grounds that a lab has no filesystem to mount one against — and
 * the cost was that the two pages the revision CHANGED most (the Files
 * header's navigation, the Search page's read states) could not be looked at
 * on the one page that shows both rails together. A navigator does not need a
 * filesystem; it needs answers to `fs.listDirectory`, `files.search` and
 * `attachments.list`, and those are fixtures like every other fixture here.
 * The components are the shipping ones (`TicketFilesPanel`, `FileSearchPanel`,
 * and Home's own two, which `HomeRail` builds itself) reading the same bridge
 * the app reads.
 *
 * THE HONEST LIMITS OF THE LAB HERE:
 *
 *  • The tree below is INVENTED — a few folders, a few files, one small corpus
 *    of source lines for Search to match against. It is shaped to exercise the
 *    chrome (a folder to walk into, a filter that can miss, an attachment run,
 *    a body reference, a result with more than one match in a file), not to
 *    resemble this repository.
 *  • Opening a file opens nothing. There is no editor behind this page and no
 *    Electron to hand a path to, so preview (click) and pin (double-click) are
 *    recorded in the scratch's own state and printed above the columns, where
 *    you can see WHICH gesture the row took. The same goes for the row menus'
 *    Reveal/Open-in items, which resolve to the fake bridge's refusal.
 *  • The create/rename/duplicate/delete verbs refuse in one sentence that says
 *    it is the lab refusing. They are wired, so the menus and the draft row are
 *    real; nothing is written, because there is nowhere to write it.
 *  • The rail's resize grip is absent for the same reason the width is a
 *    control rather than a drag: the frame is the app's, the sizing is the
 *    scratch's.
 */
import * as React from "react";

import {
  reportSessionUsage,
  type Automation,
  type BlobLinkView,
  type ChangeSetSnapshot,
  type ColumnArming,
  type DirEntry,
  type ModelAccessSnapshot,
  type SessionUsageEntry,
  type SessionUsageReportQuery,
  type SessionUsageScope,
  type Ticket,
  type VenueSnapshot,
} from "@volli/shared";
import { EMPTY_TRANSCRIPT, type ChatSessionSlice } from "@volli/session-presentation";

import { FileSearchPanel } from "@renderer/components/files/search-panel";
import { HomeRail } from "@renderer/components/home/home-rail";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import { TicketChangesPanel } from "@renderer/components/ticket/ticket-changes-panel";
import { TicketFilesPanel } from "@renderer/components/ticket/ticket-files-panel";
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

import type {
  FileSearchFile,
  FileSearchInput,
  FileSearchResult,
  ListDirectoryResult,
  Result,
} from "../../../ipc/contract";

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

/**
 * The three widths worth judging, from `stores/ui.ts`: the `RAIL_MIN_WIDTH`
 * floor, the default, and a dragged-out width. 240 is the only one below the
 * Ticket rail's narrow step (`(240 + 300) / 2` = 270), so it is the one where
 * the tighter gutter and every truncation decision are on screen.
 */
const RAIL_WIDTHS = [240, 300, 360] as const;
const RAIL_DEFAULT = 300;

/**
 * The Ticket the rail is about: Doing, two Sessions, a worktree — and, for the
 * Files page, a BODY that points at two paths. The `@ref` rows are the group a
 * ticket navigator has and Home's does not, so a body with none of them would
 * leave half of that page undrawn. The override is made here rather than in
 * `fixtures.ts` because it is this scratch's question: the shared fixture is
 * read by the board and sidebar scratches, which are not about file references.
 */
const TICKET: Ticket = {
  ...ticketById("tkt-14"),
  body: [
    "Scrolling the changeset view faster than the decoration debounce leaves stale",
    "gutter marks behind. The debounce is in",
    "@apps/desktop/src/renderer/src/editor/diff-decorations.ts and the rail's own",
    "page is @docs/DESIGN.md.",
  ].join("\n"),
};
/**
 * The chat in front at Home — one of `fixtures.ts`'s own ticketless project
 * Sessions rather than an id invented here, so the Session on the tab, the row
 * in the Board-session roster and the Session the usage footer prices are ONE
 * Session. A front chat missing from the roster beside it is the one
 * incoherence this page cannot afford, since the roster is what Now is for.
 */
const HOME_CHAT_ID = "chat-scratch-a";

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

// ─── the fixture filesystem ─────────────────────────────────────────────────

/**
 * One repository, as a flat list of the files in it.
 *
 * FLAT, and turned into directory listings by {@link directoryListing} below,
 * because a navigator reads one level at a time and a hand-written map of
 * levels is a map whose parents and children drift apart the moment a path is
 * added. Deliberately small: the page has to show a folder worth walking into,
 * a filter that can miss, and a listing at the 240px floor — not a repository.
 *
 * Both checkouts answer with the same tree, which is what a worktree IS: the
 * same repository at a second working copy. The Ticket rail lists it under the
 * worktree path, Home under the Main checkout, and the paths on the two pages
 * agreeing is the point rather than a shortcut.
 *
 * It also holds every path {@link CHANGE_SET} names, so the file a row on Diffs
 * says was modified is a file the Files page can be walked to — one repository
 * across the rail's pages, rather than three fixtures that disagree about what
 * is in it.
 */
const REPOSITORY_FILES: readonly string[] = [
  "README.md",
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/src/renderer/lab/scratches/rail-whole.tsx",
  "apps/desktop/src/renderer/src/components/automations/ticket-rail-automations.tsx",
  "apps/desktop/src/renderer/src/components/files/search-panel.tsx",
  "apps/desktop/src/renderer/src/components/usage/usage-card.tsx",
  "apps/desktop/src/renderer/src/components/ticket/ticket-files-panel.tsx",
  "apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx",
  "apps/desktop/src/renderer/src/editor/diff-decorations.ts",
  "docs/DESIGN.md",
  "docs/licensing/notice-inputs.md",
  "packages/shared/src/tickets.ts",
];

/** The two roots this lab filesystem answers for, longest first so a nested one wins. */
const FIXTURE_ROOTS: readonly string[] = [TICKET.worktreePath ?? "", project.path].filter(
  (root) => root !== "",
);

/**
 * One directory level, derived from {@link REPOSITORY_FILES} — directories
 * first, then files, each group by name, which is the order main's own listing
 * returns (`sortDirEntries`).
 *
 * `null` for a path no fixture file lives under, so the navigator's REAL
 * failure path is reachable here: walk somewhere that does not exist and the
 * page draws the refusal and its retry rather than an empty folder.
 */
function directoryListing(relDir: string): DirEntry[] | null {
  const prefix = relDir === "" ? "" : `${relDir}/`;
  const names = new Map<string, DirEntry>();
  for (const path of REPOSITORY_FILES) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    names.set(name, { name, kind: slash === -1 ? "file" : "dir" });
  }
  if (names.size === 0) return null;
  return [...names.values()].toSorted((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
}

/** An absolute path, resolved back to the checkout-relative folder it names. */
function relativeToRoot(absPath: string): string | null {
  const path = absPath.endsWith("/") ? absPath.slice(0, -1) : absPath;
  for (const root of FIXTURE_ROOTS) {
    if (path === root) return "";
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  }
  return null;
}

/**
 * The source the Search page matches against — three files with real lines in
 * them, so a result is a place (a line number, a quoted line, a match inside
 * it) rather than a shape. `rail` spans two of them (five lines), `decoration`
 * hits four lines of one, and `zzz` hits nothing — which is the state the
 * page's "No matches" is for.
 */
const SEARCH_CORPUS: Record<string, readonly string[]> = {
  "apps/desktop/src/renderer/src/editor/diff-decorations.ts": [
    "const DECORATION_DEBOUNCE_MS = 16;",
    "",
    "export function applyDiffDecorations(editor: Editor, ranges: readonly Range[]): void {",
    "  // Stale decoration marks survive a scroll faster than the debounce.",
    "  editor.deltaDecorations(previous, ranges.map(toDecoration));",
    "}",
  ],
  "apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx": [
    "export function TicketRail({ projectId, ticket }: TicketRailProps) {",
    "  const narrow = useUiStore((state) => state.railWidth <= RAIL_NARROW_MAX_WIDTH);",
    '  return <div className="group/rail" data-narrow={narrow}>{/* pages */}</div>;',
    "}",
  ],
  "docs/DESIGN.md": [
    "## The ticket rail (VC-406)",
    "",
    "The rail is the Ticket's hub, and its scope is the line that decides what goes on it.",
    "Four pages in one pill: Now, Diffs, Files, Search.",
  ],
};

/**
 * The fixture search: a case-insensitive substring scan of {@link
 * SEARCH_CORPUS}, in the shape `volli:search` returns.
 *
 * Substring rather than a regex engine on purpose — what this page is for is
 * the RESULT's drawing (the file heading, the line column, the highlight inside
 * the quoted line, the summary sentence), and ripgrep's grammar is not
 * something a lab can honestly stand in for.
 */
function searchFixture(query: string): { files: FileSearchFile[]; matches: number } {
  const needle = query.toLowerCase();
  const files: FileSearchFile[] = [];
  let matches = 0;
  for (const [relPath, lines] of Object.entries(SEARCH_CORPUS)) {
    const hits = lines.flatMap((text, index) => {
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) return [];
      return [
        {
          line: index + 1,
          column: at + 1,
          preview: text,
          start: at,
          end: at + query.length,
        },
      ];
    });
    if (hits.length === 0) continue;
    matches += hits.length;
    files.push({ relPath, matches: hits });
  }
  return { files, matches };
}

/**
 * What is attached to this Ticket (VC-50). Two, because one chip cannot show
 * that the run wraps and stays inside the header's own group, and because the
 * navigator turns each of them into a referenced row beside the Body's `@refs`
 * — which is the group the Ticket page has and Home's does not.
 */
const ATTACHMENTS: readonly BlobLinkView[] = [
  {
    linkId: "blob-link-1",
    blobHash: "3f0a9c1e",
    label: "gutter-scroll.png",
    originalName: "gutter-scroll.png",
    mime: "image/png",
    sizeBytes: 148_221,
  },
  {
    linkId: "blob-link-2",
    blobHash: "7b21d4aa",
    label: "repro-steps.md",
    originalName: "repro-steps.md",
    mime: "text/markdown",
    sizeBytes: 2_140,
  },
];

/** Uncommitted work on a branch that has never been pushed — the card's busiest row. */
const WORKTREE_STATUS = {
  uncommitted: true,
  sequencerActive: false,
  aheadOfBase: 3,
  behindBase: 0,
  unpushed: 3,
};

/**
 * The catalogue the rails name their models against (VC-406: drawn, not
 * spelled).
 *
 * EVERY MODEL THE LEDGER BELOW SPENT ON is listed, because the usage footers'
 * model rows resolve against exactly this: a fixture that held only one of them
 * would show a real name on one row and a wire id on the next, which is the one
 * thing on this page nobody is reviewing.
 */
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
    {
      id: "openai",
      label: "OpenAI",
      state: "available",
      accountLabel: "someone@example.com",
      billingSource: "api-key",
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
    {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      state: "available",
      reasoningLevels: ["low", "medium", "high"],
      contextWindow: 200_000,
      acceptsImageInput: true,
    },
    {
      providerId: "openai",
      modelId: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      state: "available",
      reasoningLevels: ["low", "medium", "high"],
      contextWindow: 400_000,
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
  codeModePolicy: () => Promise.reject(new Error("not in the lab")),
  setCodeModePolicy: () => Promise.reject(new Error("not in the lab")),
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
    scheduledResume: null,
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
    // Every fold rests closed in the app, and this page is partly about what
    // the closed state says — so it is seeded closed rather than inheriting
    // whatever the previous scratch left in the persisted preference.
    railFolds: { sessionsRecord: false, worktree: false, usage: false },
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

/**
 * One refusal for every verb that would WRITE, in a sentence that says who is
 * refusing. The fake bridge's own default says "not stubbed", which reads as a
 * hole in this scratch rather than as the truth — the menus and the draft row
 * are wired, and there is simply nowhere for the bytes to land.
 */
function labCannotWrite(): Promise<Result> {
  return Promise.resolve({
    ok: false,
    error: "The UI lab has no filesystem — nothing was written.",
  });
}

export const api: ApiOverrides = {
  ...appApi,
  attachments: {
    list: () => Promise.resolve({ ok: true, blobs: [...ATTACHMENTS] }),
  },
  fs: {
    // The navigators' one read. A path outside the two fixture checkouts, or a
    // folder no fixture file lives under, fails the way main fails it — which
    // is how the page's fault state is reachable here at all.
    listDirectory: (absPath: string): Promise<ListDirectoryResult> => {
      const relDir = relativeToRoot(absPath);
      const entries = relDir === null ? null : directoryListing(relDir);
      return Promise.resolve(
        entries === null
          ? { ok: false, error: `No such directory in this lab's fixture checkout: ${absPath}` }
          : { ok: true, entries },
      );
    },
  },
  files: {
    ...(appApi.files as Record<string, unknown>),
    // Both scopes search the one corpus, for the reason both list the one tree:
    // a worktree is the same repository at a second working copy.
    search: (input: FileSearchInput): Promise<FileSearchResult> => {
      const query = input.query.trim();
      const { files, matches } = query === "" ? { files: [], matches: 0 } : searchFixture(query);
      return Promise.resolve({ ok: true, files, matches, limit: "none" });
    },
    create: labCannotWrite,
    createDirectory: labCannotWrite,
    rename: labCannotWrite,
    duplicate: labCannotWrite,
    delete: labCannotWrite,
  },
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

/** What a file gesture in the lab did, since it cannot do the real thing. */
interface LabOpen {
  gesture: "preview" | "pin";
  relPath: string;
}

function TicketColumn({
  width = RAIL_DEFAULT,
  onOpen,
}: {
  width?: number;
  onOpen(open: LabOpen): void;
}) {
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
        // The app passes these from `ticket-detail.tsx`, where they open a File
        // tab in the main strip. There is no strip here, so the gesture is
        // recorded above the columns instead — which also makes the
        // preview/pin distinction (click vs double-click) visible, and it is
        // not visible anywhere else in the lab.
        filesContent={
          <TicketFilesPanel
            ticket={TICKET}
            onPreviewFile={(relPath) => onOpen({ gesture: "preview", relPath })}
            onPinFile={(relPath) => onOpen({ gesture: "pin", relPath })}
            onOpenCreatedFile={(relPath) => onOpen({ gesture: "pin", relPath })}
            onRenameFile={() => {}}
          />
        }
        searchContent={
          <FileSearchPanel
            scope={{ kind: "ticket", projectId: project.id, ticketId: TICKET.id }}
            // The branch, which is what the Ticket navigator calls this
            // checkout on its own header — one rail, one name for one tree.
            root={TICKET.branch ?? TICKET.baseBranch ?? "No branch yet"}
            onOpenMatch={(relPath) => onOpen({ gesture: "preview", relPath })}
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
  const [opened, setOpened] = React.useState<LabOpen | null>(null);
  useRailWidth(width);

  return (
    <TooltipProvider>
      <ModelAccessProvider client={MODEL_ACCESS}>
        <div className="flex h-svh min-h-0 flex-col gap-4 p-6">
          <Intro width={width} onWidth={setWidth} opened={opened} />
          <div className="flex min-h-0 flex-1 items-stretch gap-6">
            <Labelled label="Ticket · VLT-14, Doing">
              <TicketColumn width={width} onOpen={setOpened} />
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

function Intro({
  width,
  onWidth,
  opened,
}: {
  width: number;
  onWidth: (width: number) => void;
  opened: LabOpen | null;
}) {
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
      <p className="max-w-[70ch] text-ui text-muted-foreground">
        Files and Search are live on both rails, over a fixture tree — walk into{" "}
        <code className="font-mono">apps/</code>, filter the listing, or search{" "}
        <code className="font-mono">rail</code>. Nothing opens: there is no editor and no filesystem
        behind this page, so a click is recorded here instead.
      </p>
      <div className="flex items-center gap-2">
        <span
          data-testid="rail-whole-opened"
          className="font-mono text-caption text-muted-foreground"
        >
          {opened === null
            ? "no file gesture yet"
            : `${opened.gesture === "pin" ? "pinned" : "previewed"} · ${opened.relPath}`}
        </span>
        <span aria-hidden className="text-caption text-muted-foreground/60">
          ·
        </span>
        {RAIL_WIDTHS.map((candidate) => (
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
