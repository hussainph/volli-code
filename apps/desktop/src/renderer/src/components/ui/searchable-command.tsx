import * as React from "react";
import { SearchIcon } from "./icon";
import { COMMAND_SEARCH_FIELD, MENU_ROW, MENU_ROW_STATE_CMDK } from "./menu-classes";
import { cn } from "@renderer/lib/utils";

const ROW = 32;
const OVERSCAN = 5;
/** A windowed combobox using the shared menu/field recipes. Logical keyboard
 * order and active-descendant identity never depend on mounted registrations. */
export function SearchableCommand<T>({
  items,
  keyOf,
  renderItem,
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
  const first = Math.min(
    Math.max(0, items.length - 20),
    Math.max(0, Math.floor(top / ROW) - OVERSCAN),
  );
  const last = Math.min(items.length, first + 20);
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
    if (at * ROW < node.scrollTop) node.scrollTop = at * ROW;
    else if ((at + 1) * ROW > node.scrollTop + height) node.scrollTop = (at + 1) * ROW - height;
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
        <div role="presentation" style={{ height: items.length * ROW, position: "relative" }}>
          {mounted.map((at) => {
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
                className={cn(MENU_ROW, MENU_ROW_STATE_CMDK, "absolute left-0 h-8 min-h-8 w-full")}
                style={{ top: at * ROW }}
              >
                {renderItem(item)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
