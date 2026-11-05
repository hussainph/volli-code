/**
 * A bounded, scrollable, sticky-headed table — the one object this app did not
 * already have. `grep` finds no other `<table>` in the renderer.
 *
 * WHY IT EXISTS. Models, Skills, Commands and MCP servers are all
 * *homogeneous collections with shared attributes*, and every one of them was
 * drawn as an unbounded stack of two-line rows. Two things went wrong. The
 * page grew without limit, so a catalogue of a hundred models buried every
 * section under it and the rail's other categories became unreachable without
 * a long scroll. And the shared attributes had nowhere to live but inside the
 * row, which is what forced provenance into a repeated pill on every line.
 *
 * A table fixes both at once: `rows` caps the height so the *page* stays
 * navigable while the *collection* scrolls in its own box, and a column turns
 * a repeated pill into a quiet aligned word.
 *
 * A REAL `<table>`, because this is tabular data and the semantics are free —
 * column headers announce with their cells, and `scope="col"` costs nothing.
 * The sticky header is `position: sticky` on the `<th>`s, which works inside
 * an `overflow-auto` ancestor with no JS.
 *
 * Page boundaries bound mounted rows; search spans the COMPLETE collection.
 * Every record remains reachable even when its name is unknown.
 */
import type { EmptyIllustration } from "@renderer/components/ui/empty-state";
import * as React from "react";
import { Button } from "@renderer/components/ui/button";
import { SearchIcon } from "@renderer/components/ui/icon";

import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { cn } from "@renderer/lib/utils";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { ValueReveal } from "@renderer/components/ui/value-reveal";

import { Empty } from "./async-section";
import { CONTROL_W } from "./control-width";
import { useRovingRows } from "./use-roving-rows";

export interface Column<T> {
  key: string;
  header: string;
  /**
   * A CSS length or percentage — `8rem`, `40%`. **Not** a grid track.
   *
   * This once said `minmax(0,1fr)` and three columns passed it. React drops it
   * as an invalid width, so the attribute reached the DOM empty and the column
   * sized by `table-layout: fixed`'s remainder rule instead — it rendered
   * correctly *by accident*, which is the worst way for an API to be wrong.
   *
   * Omit to take the remaining space; that is the same behaviour, now spelled.
   * Two omitted columns split the remainder evenly. Use percentages for a ratio.
   */
  width?: string;
  /**
   * `end` is for NUMBERS and for hidden-header glyph columns — the two cases
   * where right-alignment carries meaning (digits line up; actions hug the
   * table's edge). A worded column of controls stays `start` like its
   * neighbours: one right-aligned header in a row of left-aligned ones reads
   * as a mistake, not as a convention.
   */
  align?: "start" | "end";
  /** Header text is hidden but still read. For an actions or toggle column. */
  headerHidden?: boolean;
  cell: (item: T) => React.ReactNode;
}

export interface TableFilter {
  label: string;
  value: string;
  /** Whether this selection has already narrowed `items` outside the table. */
  isFiltering: boolean;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** Row height and header height, in px — the two numbers `rows` is measured in. */
const ROW_H = 36;
const HEAD_H = 32;

/**
 * The width of a hidden-header column of `count` glyph actions (`RowAction`),
 * measured from what the column holds rather than guessed: each action's
 * square default-rung target, the cell's `gap-2` between them, and the cell's
 * `px-2` inset on either side. The same three tokens draw the cell, so a
 * change to the control rung or the cell's spacing moves this with it.
 */
export function actionsColumnWidth(count: number): string {
  const gaps = Math.max(0, count - 1);
  return `calc(${count} * var(--spacing-control-default) + ${gaps * 2 + 4} * var(--spacing))`;
}

export function DataTable<T>({
  items,
  keyOf,
  columns,
  search,
  query,
  onClearSearch,
  placeholder = "Search",
  filter,
  bulk,
  rows = 8,
  maxItems = 500,
  empty,
  noResults,
  emptyIllustration = "file",
  emptyLine,
  emptyAction,
  label,
  selection,
  minWidth = 560,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  columns: readonly Column<T>[];
  /** The haystack. Omit for a table that isn't searchable. */
  search?: (item: T) => string;
  /**
   * A CONTROLLED query, for a section that parks its {@link TableSearch} on
   * the header rail instead. When set, the table draws no search field of its
   * own — two fields filtering one table would fight — and the toolbar only
   * renders if a filter or bulk control still needs the row. This exists for
   * the table whose ONLY control is search: a toolbar row holding one lone
   * field under an otherwise-empty header rail read as a dead row, when the
   * header had exactly one action slot going spare.
   */
  query?: string;
  onClearSearch?: () => void;
  placeholder?: string;
  filter?: TableFilter;
  /**
   * A control that acts on MANY rows, rendered in the toolbar and handed
   * exactly the rows currently listed.
   *
   * It takes `matched` rather than `items` because the search box lives in
   * here. A bulk control fed the unfiltered set would read "apply to these
   * four" while quietly changing four hundred — the table is the only thing
   * that knows what "these" means, so it is the table that says.
   */
  bulk?: (matched: readonly T[]) => React.ReactNode;
  /**
   * How many rows before it scrolls, or `"fill"` to take the height the pane
   * has left over.
   *
   * A number is right whenever something follows the table — the cap is what
   * stops a hundred models burying the sections under them. `"fill"` is for a
   * pane where the table IS the page (Skills and Commands, and only those two:
   * capping at eight there just draws a short table against a tall empty
   * column and makes people scroll a box that had room to show them the rows).
   * MCP is a table, an editor and an audit list, so it takes a number instead
   * — see the two laws in `configure/mcp-pane.tsx` (VC-397).
   */
  rows?: number | "fill";
  /** Page size: bounds mounted rows without withholding records. */
  maxItems?: number;
  empty: string;
  noResults?: string;
  emptyIllustration?: EmptyIllustration;
  emptyLine?: string;
  emptyAction?: React.ComponentProps<typeof Empty>["action"];
  /** The table's accessible name. */
  label: string;
  /** Selection is controlled and bulk actions receive only the visible selected set. */
  selection?: {
    keys: ReadonlySet<string>;
    onChange(keys: ReadonlySet<string>): void;
    labelOf(item: T): string;
  };
  /** Keep columns legible in narrow windows; the body scrolls horizontally instead of overlapping. */
  minWidth?: number;
}) {
  const [ownQuery, setOwnQuery] = React.useState("");
  const effectiveQuery = query ?? ownQuery;

  const matched = React.useMemo(() => {
    const needle = effectiveQuery.trim().toLowerCase();
    if (!needle || !search) return items;
    return items.filter((item) => search(item).toLowerCase().includes(needle));
  }, [items, effectiveQuery, search]);

  const [page, setPage] = React.useState(0);
  React.useEffect(() => setPage(0), [effectiveQuery, filter?.value]);
  const pageSize = Math.max(1, maxItems);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * pageSize;
  const shown = matched.slice(start, start + pageSize);
  const roving = useRovingRows(shown.length);

  const selected = selection ? shown.filter((item) => selection.keys.has(keyOf(item))) : matched;
  const selectedCount = selection
    ? shown.filter((item) => selection.keys.has(keyOf(item))).length
    : 0;
  const tableColumns: readonly Column<T>[] = selection
    ? [
        {
          key: "__selection",
          header: "Select",
          width: "2.5rem",
          cell: (item) => (
            <Checkbox
              aria-label={`Select ${selection.labelOf(item)}`}
              checked={selection.keys.has(keyOf(item))}
              onCheckedChange={(checked) => {
                const next = new Set(selection.keys);
                if (checked) next.add(keyOf(item));
                else next.delete(keyOf(item));
                selection.onChange(next);
              }}
            />
          ),
        },
        ...columns,
      ]
    : columns;
  const fill = rows === "fill";
  // The sticky header lives inside the same scroll box and would otherwise eat
  // a row — `rows={8}` was showing seven.
  const maxBodyHeight = fill ? undefined : rows * ROW_H + HEAD_H;

  if (items.length === 0 && !filter?.isFiltering)
    return (
      <Empty illustration={emptyIllustration} line={emptyLine} action={emptyAction}>
        {empty}
      </Empty>
    );

  return (
    <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
      {(search && query === undefined) || filter || bulk ? (
        // Search ANCHORS THE LEFT, scope controls sit right — the toolbar
        // spans the table it governs, like the column row under it. It was
        // briefly `justify-end`, which just moved the dead space to the left
        // of the row. The field itself is the compact w-56 object the provider
        // list carries on its header rail: one search grammar everywhere,
        // never the full-width bar that read as the table's first row.
        <div className="flex flex-wrap items-center justify-between gap-2 p-2">
          {search && query === undefined ? (
            <TableSearch value={ownQuery} placeholder={placeholder} onChange={setOwnQuery} />
          ) : (
            <span />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/* ONE control replaces N pills. The provenance a reader wanted to
                scan for is now something they can filter to. */}
            {filter ? (
              <Select value={filter.value} onValueChange={filter.onChange}>
                <SelectTrigger size="sm" className={CONTROL_W.md} aria-label={filter.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {filter.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {bulk?.(selected)}
          </div>
        </div>
      ) : null}

      {/* NO FRAME. The section already is one; a bordered box here was the
          second of three nested rounded rectangles and the reason the surface
          read as boxes all the way down. The header hairline and the row
          hairlines are the whole structure a table needs. */}
      {/* In fill mode the floor matters: the toolbar and the section header
          above this can leave almost nothing on a short window, and a scroll
          box allowed to flex to zero shows a header and no rows at all. With a
          floor it keeps three rows and the PAGE scrolls instead. */}
      <div
        className={cn("overflow-auto", fill && "min-h-0 flex-1")}
        style={fill ? { minHeight: 3 * ROW_H + HEAD_H } : { maxHeight: maxBodyHeight }}
      >
        <table className="w-full border-collapse" style={{ tableLayout: "fixed", minWidth }}>
          <caption className="sr-only">{label}</caption>
          <colgroup>
            {tableColumns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              {tableColumns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    // `text-ui` in the mute, sentence case. The 11px uppercase
                    // eyebrow belongs to a section, not a column — using it
                    // here made eight rows of data look like a spreadsheet
                    // embedded in a settings page.
                    "h-8 border-b border-border/50 px-2 text-ui font-semibold text-foreground",
                    column.align === "end" ? "text-right" : "text-left",
                  )}
                >
                  {column.key === "__selection" && selection ? (
                    <Checkbox
                      aria-label="Select all visible rows"
                      checked={
                        shown.length > 0 && selectedCount === shown.length
                          ? true
                          : selectedCount > 0
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) => {
                        const next = new Set(selection.keys);
                        for (const item of shown) {
                          if (checked) next.add(keyOf(item));
                          else next.delete(keyOf(item));
                        }
                        selection.onChange(next);
                      }}
                    />
                  ) : (
                    <span className={column.headerHidden ? "sr-only" : undefined}>
                      {column.header}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={roving.bodyRef}>
            {shown.map((item, index) => (
              <tr
                key={keyOf(item)}
                // One tab stop for the whole table; arrows do the rest.
                tabIndex={index === roving.active ? 0 : -1}
                onKeyDown={(event) => roving.onKeyDown(event, index)}
                // Clicking a row makes it the tab stop, so returning by Tab
                // lands where the pointer left off rather than back at row 0.
                onFocus={(event) => {
                  if (event.target === event.currentTarget) roving.setActive(index);
                }}
                className="border-t border-border/50 outline-none first:border-t-0 hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {tableColumns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "h-9 px-2 py-2 text-ui",
                      column.align === "end" ? "text-right" : "text-left",
                    )}
                  >
                    <div
                      className={cn(
                        "flex min-w-0 items-center gap-2",
                        column.align === "end" && "justify-end",
                      )}
                    >
                      {column.cell(item)}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <Empty
            illustration="search"
            action={{
              label: "Clear search",
              onAction: () => {
                setOwnQuery("");
                onClearSearch?.();
                const first = filter?.options[0];
                if (first) filter?.onChange(first.value);
              },
            }}
          >
            {noResults ?? `No matching ${label.toLowerCase()}`}
          </Empty>
        ) : null}
      </div>
      {pages > 1 ? (
        <nav aria-label={`${label} pages`} className="flex items-center justify-between gap-2 px-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous page
          </Button>
          <span className="text-ui text-muted-foreground">
            {start + 1}–{start + shown.length} of {matched.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage + 1 === pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next page
          </Button>
        </nav>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {effectiveQuery.trim() ? `${shown.length} of ${matched.length} shown` : ""}
      </p>
    </div>
  );
}

/**
 * The one search field a collection gets — compact, iconed, w-56.
 *
 * Rendered by the table's own toolbar normally; rendered by the SECTION, on
 * its header rail beside the title, when search is the table's only control
 * (pass the value back down through `DataTable`'s `query`). Either way it is
 * this component, so the two positions can never drift apart in shape.
 */
export function TableSearch({
  value,
  placeholder = "Search",
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup className="w-56 max-w-full">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </InputGroup>
  );
}

/**
 * A quiet, aligned word — what a repeated pill becomes inside a table.
 *
 * A string cell carries its own `title`, because a column narrow enough to be
 * scannable is narrow enough to truncate, and a truncated value the reader
 * cannot recover is worse than a wrapped one. This is the content itself on
 * hover, not a tutorial tooltip. A cell whose children are not a bare string
 * (a name with a glyph beside it) passes the same text as `title` itself.
 *
 * `reveal` upgrades that hover-only title to the shared `ValueReveal`: a
 * focus stop whose accessible name and tooltip carry the whole value, so a
 * clipped NAME — the column a reader scans the table by — is readable from
 * the keyboard too. Pass it for an identity column; a quiet attribute column
 * can keep the title.
 */
export function Cell({
  children,
  title,
  muted,
  strong,
  reveal,
}: {
  children: React.ReactNode;
  /** The full text on hover, for a cell whose children are not a bare string. */
  title?: string;
  muted?: boolean;
  /**
   * The row's identity column — the one word a reader scans the table BY.
   * One weight step, nothing else: at equal weight the name and its
   * description read as one grey run and the eye has no landing point per row.
   */
  strong?: boolean;
  /** What the value IS (`Skill`), to reveal it whole through `ValueReveal`. */
  reveal?: string;
}) {
  const full = title ?? (typeof children === "string" ? children : undefined);
  const className = cn(
    "min-w-0 truncate",
    muted && "text-muted-foreground",
    strong && "font-medium",
  );
  if (reveal !== undefined && full !== undefined) {
    return (
      <ValueReveal term={reveal} full={full} side="top" className={cn(className, "text-left")}>
        {children}
      </ValueReveal>
    );
  }
  return (
    <span title={full} className={className}>
      {children}
    </span>
  );
}

/** Full authored descriptions are one click or keyboard press away, never native-title-only. */
export function DescriptionCell({ children }: { children: string }) {
  return (
    <Popover>
      <PopoverTrigger
        className="min-w-0 truncate text-left text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Read description: ${children}`}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent className="max-w-[calc(100vw-2rem)] text-ui" align="start">
        {children}
      </PopoverContent>
    </Popover>
  );
}
