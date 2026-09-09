/**
 * The Change Set list at rail width (VC-311): a seven-file change set whose
 * two similarly named files — `split-view-divider.test.tsx` and
 * `split-view-divider.tsx`, one directory apart — must stay distinguishable
 * while the rail is dragged to its floor, and whose rows must read whole to a
 * screen reader now that the list is a `list` rather than a `listbox`.
 *
 * Read it in this order:
 *   1. Full width (300px) — every row whole, the audit pair distinguishable by
 *      suffix alone.
 *   2. The 240px floor — heads ellipsize in the middle; the suffixes and the
 *      last path segments survive. Hover or keyboard-focus a clipped row for
 *      the full-path reveal.
 *   3. The accessibility tree (DevTools → Accessibility, or VoiceOver):
 *      every row is one button whose name carries status, full path and
 *      counts; Copy/Open are buttons inside the list item, not flattened
 *      options.
 */
import * as React from "react";
import type { ChangeSetFile } from "@volli/shared";

import {
  TicketChangesList,
  toChangeListRow,
} from "@renderer/components/ticket/ticket-changes-panel";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { EMPTY_CHANGE_RECENCY_STATE } from "@renderer/components/ticket/ticket-change-recency";

export const title = "Diffs · change rows at rail width (VC-311)";
export const note =
  "Middle-truncated rows that a screen reader reads whole — the audit's seven-file change set";

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
  focusPath,
  onSelect,
  label,
}: {
  width: number;
  focusPath: string | null;
  onSelect(path: string): void;
  label: string;
}) {
  const rows = React.useMemo(
    () => CHANGE_SET.map((f) => toChangeListRow(f, EMPTY_CHANGE_RECENCY_STATE)),
    [],
  );
  return (
    <figure className="flex w-full max-w-80 flex-1 flex-col gap-2">
      <figcaption className="text-label text-muted-foreground">
        {label} · {width}px
      </figcaption>
      <div
        data-narrow={width <= RAIL_FLOOR ? "true" : undefined}
        className="flex flex-1 flex-col overflow-hidden rounded-xl border bg-background"
        style={{ width }}
      >
        <div className="flex-1 overflow-hidden pt-2">
          <TicketChangesList rows={rows} focusPath={focusPath} onSelectRow={onSelect} />
        </div>
      </div>
    </figure>
  );
}

export default function ChangeRowsScratch() {
  const [focusPath, setFocusPath] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const onSelect = React.useCallback((path: string) => {
    setFocusPath(path);
    setLog((prev) => [...prev.slice(-3), `open → ${path}`]);
  }, []);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start gap-6">
          <RailFrame
            width={RAIL_DEFAULT}
            focusPath={focusPath}
            onSelect={onSelect}
            label="Default"
          />
          <RailFrame width={RAIL_FLOOR} focusPath={focusPath} onSelect={onSelect} label="Floor" />
        </div>
        <p className="text-ui text-muted-foreground">
          Opened: {log.length === 0 ? "nothing yet" : log.join(" · ")}
        </p>
      </div>
    </TooltipProvider>
  );
}
