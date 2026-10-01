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

function checkedState(selection: McpSelection): boolean | "indeterminate" {
  return selection === "all" ? true : selection === "some" ? "indeterminate" : false;
}

export function McpToolPicker({
  serverName,
  tools,
  selected,
  disabled = false,
  focusFilter = false,
  onChange,
}: {
  serverName: string;
  tools: readonly McpCatalogTool[];
  selected: ReadonlySet<string>;
  disabled?: boolean;
  /** Put the caret in the filter when the picker appears — it is where a long list is started. */
  focusFilter?: boolean;
  onChange: (next: Set<string>) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState("");
  const [show, setShow] = React.useState<McpToolShow>("all");
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());

  const listed = visibleTools(tools, query, show, selected);
  const groups = groupTools(listed);
  const listedSelectable = listed.filter(isSelectable);
  const total = tools.filter(isSelectable).length;
  const on = tools.filter((tool) => isSelectable(tool) && selected.has(tool.name)).length;
  const narrowed = query.trim().length > 0 || show !== "all";
  const all = selectionOf(listedSelectable, selected);

  React.useEffect(() => {
    if (focusFilter) root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }, [focusFilter]);

  function toggleOpen(name: string): void {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <TableSearch value={query} placeholder="Filter tools" onChange={setQuery} />
        <Segmented<McpToolShow>
          ariaLabel="Show tools"
          value={show}
          options={SHOW_OPTIONS}
          onChange={setShow}
        />
        <span className="ml-auto text-ui text-muted-foreground tabular-nums" aria-live="polite">
          {on} of {total} on
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/50">
        {listedSelectable.length === 0 ? null : (
          <label className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-2">
            <Checkbox
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
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1" onKeyDown={moveFocus}>
          {listed.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-ui text-muted-foreground">
              <span>{tools.length === 0 ? "This server offers no tools." : "No tools match."}</span>
              {narrowed ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    setShow("all");
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

/**
 * Up and Down walk the checkboxes — groups and tools alike — and Home and End
 * jump to either end, so a forty-tool list is not forty Tabs. Space toggles
 * the focused one, as on any checkbox.
 */
function moveFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const boxes = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="checkbox"]:not(:disabled)',
    ),
  ];
  const at = boxes.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || boxes.length === 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? boxes.length - 1
        : Math.min(boxes.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
  // Focusing scrolls the list to it; nothing else has to.
  boxes[next]?.focus();
}

function ToolGroup({
  group,
  serverName,
  selected,
  disabled,
  open,
  onToggleOpen,
  onChange,
}: {
  group: McpToolGroup;
  serverName: string;
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
  on,
  disabled,
  open,
  onToggleOpen,
  onToggle,
}: {
  tool: McpCatalogTool;
  on: boolean;
  disabled: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggle: () => void;
}) {
  const { title, name } = toolLabel(tool);
  const selectable = isSelectable(tool);
  const parameters = toolParameters(tool);
  const detailed = tool.description.length > 0 || parameters.length > 0;
  return (
    <div
      role="listitem"
      className={cn(
        "flex items-start gap-1 rounded-lg px-1 py-1 hover:bg-accent/40",
        !selectable && "opacity-70",
      )}
    >
      <label className="flex min-w-0 flex-1 items-start gap-2 px-1">
        {/* One text line tall, so the box centres on the title's line box
            rather than on the whole row. */}
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            aria-label={title}
            checked={on && selectable}
            disabled={disabled || !selectable}
            onCheckedChange={onToggle}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 shrink truncate text-ui font-medium">{title}</span>
            {name === null ? null : (
              <code className="min-w-0 shrink-[2] truncate font-mono text-ui text-muted-foreground">
                {name}
              </code>
            )}
            {tool.hints?.destructive === true ? (
              <span className="shrink-0 text-label text-destructive uppercase">Destructive</span>
            ) : null}
          </span>
          {tool.error === null ? null : (
            <span className="block text-ui text-destructive">{tool.error}</span>
          )}
          {tool.description.length === 0 ? null : (
            <span
              className={cn("block text-ui text-muted-foreground", !open && "line-clamp-1")}
              title={open ? undefined : tool.description}
            >
              {tool.description}
            </span>
          )}
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
      </label>
      {detailed ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details for ${title}`}
          onClick={onToggleOpen}
        >
          <CaretDownIcon className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      ) : null}
    </div>
  );
}
