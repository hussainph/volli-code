/**
 * The one place a person chooses which of a server's tools new Sessions get —
 * for a server being added and for one already saved alike.
 *
 * WHAT IT REPLACED. Two different grids of the platform's own checkboxes: one
 * in the editor that showed names only, and one behind a disclosure that showed
 * every description at full length. Neither could select more than one tool
 * per click, filter, or say how a server's tools divide, so a 40-tool server
 * was forty clicks and a scroll. The rules it follows now are in
 * `mcp-tools-model.ts`; this file only draws them.
 *
 * THE LAYOUT, top to bottom:
 *  - a filter and a show control (all · on · off), with the running count;
 *  - **Select all**, a mixed-state checkbox over exactly the listed tools;
 *  - the groups — read-only, then the tools that can make changes, when the
 *    server labels them — each with its own mixed-state checkbox and count;
 *  - tools that cannot be offered, last, with the reason and no checkbox to
 *    click.
 *
 * A row leads with the tool's title (or name) and keeps the exact name beside
 * it; its description is one line until a person opens the row, which also
 * lists the arguments the tool takes. The choice is held by the caller and
 * saved by the caller: this component never writes.
 *
 * THE KEYBOARD. The whole list is ONE Tab stop (a roving tabindex over every
 * checkbox, Select all and the group boxes included): Up and Down walk it,
 * Home and End jump, Space toggles, Right opens a tool's details button and
 * Left comes back. Escape in the filter clears it before it closes anything.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import type { McpCatalogTool } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Segmented } from "@renderer/components/ui/segmented";
import { InfoHint, TableSearch } from "@renderer/components/settings/kit";
import { cn } from "@renderer/lib/utils";

import {
  groupTools,
  isSelectable,
  listedTools,
  selectionOf,
  toggleTool,
  toggleTools,
  toolLabel,
  toolParameters,
  visibleTools,
  type McpSelection,
  type McpToolGroup,
  type McpToolShow,
} from "./mcp-tools-model";

const SHOW_OPTIONS = [
  { key: "all", label: "All" },
  { key: "on", label: "On" },
  { key: "off", label: "Off" },
] as const satisfies readonly { key: McpToolShow; label: string }[];

/** The attribute every roving stop carries, and what it is keyed by. */
const ROVE = "data-rove";

/**
 * Give the list its one Tab stop: the stop keyed `holder`, or the first one
 * that can be used. Every other checkbox, and every details button, is
 * reached by the arrow keys instead.
 */
function dealTabStop(list: HTMLElement | null, holder: string | null): void {
  const stops = [...(list?.querySelectorAll<HTMLButtonElement>(`[${ROVE}]`) ?? [])];
  const usable = stops.filter((stop) => !stop.disabled);
  const held = usable.find((stop) => stop.getAttribute(ROVE) === holder) ?? usable[0];
  for (const stop of stops) stop.tabIndex = stop === held ? 0 : -1;
  for (const details of list?.querySelectorAll<HTMLElement>("[data-details]:not([data-rove])") ??
    []) {
    details.tabIndex = -1;
  }
}

function checkedState(selection: McpSelection): boolean | "indeterminate" {
  return selection === "all" ? true : selection === "some" ? "indeterminate" : false;
}

export function McpToolPicker({
  serverName,
  tools,
  selected,
  disabled = false,
  focusFilter = 0,
  onChange,
}: {
  serverName: string;
  tools: readonly McpCatalogTool[];
  selected: ReadonlySet<string>;
  disabled?: boolean;
  /**
   * Put the caret in the filter — on mount when non-zero, and again each time
   * the number changes. The filter is where a long list is started.
   */
  focusFilter?: number;
  onChange: (next: Set<string>) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  /** Which stop holds the list's one Tab stop, by its `data-rove` key. */
  const active = React.useRef<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [show, setShow] = React.useState<McpToolShow>("all");
  /** Who *On* or *Off* listed when it was chosen; `null` while *All* is. */
  const [members, setMembers] = React.useState<ReadonlySet<string> | null>(null);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());

  const names = React.useMemo(() => new Set(tools.map((tool) => tool.name)), [tools]);
  const listed = listedTools(tools, query, members);
  const groups = groupTools(listed);
  const listedSelectable = listed.filter(isSelectable);
  const total = tools.filter(isSelectable).length;
  const on = tools.filter((tool) => isSelectable(tool) && selected.has(tool.name)).length;
  const narrowed = query.trim().length > 0 || show !== "all";
  const all = selectionOf(listedSelectable, selected);

  React.useEffect(() => {
    if (focusFilter > 0) {
      root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }
  }, [focusFilter]);

  // One Tab stop for the whole list, re-dealt after every render because the
  // rows themselves change with the filter. Nothing here is React state: the
  // stop follows focus, and a re-render that moved it would fight the keyboard.
  React.useLayoutEffect(() => dealTabStop(list.current, active.current));

  function choose(next: McpToolShow): void {
    setShow(next);
    setMembers(
      next === "all" ? null : new Set(visibleTools(tools, "", next, selected).map((t) => t.name)),
    );
  }

  function toggleOpen(name: string): void {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    const stops = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(`[${ROVE}]:not(:disabled)`),
    ];
    if (
      event.key === "ArrowLeft" &&
      target.hasAttribute("data-details") &&
      !target.hasAttribute(ROVE)
    ) {
      event.preventDefault();
      target.closest('[role="listitem"]')?.querySelector<HTMLElement>(`[${ROVE}]`)?.focus();
      return;
    }
    const at = stops.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    if (event.key === "ArrowRight") {
      const details = target
        .closest('[role="listitem"]')
        ?.querySelector<HTMLElement>("[data-details]");
      if (details !== null && details !== undefined) {
        event.preventDefault();
        details.focus();
      }
      return;
    }
    const moves: Record<string, number> = {
      ArrowDown: Math.min(stops.length - 1, at + 1),
      ArrowUp: Math.max(0, at - 1),
      Home: 0,
      End: stops.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    // Focusing scrolls the list to it; nothing else has to.
    stops[next]?.focus();
  }

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-2"
        onKeyDown={(event) => {
          // Escape in a filter with text clears the text. The dialog around
          // this list sees the same key first and stays open for it (its
          // `onEscapeKeyDown`).
          const target = event.target as HTMLInputElement;
          if (event.key === "Escape" && target.type === "search" && query.length > 0) {
            event.preventDefault();
            setQuery("");
          }
        }}
      >
        <div className="min-w-0 flex-1 basis-48 [&>div]:w-full">
          <TableSearch value={query} placeholder="Filter tools" onChange={setQuery} />
        </div>
        <Segmented<McpToolShow>
          ariaLabel="Show tools"
          value={show}
          options={SHOW_OPTIONS}
          onChange={choose}
        />
        <span
          className="ml-auto shrink-0 text-ui text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          {on} of {total} on
        </span>
      </div>

      <div
        ref={list}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/50"
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const key = (event.target as HTMLElement).getAttribute(ROVE);
          if (key === null) return;
          active.current = key;
          dealTabStop(list.current, key);
        }}
      >
        {listedSelectable.length === 0 ? null : (
          <label className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-2">
            <Checkbox
              data-rove="all"
              aria-label={narrowed ? "Select all listed tools" : "Select all tools"}
              checked={checkedState(all)}
              disabled={disabled}
              onCheckedChange={() => onChange(toggleTools(listedSelectable, selected))}
            />
            <span className="text-ui font-medium">
              {narrowed ? `Select all ${listedSelectable.length} listed` : "Select all"}
            </span>
          </label>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {listed.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-ui text-muted-foreground">
              <span>{tools.length === 0 ? "This server offers no tools." : "No tools match."}</span>
              {narrowed ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    choose("all");
                  }}
                >
                  Show all tools
                </Button>
              ) : null}
            </div>
          ) : (
            groups.map((group) => (
              <ToolGroup
                key={group.key}
                group={group}
                serverName={serverName}
                names={names}
                selected={selected}
                disabled={disabled}
                open={open}
                onToggleOpen={toggleOpen}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ToolGroup({
  group,
  serverName,
  names,
  selected,
  disabled,
  open,
  onToggleOpen,
  onChange,
}: {
  group: McpToolGroup;
  serverName: string;
  names: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  disabled: boolean;
  open: ReadonlySet<string>;
  onToggleOpen: (name: string) => void;
  onChange: (next: Set<string>) => void;
}) {
  const selectable = group.key !== "unavailable";
  const on = group.tools.filter((tool) => selected.has(tool.name)).length;
  return (
    <div role="group" aria-label={group.label ?? `${serverName} tools`}>
      {group.label === null ? null : (
        // Sticky inside the list's own scroll box, so a long group still says
        // which group a row belongs to and keeps its checkbox in reach.
        <div className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-background px-1 pt-1">
          {selectable ? (
            <label className="flex items-center gap-2">
              <Checkbox
                data-rove={`group:${group.key}`}
                aria-label={
                  group.key === "read-only"
                    ? "Select all read-only tools"
                    : "Select all tools that can make changes"
                }
                checked={checkedState(selectionOf(group.tools, selected))}
                disabled={disabled}
                onCheckedChange={() => onChange(toggleTools(group.tools, selected))}
              />
              <span className="text-label text-muted-foreground uppercase">{group.label}</span>
            </label>
          ) : (
            <span className="pl-6 text-label text-muted-foreground uppercase">{group.label}</span>
          )}
          {selectable ? (
            <span className="text-ui text-muted-foreground tabular-nums">
              {on} of {group.tools.length}
            </span>
          ) : null}
          {group.key === "read-only" ? (
            // The one trust line this list carries: the grouping is the
            // server's claim, and a person deciding on it should know whose.
            <InfoHint label="read-only tools">
              The server labels these tools read-only. Volli does not check the label.
            </InfoHint>
          ) : null}
        </div>
      )}
      <div role="list">
        {group.tools.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            names={names}
            on={selected.has(tool.name)}
            disabled={disabled}
            open={open.has(tool.name)}
            onToggleOpen={() => onToggleOpen(tool.name)}
            onToggle={() => onChange(toggleTool(tool, selected))}
          />
        ))}
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  names,
  on,
  disabled,
  open,
  onToggleOpen,
  onToggle,
}: {
  tool: McpCatalogTool;
  names: ReadonlySet<string>;
  on: boolean;
  disabled: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggle: () => void;
}) {
  const describedBy = React.useId();
  const { title, name } = toolLabel(tool, names);
  const selectable = isSelectable(tool);
  const parameters = toolParameters(tool);
  const detailed = tool.description.length > 0 || parameters.length > 0;
  const destructive = tool.hints?.destructive === true;
  return (
    <div
      role="listitem"
      className={cn(
        "flex items-start gap-1 rounded-lg px-1 py-1 hover:bg-accent/40",
        !selectable && "opacity-70",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2 px-1">
        {/* One text line tall, so the box centres on the title's line box
            rather than on the whole row. */}
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            data-rove={selectable ? `tool:${tool.name}` : undefined}
            tabIndex={selectable ? undefined : -1}
            id={`${describedBy}-box`}
            // The exact name is always in the accessible name: a server's
            // title is its own words, and the name is what an agent calls.
            aria-label={name === null ? title : `${title} (${name})`}
            aria-describedby={describedBy}
            checked={on && selectable}
            disabled={disabled || !selectable}
            onCheckedChange={onToggle}
          />
        </span>
        <span className="min-w-0 flex-1">
          {/* Only the title line is the checkbox's label: clicking to read a
              description must not change what a Session is offered. */}
          <label htmlFor={`${describedBy}-box`} className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 shrink truncate text-ui font-medium">{title}</span>
            {name === null ? null : (
              <code className="min-w-0 shrink-[2] truncate font-mono text-ui text-muted-foreground">
                {name}
              </code>
            )}
            {destructive ? (
              <span className="shrink-0 text-label text-destructive uppercase">Destructive</span>
            ) : null}
          </label>
          <span id={describedBy} className="block">
            {tool.error === null ? null : (
              <span className="block text-ui text-destructive">{tool.error}</span>
            )}
            {destructive ? <span className="sr-only">Destructive. </span> : null}
            {tool.description.length === 0 ? null : (
              <span
                className={cn("block text-ui text-muted-foreground", !open && "line-clamp-1")}
                title={open ? undefined : tool.description}
              >
                {tool.description}
              </span>
            )}
          </span>
          {open && parameters.length > 0 ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-ui text-muted-foreground">Arguments</span>
              {parameters.map((parameter) => (
                <code
                  key={parameter.name}
                  className="rounded-sm bg-muted/50 px-1 font-mono text-ui text-muted-foreground"
                  title={parameter.type ?? undefined}
                >
                  {parameter.name}
                  {parameter.required ? "" : "?"}
                </code>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      {detailed ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          data-details=""
          data-rove={!selectable ? `details:${tool.name}` : undefined}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details for ${title}`}
          onClick={onToggleOpen}
        >
          <CaretDownIcon className={cn(open && "rotate-180")} />
        </Button>
      ) : null}
    </div>
  );
}
