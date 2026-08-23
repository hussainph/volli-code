/**
 * A bounded, scrollable, sticky-headed table — the one object this app did not
 * already have. `grep` finds no other `<table>` in the renderer.
 *
 * WHY IT EXISTS. Models, Skills, Commands, MCP servers and Plugins are all
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
 * NOT VIRTUALIZED, on purpose. `MAX_SKILLS_PER_DIR` is 200 per directory and a
 * project merges two of them, so ~400 rows is reachable today. `maxItems` caps
 * what RENDERS and says what it withheld; search runs BEFORE the cap, so a
 * withheld row is always still reachable by typing its name — which is what
 * makes truncation safe rather than lossy. Past ~1,000 the answer is Virtuoso
 * (not installed, deliberately), not a bigger cap and not pagination.
 */
import * as React from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { cn } from "@renderer/lib/utils";

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

export function DataTable<T>({
  items,
  keyOf,
  columns,
  search,
  placeholder = "Search",
  filter,
  rows = 8,
  maxItems = 500,
  empty,
  noResults = "Nothing matches.",
  label,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  columns: readonly Column<T>[];
  /** The haystack. Omit for a table that isn't searchable. */
  search?: (item: T) => string;
  placeholder?: string;
  filter?: TableFilter;
  /**
   * How many rows before it scrolls, or `"fill"` to take the height the pane
   * has left over.
   *
   * A number is right whenever something follows the table — the cap is what
   * stops a hundred models burying the sections under them. `"fill"` is for a
   * pane where the table IS the page (Skills, Commands, MCP, Plugins): capping
   * at eight there just draws a short table against a tall empty column and
   * makes people scroll a box that had room to show them the rows.
   */
  rows?: number | "fill";
  /** How many rows may render at once. The rest are withheld, and said so. */
  maxItems?: number;
  empty: string;
  noResults?: string;
  /** The table's accessible name. */
  label: string;
}) {
  const [query, setQuery] = React.useState("");

  const matched = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !search) return items;
    return items.filter((item) => search(item).toLowerCase().includes(needle));
  }, [items, query, search]);

  // Cap AFTER filtering, so narrowing the search always reaches a withheld row.
  const shown = matched.length > maxItems ? matched.slice(0, maxItems) : matched;
  const withheld = matched.length - shown.length;
  const roving = useRovingRows(shown.length);

  const fill = rows === "fill";
  // The sticky header lives inside the same scroll box and would otherwise eat
  // a row — `rows={8}` was showing seven.
  const maxBodyHeight = fill ? undefined : rows * ROW_H + HEAD_H;

  if (items.length === 0 && !filter?.isFiltering) return <Empty>{empty}</Empty>;

  return (
    <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
      {search || filter ? (
        <div className="flex items-center gap-2">
          {search ? (
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                <MagnifyingGlassIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={query}
                aria-label={placeholder}
                placeholder={placeholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
          ) : (
            <div className="flex-1" />
          )}
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
        className={cn("overflow-y-auto", fill && "min-h-0 flex-1")}
        style={fill ? { minHeight: 3 * ROW_H + HEAD_H } : { maxHeight: maxBodyHeight }}
      >
        <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
          <caption className="sr-only">{label}</caption>
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    // `text-ui` in the mute, sentence case. The 11px uppercase
                    // eyebrow belongs to a section, not a column — using it
                    // here made eight rows of data look like a spreadsheet
                    // embedded in a settings page.
                    "h-8 border-b border-border/50 px-2 text-ui font-normal text-muted-foreground",
                    column.align === "end" ? "text-right" : "text-left",
                  )}
                >
                  <span className={column.headerHidden ? "sr-only" : undefined}>
                    {column.header}
                  </span>
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
                className="border-t border-border/50 outline-none first:border-t-0 hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-inset"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "h-9 px-2 text-sm",
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
        {shown.length === 0 ? <Empty>{noResults}</Empty> : null}
      </div>
      {withheld > 0 ? (
        <p className="text-ui text-muted-foreground">
          Showing {shown.length} of {matched.length}. Search to narrow.
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {query.trim() ? `${shown.length} of ${matched.length} shown` : ""}
      </p>
    </div>
  );
}

/**
 * A quiet, aligned word — what a repeated pill becomes inside a table.
 *
 * A string cell carries its own `title`, because a column narrow enough to be
 * scannable is narrow enough to truncate, and a truncated value the reader
 * cannot recover is worse than a wrapped one. This is the content itself on
 * hover, not a tutorial tooltip.
 */
export function Cell({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      title={typeof children === "string" ? children : undefined}
      className={cn("min-w-0 truncate", muted && "text-muted-foreground")}
    >
      {children}
    </span>
  );
}
