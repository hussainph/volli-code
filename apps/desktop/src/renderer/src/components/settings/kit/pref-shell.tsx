/** Shared Settings shell: scoped rail, row search, one gutter and one page measure. */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { Badge } from "@renderer/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";
import { SETTINGS_ROWS, PAGE_INTROS } from "../settings-inventory";

export interface PrefCategory {
  key: string;
  label: string;
  icon: PhosphorIcon;
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
    const classes = ["bg-primary/10", "ring-2", "ring-inset", "ring-primary/40"];
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
      <div className="flex h-full min-h-0 w-full flex-1">
        <nav
          aria-label={`${surfaceLabel} categories`}
          className="flex w-60 shrink-0 flex-col gap-4 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar p-4"
        >
          {header}
          <InputGroup>
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              aria-label={`Search ${surfaceLabel.toLowerCase()}`}
              placeholder="Search settings…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </InputGroup>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {query.trim() ? (
              <>
                <p className="px-2 pb-2 text-label text-muted-foreground">
                  {results.length} settings found
                </p>
                {results.map(({ category, label }) => (
                  <button
                    type="button"
                    key={`${category.key}/${label}`}
                    onClick={() => {
                      onSelect(category.key);
                      setHighlight(label);
                      setQuery("");
                    }}
                    className="flex w-full items-start gap-2 rounded-row px-2 py-2 text-left text-ui hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <category.icon aria-hidden className="mt-1 size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block font-medium">{label}</span>
                      <span className="text-label text-muted-foreground">
                        {category.key.startsWith("project:") ? "Project" : "All projects"} ·{" "}
                        {category.label}
                      </span>
                    </span>
                  </button>
                ))}
                {!results.length && (
                  <p className="px-2 py-4 text-ui text-muted-foreground">No matching settings.</p>
                )}
              </>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="pb-4">
                  <h3 className="px-2 pb-2 text-ui font-medium text-muted-foreground">
                    {group.label}
                  </h3>
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
                        "flex w-full items-center gap-2 rounded-row px-2 py-2 text-left text-ui transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <div className={cn("px-12 pt-8 pb-16", current?.fill && "flex h-full flex-col")}>
            <div
              className={cn(
                "w-full",
                current?.fill ? "flex min-h-0 flex-1 flex-col" : "max-w-[720px]",
              )}
            >
              <header className="mb-8">
                <h1 className="text-title font-semibold">{current?.label}</h1>
                <p className="mt-2 text-ui text-muted-foreground">
                  {PAGE_INTROS[current?.key ?? ""] ??
                    PAGE_INTROS[`app:${current?.key}`] ??
                    "Settings for this scope."}
                </p>
              </header>
              <div className={cn("flex flex-col gap-8", current?.fill && "min-h-0 flex-1")}>
                {current?.content}
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
