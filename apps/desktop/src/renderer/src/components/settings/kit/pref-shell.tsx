import { settingsIconColor } from "@volli/shared";
/** Shared Settings shell: scoped rail, row search, one gutter and one page measure. */
import * as React from "react";
import { type IconComponent, SearchIcon } from "@renderer/components/ui/icon";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { Badge } from "@renderer/components/ui/badge";
import { IdentityTile } from "@renderer/components/ui/identity-tile";
import { PageHeader } from "@renderer/components/layout/page-header";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";
import { SETTINGS_ROWS } from "../settings-inventory";

export interface PrefCategory {
  key: string;
  label: string;
  icon: IconComponent;
  keywords?: readonly string[];
  count?: number;
  attention?: { state: StatusDotState; label: string };
  fill?: boolean;
  content: React.ReactNode;
}
export interface PrefGroup {
  key: string;
  label: string;
  categories: readonly PrefCategory[];
}

export function settingsSearch(groups: readonly PrefGroup[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return groups
    .flatMap((g) => g.categories)
    .flatMap((category) => {
      const rows =
        SETTINGS_ROWS[category.key] ??
        SETTINGS_ROWS[category.key.startsWith("project:") ? category.key : `app:${category.key}`] ??
        [];
      const matched = rows.filter((row) => row.toLowerCase().includes(needle));
      if (matched.length) return matched.map((label) => ({ category, label }));
      return [category.label, ...(category.keywords ?? [])].some((term) =>
        term.toLowerCase().includes(needle),
      )
        ? [{ category, label: category.label }]
        : [];
    });
}
export function PrefShell({
  surfaceLabel,
  groups,
  searchGroups = groups,
  header,
  activeKey,
  onSelect,
}: {
  surfaceLabel: string;
  groups: readonly PrefGroup[];
  searchGroups?: readonly PrefGroup[];
  header?: React.ReactNode;
  activeKey: string;
  onSelect(key: string): void;
}) {
  const all = React.useMemo(() => searchGroups.flatMap((g) => g.categories), [searchGroups]);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState("");
  const scroller = React.useRef<HTMLDivElement>(null);
  const results = React.useMemo(() => settingsSearch(searchGroups, query), [searchGroups, query]);
  const current = all.find((c) => c.key === activeKey) ?? groups[0]?.categories[0] ?? null;
  React.useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [activeKey]);
  React.useEffect(() => {
    if (!highlight || !scroller.current) return;
    const root = scroller.current;
    let row: Element | undefined;
    const classes = ["bg-(--accent-tint)", "ring-2", "ring-inset", "ring-primary/40"];
    const reveal = () => {
      if (row) return;
      const label = Array.from(
        root.querySelectorAll('[data-slot="pref-row-label"], [data-slot="pref-section-title"]'),
      ).find((el) => el.textContent?.toLowerCase() === highlight.toLowerCase());
      row = label?.closest('[data-slot="pref-row"]') ?? label?.closest("section") ?? undefined;
      if (row) {
        row.classList.add(...classes);
        row.scrollIntoView?.({ block: "center" });
      }
    };
    reveal();
    const observer = new MutationObserver(reveal);
    observer.observe(root, { subtree: true, childList: true });
    return () => {
      observer.disconnect();
      row?.classList.remove(...classes);
    };
  }, [activeKey, highlight]);
  return (
    <TooltipProvider>
      <div data-slot="pref-shell" className="flex min-h-0 w-full flex-1 overflow-hidden">
        {/* Plain native sidebar (VC-1228): the window's own floor, no glass. */}
        <nav
          aria-label={`${surfaceLabel} categories`}
          data-slot="pref-navigation"
          className="flex w-[220px] shrink-0 flex-col gap-3 overflow-x-hidden overflow-y-auto border-r border-border/50 px-3 pb-4 pt-2"
        >
          <InputGroup className="search-capsule">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              aria-label={`Search ${surfaceLabel.toLowerCase()}`}
              placeholder="Search settings…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </InputGroup>
          {header}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={cn(
                "px-2 pb-2 text-label text-muted-foreground",
                !query.trim() && "sr-only",
              )}
            >
              {query.trim()
                ? `${results.length} ${results.length === 1 ? "setting" : "settings"} found`
                : ""}
            </p>
            {query.trim() ? (
              <>
                {results.map(({ category, label }) => (
                  <button
                    type="button"
                    key={`${category.key}/${label}`}
                    onClick={() => {
                      onSelect(category.key);
                      setHighlight(label);
                      setQuery("");
                    }}
                    className="flex w-full items-center gap-2 rounded-row px-2 py-2 text-left text-ui hover:bg-(--accent-tint) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <IdentityTile
                      size="sm"
                      aria-hidden
                      style={{
                        background: settingsIconColor(category.key),
                        color: "var(--settings-icon-ink)",
                      }}
                    >
                      <category.icon className="size-3.5" />
                    </IdentityTile>
                    <span className="min-w-0">
                      <span className="block font-medium">{label}</span>
                      <span className="text-label text-muted-foreground">
                        {category.key.startsWith("project:") ? "Project" : "All projects"} ·{" "}
                        {category.label}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="pb-4">
                  <SectionHeading as="h3" className="flex min-h-7 items-center px-2">
                    {group.label}
                  </SectionHeading>
                  {group.categories.map((category) => (
                    <button
                      key={category.key}
                      type="button"
                      aria-current={category.key === current?.key ? "page" : undefined}
                      onClick={() => {
                        setHighlight("");
                        onSelect(category.key);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-row px-2 py-2 text-left text-ui text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        category.key === current?.key
                          ? "bg-(--accent-selected) text-primary-text"
                          : "hover:bg-(--accent-tint)",
                      )}
                    >
                      <IdentityTile
                        size="sm"
                        aria-hidden
                        style={{
                          background: settingsIconColor(category.key),
                          color: "var(--settings-icon-ink)",
                        }}
                      >
                        <category.icon className="size-3.5" />
                      </IdentityTile>
                      <span className="min-w-0 flex-1 truncate">{category.label}</span>
                      {category.count === undefined ? null : (
                        <Badge variant="count">{category.count}</Badge>
                      )}
                      {category.attention ? (
                        <>
                          <StatusDot state={category.attention.state} />
                          <span className="sr-only">{category.attention.label}</span>
                        </>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </nav>
        <div
          ref={scroller}
          data-slot="pref-content"
          className="material-solid min-w-0 flex-1 overflow-y-auto"
        >
          <div className={cn("px-6 pt-4 pb-6", current?.fill && "flex h-full flex-col")}>
            <div
              className={cn(
                "w-full",
                current?.fill ? "flex min-h-0 flex-1 flex-col" : "max-w-[720px]",
              )}
            >
              <PageHeader title={current?.label} variant="reading" className="mb-4 py-0" />
              <div className={cn("flex flex-col gap-5", current?.fill && "min-h-0 flex-1")}>
                {current?.content}
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
