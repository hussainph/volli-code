import * as React from "react";
import { SearchIcon } from "./icon";
import { SECTION_HEADING } from "./section-heading";
import { COMMAND_SEARCH_FIELD, MENU_ROW, MENU_ROW_STATE_CMDK } from "./menu-classes";
import { cn } from "@renderer/lib/utils";

const ROW = 32;
const OVERSCAN = 2;
// max-h-64 shows eight rows; retain two more on either side.
const WINDOW = 8 + OVERSCAN * 2;
/** A windowed combobox using the shared menu/field recipes. Logical keyboard
 * order and active-descendant identity never depend on mounted registrations. */
export function SearchableCommand<T>({
  items,
  keyOf,
  renderItem,
  groupOf,
  showGroupHeadings = true,
  onSelect,
  query,
  onQueryChange,
  placeholder,
  disabled = false,
  empty = "No results",
}: {
  items: readonly T[];
  keyOf(item: T): string;
  renderItem(item: T): React.ReactNode;
  /** Contiguous groups keep their heading and accessible option ownership. */
  groupOf?(item: T): string;
  /** Keep accessible grouping without spending a row on a repeated identity. */
  showGroupHeadings?: boolean;
  onSelect(item: T): void;
  query: string;
  onQueryChange(query: string): void;
  placeholder: string;
  disabled?: boolean;
  empty?: string;
}) {
  const id = React.useId();
  const scroll = React.useRef<HTMLDivElement>(null);
  const [top, setTop] = React.useState(0);
  const [active, setActive] = React.useState<string>("");
  const found = items.findIndex((item) => keyOf(item) === active);
  const index = items.length === 0 ? -1 : Math.max(0, found);
  const layout = React.useMemo(() => {
    const offsets: number[] = [];
    const groups: { label: string; top: number; from: number; to: number }[] = [];
    let height = 0;
    items.forEach((item, position) => {
      const label = groupOf?.(item) ?? "";
      if (position === 0 || label !== groups.at(-1)?.label) {
        groups.push({ label, top: height, from: position, to: position });
        if (label && showGroupHeadings) height += ROW;
      }
      groups.at(-1)!.to = position + 1;
      offsets.push(height);
      height += ROW;
    });
    return { offsets, groups, height };
  }, [items, groupOf, showGroupHeadings]);
  const visibleStart = Math.max(
    0,
    layout.offsets.findIndex((offset) => offset + ROW > top),
  );
  const first = Math.min(Math.max(0, items.length - WINDOW), Math.max(0, visibleStart - OVERSCAN));
  const last = Math.min(items.length, first + WINDOW);
  const mounted = Array.from({ length: last - first }, (_, i) => first + i);
  if (index >= 0 && (index < first || index >= last)) mounted.push(index);
  const rowId = (at: number) => `${id}-option-${encodeURIComponent(keyOf(items[at]!))}`;
  React.useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
    setTop(0);
    setActive("");
  }, [query]);
  const reveal = (at: number) => {
    const node = scroll.current,
      item = items[at];
    if (!node || item === undefined) return;
    setActive(keyOf(item));
    const height = node.clientHeight || 256;
    const offset = layout.offsets[at]!;
    if (offset < node.scrollTop) node.scrollTop = offset;
    else if (offset + ROW > node.scrollTop + height) node.scrollTop = offset + ROW - height;
    setTop(node.scrollTop);
  };
  return (
    <div
      data-slot="command"
      className="material-regular flex min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-menu bg-transparent text-ui text-foreground"
    >
      <div data-slot="command-input-wrapper" className={COMMAND_SEARCH_FIELD}>
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={index < 0 ? undefined : rowId(index)}
          aria-label={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-slot="command-input"
          className="h-full min-w-0 flex-1 bg-transparent text-ui outline-hidden placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && index >= 0) {
              event.preventDefault();
              event.stopPropagation();
              if (!disabled) onSelect(items[index]!);
              return;
            }
            if (
              items.length === 0 ||
              !["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const at = Math.max(0, index);
            reveal(
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        items.length - 1,
                        at +
                          (event.key === "PageDown"
                            ? 8
                            : event.key === "PageUp"
                              ? -8
                              : event.key === "ArrowDown"
                                ? 1
                                : -1),
                      ),
                    ),
            );
          }}
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={placeholder}
        data-slot="command-list"
        ref={scroll}
        className="min-h-0 max-h-64 overflow-x-hidden overflow-y-auto overscroll-contain p-1"
        onScroll={(event) => setTop(event.currentTarget.scrollTop)}
      >
        {items.length === 0 ? (
          <div role="status" className="px-2 py-3 text-ui text-muted-foreground">
            {empty}
          </div>
        ) : null}
        <div role="presentation" style={{ height: layout.height, position: "relative" }}>
          {layout.groups.map((group) => {
            const indices = mounted.filter((at) => at >= group.from && at < group.to);
            if (indices.length === 0) return null;
            return (
              <div
                key={group.from}
                role={group.label ? "group" : "presentation"}
                aria-label={group.label || undefined}
              >
                {group.label && showGroupHeadings ? (
                  <div
                    aria-hidden
                    data-slot="command-group-heading"
                    className={cn(
                      SECTION_HEADING,
                      "absolute left-0 flex h-8 w-full items-center px-2",
                    )}
                    style={{ top: group.top }}
                  >
                    {group.label}
                  </div>
                ) : null}
                {indices.map((at) => {
                  const item = items[at]!;
                  return (
                    <div
                      key={keyOf(item)}
                      id={rowId(at)}
                      role="option"
                      data-slot="command-item"
                      aria-selected={at === index}
                      aria-disabled={disabled}
                      data-selected={at === index || undefined}
                      data-disabled={disabled || undefined}
                      aria-setsize={items.length}
                      aria-posinset={at + 1}
                      onPointerMove={() => setActive(keyOf(item))}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (!disabled) onSelect(item);
                      }}
                      className={cn(
                        MENU_ROW,
                        MENU_ROW_STATE_CMDK,
                        "absolute left-0 h-8 min-h-8 w-full",
                      )}
                      style={{ top: layout.offsets[at] }}
                    >
                      {renderItem(item)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
