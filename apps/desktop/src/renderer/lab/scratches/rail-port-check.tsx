/**
 * TEMPORARY verification harness for the Calm Stack port — delete after review.
 *
 * Mounts the REAL rail (`TicketRail` + the real repository card, properties
 * fold, Diffs and Files navigators) beside nothing else, stubbed hard enough
 * that all three pages render their full state rather than an error row. It
 * exists to be screenshotted against `ticket-right-sidebar`, which is the
 * design of record.
 */
import type { ChangeSetSnapshot, DirEntry, Ticket } from "@volli/shared";
import type { WorktreeChangeSetResult } from "../../../ipc/contract";

import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { TicketChangesPanel } from "@renderer/components/ticket/ticket-changes-panel";
import { TicketFilesPanel } from "@renderer/components/ticket/ticket-files-panel";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { EMPTY_CHANGE_RECENCY_STATE } from "@renderer/components/ticket/ticket-change-recency";
import { useUiStore } from "@renderer/stores/ui";

import { project, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Ticket · Calm Stack port check";
export const note = "The real rail, stubbed — screenshot target for the 1:1 comparison";
export const viewport = "window" as const;

const BASE = ticketById("tkt-14");
const TICKET: Ticket = {
  ...BASE,
  branch: "ui/right-sidebar-fixes",
  baseBranch: "main",
  worktreePath: "/Users/dev/worktrees/VC-214-right-sidebar",
  body: "Read @docs/DESIGN.md and @CONTEXT.md before starting.",
};

const CHANGE_SET: ChangeSetSnapshot = {
  baseRevision: "9f2c1ab",
  headRevision: "4d7e0b3",
  revision: "4d7e0b3-dirty",
  files: [
    {
      path: "apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx",
      status: "modified",
      insertions: 86,
      deletions: 31,
      binary: false,
    },
    {
      path: "apps/desktop/src/renderer/src/components/ticket/ticket-properties.tsx",
      status: "modified",
      insertions: 42,
      deletions: 118,
      binary: false,
    },
    {
      path: "apps/desktop/src/renderer/src/components/ui/tabs-subtle.tsx",
      status: "added",
      insertions: 124,
      deletions: 0,
      binary: false,
    },
    {
      path: "apps/desktop/src/renderer/src/components/ticket/ticket-environment-summary.tsx",
      previousPath: "apps/desktop/src/renderer/src/components/ticket/ticket-environment.tsx",
      status: "renamed",
      insertions: 29,
      deletions: 17,
      binary: false,
    },
  ],
  insertions: 281,
  deletions: 166,
  truncated: false,
  totalCount: 4,
};

const DIR: DirEntry[] = [
  { name: "components", kind: "dir" },
  { name: "ticket-rail.tsx", kind: "file" },
  { name: "ticket-properties.tsx", kind: "file" },
];

export const api = {
  ...appApi,
  worktree: {
    changeSet: (): Promise<WorktreeChangeSetResult> =>
      Promise.resolve({ ok: true, changeSet: CHANGE_SET }),
    // `WorktreeStatusResult` (apps/desktop/src/ipc/contract.ts). The names matter more
    // than they look: this stub used to answer `dirty`/`ahead`/`behind`/`branch`/
    // `hasUpstream`, none of which the type has — so `uncommitted` read back
    // `undefined`, the done-flow concluded a clean tree, and the one control this
    // scratch exists to compare was screenshotted as a disabled placeholder.
    // A stub is a claim about a contract; a stub that misnames it proves nothing.
    status: () =>
      Promise.resolve({
        ok: true,
        status: {
          uncommitted: true,
          sequencerActive: false,
          aheadOfBase: 2,
          behindBase: 0,
          unpushed: 2,
        },
      }),
    watchChangeSet: () => Promise.resolve({ ok: true }),
    unwatchChangeSet: () => Promise.resolve({ ok: true }),
    onChanged: () => () => {},
    onWatchError: () => () => {},
    branches: () => Promise.resolve({ ok: true, branches: ["main", "develop"] }),
  },
  fs: { listDirectory: () => Promise.resolve({ ok: true, entries: DIR }) },
  retention: {
    getTtlDays: () => Promise.resolve({ ok: true, days: 14 }),
    state: () => Promise.resolve({ ok: true, state: null }),
  },
};

export function seed(): void {
  seedApp();
}

const noop = (): void => {};

export default function RailPortCheck() {
  const railWidth = useUiStore((state) => state.railWidth);
  const setRailWidth = useUiStore((state) => state.setRailWidth);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div className="flex h-svh w-full overflow-hidden bg-rail p-2 text-foreground">
        <div className="flex h-full flex-1 overflow-hidden rounded-xl border border-border bg-background shadow-card">
          <main className="flex min-w-0 flex-1 flex-col items-start gap-2 p-6">
            {([240, 300, 420] as const).map((width) => (
              <button
                key={width}
                type="button"
                onClick={() => setRailWidth(width)}
                aria-pressed={railWidth === width}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              >
                {width}px
              </button>
            ))}
          </main>
          <aside
            className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground"
            style={{ width: railWidth }}
          >
            <RailResizeHandle />
            <TicketRail
              projectId={project.id}
              ticket={TICKET}
              creating={false}
              onNewSession={noop}
              onNewChat={noop}
              onActivateSession={noop}
              onActivateChat={noop}
              activeTabId="doc"
              changesContent={
                <TicketChangesPanel
                  ticket={TICKET}
                  activeTabId="doc"
                  recency={EMPTY_CHANGE_RECENCY_STATE}
                  onOpenDiff={noop}
                />
              }
              filesContent={
                <TicketFilesPanel ticket={TICKET} onPreviewFile={noop} onPinFile={noop} />
              }
            />
          </aside>
        </div>
      </div>
    </TooltipProvider>
  );
}
