/**
 * The two-pane shell both settings surfaces are drawn in: a grouped,
 * searchable category rail and the active pane beside it.
 *
 * GROUP LABELS CARRY THE RELATIONSHIP. A flat list of nine categories is a
 * list you read; three groups of three is a structure you navigate. Settings
 * groups as Preferences · Services · System, Configure as Agent · Project.
 *
 * SCOPE IS THE SURFACE, not a mode inside it. Settings is app-wide, Configure
 * is this project, and neither carries a scope switch — see `override.tsx`.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { WorkbenchColumn } from "@renderer/components/layout/content-column";
import { PageHeader } from "@renderer/components/layout/page-header";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { Badge } from "@renderer/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

export interface PrefCategory {
  key: string;
  label: string;
  icon: PhosphorIcon;
  /**
   * Extra search terms. Hand-maintained, and guarded: `vc111-settings-search`
   * walks every row label on both surfaces and fails if one is unreachable
   * from rail search. Keep it green when you add rows.
   */
  keywords?: readonly string[];
  /** A count. `Badge variant="count"` — bare muted mono, deliberately not a pill. */
  count?: number;
  /** Something is wrong or waiting here. Drawn as a dot, said in the name. */
  attention?: { state: StatusDotState; label: string };
  /**
   * This pane's content should absorb the leftover height rather than sit in a
   * short box under a tall empty column. For a pane that IS one table.
   *
   * BOUNDED BY THE VIEWPORT, not by the row count: the column takes `h-full`,
   * a definite height, so the table's `flex-1` resolves against the window and
   * can never grow past it. `min-h-full` would only be a floor — four hundred
   * skills would push the container taller than the screen and hand back the
   * unbounded page-scroll this exists to avoid.
   *
   * The pane still scrolls when it is genuinely cramped: the table keeps a
   * three-row floor, and if that floor plus the header exceeds the window, the
   * scroller overflows and scrolls as before rather than clipping.
   */
  fill?: boolean;
  content: React.ReactNode;
}

export interface PrefGroup {
  key: string;
  label: string;
  categories: readonly PrefCategory[];
}

export function PrefShell({
  surfaceLabel,
  groups,
  header,
  activeKey,
  onSelect,
}: {
  surfaceLabel: string;
  groups: readonly PrefGroup[];
  /** What sits above the search field — the project identity, on Configure. */
  header?: React.ReactNode;
  /** Controlled: the caller owns the selection, so a deep link can set it. */
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const all = React.useMemo(() => groups.flatMap((group) => group.categories), [groups]);
  const [query, setQuery] = React.useState("");
  const scroller = React.useRef<HTMLDivElement>(null);

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return new Set(
      all
        .filter((category) =>
          [category.label, ...(category.keywords ?? [])].some((term) =>
            term.toLowerCase().includes(needle),
          ),
        )
        .map((category) => category.key),
    );
  }, [all, query]);

  const visible = groups
    .map((group) => ({
      ...group,
      categories: group.categories.filter((c) => matches === null || matches.has(c.key)),
    }))
    .filter((group) => group.categories.length > 0);

  // A pane switch starts at the top. The scroll container is explicit rather
  // than inferred, because `scrollIntoView` on a mounting child fights the
  // layout it is mounting into.
  React.useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [activeKey]);

  const current = all.find((category) => category.key === activeKey) ?? all[0] ?? null;

  return (
    // ONE tooltip provider for both surfaces. Row actions are glyphs and need
    // tooltips to be legible, and `Tooltip` does not carry its own provider —
    // the app only had one inside the sidebar, so a settings pane using a
    // tooltip threw "`Tooltip` must be used within `TooltipProvider`" and
    // painted an empty pane. Mounting it at the shell means a pane cannot
    // forget it.
    <TooltipProvider>
      {/* `w-full flex-1` is not decoration. Without it this root is a
          shrink-to-fit flex item and the entire surface collapses to the width
          of its widest line — ~670px in a 1400px window, jammed against the
          left edge, every table column starved. Invisible in a screenshot of
          the pane alone, which is how it shipped once. */}
      <div className="flex h-full min-h-0 w-full flex-1">
        <nav
          aria-label={`${surfaceLabel} categories`}
          className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-4"
        >
          {header}
          <InputGroup className="mx-1">
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              aria-label={`Search ${surfaceLabel.toLowerCase()}`}
              placeholder="Search"
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.map((group) => (
              <div key={group.key} className="pb-4">
                <SectionHeading as="p" className="px-2 pb-1">
                  {group.label}
                </SectionHeading>
                {group.categories.map((category) => (
                  <button
                    key={category.key}
                    type="button"
                    aria-current={category.key === current?.key ? "page" : undefined}
                    onClick={() => onSelect(category.key)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none",
                      category.key === current?.key
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <category.icon aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{category.label}</span>
                    {category.count === undefined ? null : (
                      <Badge variant="count">{category.count}</Badge>
                    )}
                    {category.attention ? (
                      <>
                        <StatusDot state={category.attention.state} />
                        {/* The dot is `aria-hidden` by construction, so the
                          state is said here rather than dropped. */}
                        <span className="sr-only">{category.attention.label}</span>
                      </>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
            {visible.length === 0 ? (
              <p className="px-2 py-6 text-center text-ui text-muted-foreground">
                Nothing matches.
              </p>
            ) : null}
            <p aria-live="polite" className="sr-only">
              {matches === null ? "" : `${matches.size} categories match`}
            </p>
          </div>
        </nav>

        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          {/* Tier B: a pane LOOKS like a reading surface but its tables are not
            prose. Skills carry a name, a description and provenance; at the
            45rem measure the description truncated to a few words, which is
            the one column that tells two skills apart. Wider measure, same
            gutter, same whitespace-not-breakpoints rule (docs/DESIGN.md). */}
          <WorkbenchColumn className={cn("pb-4", current?.fill && "flex h-full flex-col")}>
            <PageHeader variant="reading" title={current?.label ?? ""} />
            <div className={cn("flex flex-col gap-6", current?.fill && "min-h-0 flex-1")}>
              {current?.content}
            </div>
          </WorkbenchColumn>
        </div>
      </div>
    </TooltipProvider>
  );
}
