/**
 * Status has three roles on a settings surface, and therefore three shapes.
 *
 *  1. **Is it working?** — {@link Health}. A dot and a word.
 *  2. **Who set this value?** — {@link Provenance}. Volli, or the tool it
 *     reads from.
 *  3. **Where did it come from?** — a `DataTable` column, not a component
 *     here. Scope provenance repeated down a list is a column; drawn as a
 *     pill per row it is noise, and it spends the pill shape (which
 *     `docs/DESIGN.md` reserves for *a control that acts*) on a fact.
 *
 * Keeping them apart is the point. An earlier pass had one badge doing all
 * three jobs, so a row could say "This project" and leave a reader unsure
 * whether that meant the value, the file, or the connection.
 */
import type * as React from "react";

import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

/**
 * Is this thing working?
 *
 * The colour comes from `ui/status-dot.tsx`, which is the app's single map
 * from state to hue — twelve surfaces read it, and its header says in as many
 * words that its whole point is that "a surface can choose to draw a dot but
 * cannot choose what the dot means". An earlier pass of this kit invented a
 * second three-tone map one folder away, which is precisely the drift that
 * file exists to end.
 */
export function Health({ state, children }: { state: StatusDotState; children: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
      <StatusDot state={state} />
      {children}
    </span>
  );
}

/**
 * Who set this value — Volli, or the tool whose config it layers over.
 *
 * Distinct from provenance-as-scope (project vs personal), which is a table
 * column. One component, one meaning.
 */
export function Provenance({
  mine,
  children,
}: {
  /** Volli set it, as opposed to reading it from the user's own config. */
  mine?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("text-ui", mine ? "text-primary-text" : "text-muted-foreground")}>
      {children}
    </span>
  );
}
