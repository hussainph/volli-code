/**
 * The Change Set list at rail width (VC-311): a seven-file change set whose
 * two similarly named files — `split-view-divider.test.tsx` and
 * `split-view-divider.tsx`, one directory apart — must stay distinguishable
 * while the rail is dragged to its floor, and whose rows must read whole to a
 * screen reader now that the list is a `list` rather than a `listbox`.
 *
 * The frames carry `group/rail` and `data-narrow` because that pair is how the
 * real rail tells its pages how wide they are (`ticket-rail.tsx`); a frame
 * without the group is a frame where the narrow treatment silently never runs.
 *
 * Read it in this order:
 *   1. Full width (300px) — every row whole, the audit pair distinguishable by
 *      the ends of both of its lines.
 *   2. The 240px floor — lines ellipsize at the START; extensions and the
 *      deepest directory survive. Hover or keyboard-focus a clipped row for
 *      the full-path reveal; a row that fits stays quiet.
 *   3. Keyboard only, which is the pass this scratch exists for: Tab to a row,
 *      Enter to open the diff below, Escape (or the Close button) to close it,
 *      and check that the focus ring never leaves the row it was on.
 *   4. The accessibility tree (DevTools → Accessibility, or VoiceOver):
 *      every row is one button whose name carries status, full path and
 *      counts; Copy/Open are buttons inside the list item, not flattened
 *      options; the open row — and only it — is "current".
 */
import * as React from "react";
import type { ChangeSetFile } from "@volli/shared";

import {
  TicketChangesList,
  toChangeListRow,
} from "@renderer/components/ticket/ticket-changes-panel";
import { diffTabId } from "@renderer/components/ticket/ticket-diff-tab";
import { Button } from "@renderer/components/ui/button";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { EMPTY_CHANGE_RECENCY_STATE } from "@renderer/components/ticket/ticket-change-recency";

export const title = "Diffs · change rows at rail width (VC-311)";
export const note =
  "Start-truncated rows a screen reader reads whole — the audit's seven-file change set";

const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return { status: "modified", insertions: 1, deletions: 0, binary: false, ...overrides };
}

/** The audit's change set: seven files, two of them the confusable pair. */
const CHANGE_SET: readonly ChangeSetFile[] = [
  file({
    path: "apps/desktop/src/renderer/src/components/split/split-view-divider.test.tsx",
    insertions: 11,
    deletions: 2,
  }),
  file({
    path: "apps/desktop/src/renderer/src/components/ui/split-view-divider.tsx",
    insertions: 34,
    deletions: 12,
  }),
  file({
    path: "apps/desktop/src/renderer/src/components/ticket/rail-panel-parts.tsx",
    status: "added",
    insertions: 96,
    deletions: 0,
  }),
  file({
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-changes-model.ts",
    previousPath: "apps/desktop/src/renderer/src/components/ticket/changes-model.ts",
    status: "renamed",
    insertions: 8,
    deletions: 4,
  }),
  file({
    path: "apps/desktop/src/renderer/lab/fixtures.ts",
    status: "untracked",
    insertions: 3,
    deletions: 0,
  }),
  file({ path: "assets/volli-mark.png", status: "added", binary: true }),
  file({ path: "README.md", status: "modified", insertions: 2, deletions: 2 }),
];

function RailFrame({
  width,
  activeTabId,
  onSelect,
  label,
}: {
  width: number;
  /** The surface's active tab, exactly as the panel receives it. */
  activeTabId: string;
  onSelect(path: string): void;
  label: string;
}) {
  const rows = React.useMemo(
    () => CHANGE_SET.map((f) => toChangeListRow(f, EMPTY_CHANGE_RECENCY_STATE)),
    [],
  );
  const narrow = width <= RAIL_FLOOR;
  return (
    <figure className="flex w-full max-w-80 flex-1 flex-col gap-2">
      <figcaption className="text-label text-muted-foreground">
        {label} · {width}px
      </figcaption>
      {/* The rail's own contract: the flag travels as a group attribute on the
          column, and every page reads it through `RAIL_PANEL_INSET`. */}
      <div
        className="group/rail flex flex-1 flex-col overflow-hidden rounded-xl border bg-background"
        data-narrow={narrow ? "true" : "false"}
        style={{ width }}
      >
        <div className="flex-1 overflow-hidden pt-2">
          <TicketChangesList
            rows={rows}
            currentPath={parseOpenPath(activeTabId)}
            onSelectRow={onSelect}
          />
        </div>
      </div>
    </figure>
  );
}

/** The panel derives its current row from the tab id; so does this. */
function parseOpenPath(activeTabId: string): string | null {
  return activeTabId.startsWith("diff:") ? activeTabId.slice("diff:".length) : null;
}

export default function ChangeRowsScratch() {
  const [activeTabId, setActiveTabId] = React.useState("doc");
  const openPath = parseOpenPath(activeTabId);
  const onSelect = React.useCallback((path: string) => setActiveTabId(diffTabId(path)), []);
  const close = React.useCallback(() => setActiveTabId("doc"), []);

  return (
    <TooltipProvider>
      <div
        className="flex flex-col gap-6"
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        <div className="flex flex-wrap items-start gap-6">
          <RailFrame
            width={RAIL_DEFAULT}
            activeTabId={activeTabId}
            onSelect={onSelect}
            label="Default"
          />
          <RailFrame
            width={RAIL_FLOOR}
            activeTabId={activeTabId}
            onSelect={onSelect}
            label="Floor"
          />
        </div>
        {/* Stands in for the Diff tab, so the keyboard pass has something real
            to open and close. Closing must leave the ring on the row. */}
        <div className="flex min-h-16 items-center gap-3 rounded-xl border bg-card px-4 py-3">
          {openPath === null ? (
            <p className="text-ui text-muted-foreground">
              No diff open — Tab to a row and press Enter.
            </p>
          ) : (
            <>
              <p className="min-w-0 flex-1 truncate font-mono text-ui">{openPath}</p>
              <Button size="sm" variant="ghost" onClick={close}>
                Close diff
              </Button>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
