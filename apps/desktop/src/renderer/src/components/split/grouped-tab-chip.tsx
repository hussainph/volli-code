import * as React from "react";
import "./grouped-tab-chip.css";
import type { Icon } from "@phosphor-icons/react";
import { LinkBreakIcon } from "@phosphor-icons/react/dist/csr/LinkBreak";

import { Popover, PopoverAnchor, PopoverContent } from "@renderer/components/ui/popover";
import { tabStopIndex, TabFaceProvider, type TabFace } from "@renderer/components/ui/tab-strip";

/** One pane of a group, as the strip draws it: its live stack and its front. */
export interface TabGroupPane {
  paneId: string;
  tabIds: readonly string[];
  activeTabId: string | null;
}

/** One tab group, as the top strip draws it — see `split-tab-groups.ts`. */
export interface TabGroup {
  id: string;
  /** Reading order. A pane with no live tab draws nothing. */
  panes: readonly TabGroupPane[];
}

/** What a group chip and its popover say about one tab. */
export interface TabMenuLabel {
  label: string;
  icon: Icon;
  /**
   * The second line that tells two like tabs apart — a Browser Tab's
   * host:port/path, a File tab's folder. `null` when the title is enough.
   */
  detail?: string | null;
  /**
   * The tab's state in words — a terminal's or a Session's `Idle`, `Working` —
   * where the strip already knows it. `null` for a tab that has no state.
   */
  status?: string | null;
}

type StripItem<T> =
  | { group: null; tab: T }
  | {
      group: TabGroup;
      /** Each pane's front, in pane order. */
      segments: readonly T[];
      /** Each pane's whole live stack, in pane order: the popover's rows. */
      stacks: readonly { pane: TabGroupPane; tabs: readonly T[] }[];
    };

/**
 * The top strip's items: an ordinary tab is itself; a group is ONE chip, placed
 * where the earliest of its tabs sits. A group's other tabs never also appear
 * as top-level tabs, and a group none of whose tabs is live draws nothing.
 */
export function groupTabItems<T extends { id: string }>(
  tabs: readonly T[],
  groups: readonly TabGroup[] = [],
): StripItem<T>[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const groupOf = new Map<string, TabGroup>();
  for (const group of groups) {
    for (const pane of group.panes) for (const id of pane.tabIds) groupOf.set(id, group);
  }
  const emitted = new Set<TabGroup>();
  return tabs.flatMap((tab): StripItem<T>[] => {
    const group = groupOf.get(tab.id);
    if (group === undefined) return [{ group: null, tab }];
    if (emitted.has(group)) return [];
    emitted.add(group);
    const stacks = group.panes.map((pane) => ({
      pane,
      tabs: pane.tabIds.flatMap((id) => {
        const found = byId.get(id);
        return found === undefined ? [] : [found];
      }),
    }));
    const segments = stacks.flatMap(({ pane, tabs: stack }) => {
      const front = stack.find((candidate) => candidate.id === pane.activeTabId) ?? stack[0];
      return front === undefined ? [] : [front];
    });
    return [{ group, segments, stacks }];
  });
}

/**
 * The tab a group chip draws: the one on screen while the group is shown, else
 * the first pane's front. It also holds the strip's roving tab stop for the group.
 */
function chipFront<T extends { id: string }>(
  item: Extract<StripItem<T>, { group: TabGroup }>,
  shown: boolean,
  activeTabId: string,
): T | undefined {
  if (shown) {
    for (const { tabs } of item.stacks) {
      const focused = tabs.find((tab) => tab.id === activeTabId);
      if (focused !== undefined) return focused;
    }
  }
  return item.segments[0];
}

/**
 * The members drawn BEHIND the front in the stacked glyph, nearest first: the
 * other panes' fronts, then whatever is stacked behind them. Two at most — a
 * deck of three cards says "more than one" as well as a deck of ten, and the
 * popover is where the count lives.
 */
function behindFront<T extends { id: string }>(
  item: Extract<StripItem<T>, { group: TabGroup }>,
  front: T,
): T[] {
  const others = [...item.segments, ...item.stacks.flatMap(({ tabs }) => tabs)];
  const seen = new Set([front.id]);
  const behind: T[] = [];
  for (const tab of others) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    behind.push(tab);
    if (behind.length === 2) break;
  }
  return behind;
}

/** Hover intent: long enough that sweeping across the strip opens nothing. */
const OPEN_DELAY_MS = 220;
/** Leave grace: the pointer's trip from the chip down into the popover. */
const CLOSE_GRACE_MS = 160;

/**
 * THE STACKED GLYPH (VC-1052) — the chip's one signal that it holds more than
 * one tab. The front tab's own glyph on a card, with up to two members' glyphs
 * on cards fanned out behind it, each further back: offset up and to the right,
 * smaller, dimmer. No count and no segments; the popover names every member.
 *
 * A press on the stack opens the popover rather than selecting the tab, which
 * is the pointer's way to the list without waiting out the hover.
 */
function GlyphStack({
  front,
  frontIcon: FrontIcon,
  behind,
  state,
  onOpen,
}: {
  /** The tab's own leading glyph, or `null` to draw its kind's icon. */
  front: React.ReactNode;
  frontIcon: Icon;
  /** Nearest first; drawn farthest first so the nearer card lands on top. */
  behind: readonly { id: string; icon: Icon }[];
  state: React.ReactNode | null;
  onOpen(): void;
}) {
  return (
    <span
      aria-hidden
      data-slot="tab-glyph-stack"
      data-depth={behind.length + 1}
      onClick={(event) => {
        // The tab's own click would select it; the stack is the list's door.
        event.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {behind
        .map(({ id, icon: BehindIcon }, index) => (
          <span
            key={id}
            data-slot="tab-glyph-card"
            data-layer={index + 1}
            className="bg-muted text-muted-foreground"
          >
            <BehindIcon className="size-3" />
          </span>
        ))
        .toReversed()}
      <span data-slot="tab-glyph-card" data-layer={0} className="bg-popover">
        {front ?? <FrontIcon className="size-3 text-muted-foreground" />}
        {state}
      </span>
    </span>
  );
}

/**
 * The hover popover's open state: a short intent delay on the way in, a grace
 * on the way out that the popover itself cancels, so the pointer can travel
 * from the chip into the list. `how` remembers whether the keyboard opened it,
 * which is the one case where focus moves into the list (and back out after).
 */
function useHoverOpen() {
  const [open, setOpen] = React.useState(false);
  const [how, setHow] = React.useState<"pointer" | "keyboard">("pointer");
  const timer = React.useRef<number | null>(null);
  const clear = React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  React.useEffect(() => clear, [clear]);
  return {
    open,
    how,
    show(via: "pointer" | "keyboard") {
      clear();
      setHow(via);
      setOpen(true);
    },
    hide() {
      clear();
      setOpen(false);
    },
    enter() {
      clear();
      if (open) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setHow("pointer");
        setOpen(true);
      }, OPEN_DELAY_MS);
    },
    leave() {
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setOpen(false);
      }, CLOSE_GRACE_MS);
    },
    stay: clear,
  };
}

/** A mouse pointer with no button down: a hover, not a drag passing over. */
function hovering(event: React.PointerEvent): boolean {
  return event.pointerType === "mouse" && event.buttons === 0;
}

/**
 * One chip for a whole group (VC-1052, owner reference): the group's front tab,
 * drawn the way every other tab on the strip is drawn, with a stacked glyph in
 * place of its own — the only mark that it holds more. Selecting it shows the
 * group; a shown group's panes draw their own strips below, so every member
 * stays one press away there too.
 *
 * Hovering it opens a glass popover listing the whole group: a header naming
 * the front tab, then one two-line row per tab in pane order — glyph, title,
 * the detail that tells like tabs apart, and the tab's state when it has one.
 * Choosing a row brings that tab to the front of its pane. Ungroup sits behind
 * a separator at the foot. The same popover opens from a press on the stack, a
 * press on a chip whose group is already showing, a right-click, and Enter,
 * Space or ArrowDown on the focused chip, for touch and the keyboard.
 */
function GroupedTabChip<T extends { id: string }>({
  item,
  front,
  active,
  activeTabId,
  edgeTarget,
  describe,
  onSelect,
  onUngroup,
  children,
}: {
  item: Extract<StripItem<T>, { group: TabGroup }>;
  front: T;
  active: boolean;
  /** The surface's active tab: the one on screen, if this group is shown. */
  activeTabId: string;
  edgeTarget: boolean;
  describe(tab: T): TabMenuLabel;
  onSelect(tab: T): void;
  onUngroup?(groupId: string): void;
  children: React.ReactNode;
}) {
  const hover = useHoverOpen();
  const chipRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const head = describe(front);
  const behind = behindFront(item, front).map((tab) => ({ id: tab.id, icon: describe(tab).icon }));
  const face: TabFace = {
    leading: (own, state) => (
      <GlyphStack
        front={own}
        frontIcon={head.icon}
        behind={behind}
        state={state}
        onOpen={() => hover.show("pointer")}
      />
    ),
    hint: head.detail,
    attributes: {
      "aria-haspopup": "menu",
      "aria-expanded": hover.open,
      "aria-controls": hover.open ? listId : undefined,
    },
  };
  // Closing hands focus back to the chip's tab when focus was in the list —
  // synchronously, before the list unmounts and leaves it on the document.
  const close = () => {
    if (listRef.current?.contains(document.activeElement)) {
      chipRef.current?.querySelector<HTMLElement>('[role="tab"]')?.focus();
    }
    hover.hide();
  };
  return (
    <Popover open={hover.open} onOpenChange={(next) => (next ? hover.show("pointer") : close())}>
      <PopoverAnchor asChild>
        <div
          ref={chipRef}
          data-slot="grouped-tab-chip"
          data-group-id={item.group.id}
          data-active={active}
          {...(edgeTarget ? { "data-pair-target-id": front.id } : {})}
          className="relative flex shrink-0"
          onPointerEnter={(event) => {
            if (hovering(event)) hover.enter();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") hover.leave();
          }}
          // A drag starting on the chip is no hover: the list must not open
          // under a tab being carried to an edge.
          onPointerDown={hover.stay}
          // After the tab's own click has selected it: a press on a chip that
          // was ALREADY showing its group has nothing left to show, so it opens
          // the list instead — the touch path to it.
          onClick={() => {
            if (active) hover.show("pointer");
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            hover.show("pointer");
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget.querySelector('[role="tab"]')) return;
            if (
              event.key === "ArrowDown" ||
              ((event.key === "Enter" || event.key === " ") && active)
            ) {
              event.preventDefault();
              hover.show("keyboard");
            }
          }}
        >
          <TabFaceProvider face={face}>{children}</TabFaceProvider>
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={listRef}
        id={listId}
        role="menu"
        aria-label={head.label}
        data-slot="grouped-tab-popover"
        align="start"
        sideOffset={4}
        // Hover never takes focus: the pointer passing over the strip must not
        // pull the caret out of a terminal. The keyboard does, both ways.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (hover.how === "keyboard") {
            listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
          }
        }}
        // A press on the chip is the chip's own business (select, or open the
        // list); it is not the "outside" that dismisses the list.
        onInteractOutside={(event) => {
          if (event.target instanceof Node && chipRef.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
        // `close` already put focus back where it belongs, if it was in here.
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={hover.stay}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") hover.leave();
        }}
        onKeyDown={(event) => moveRowFocus(event)}
        className="w-60 rounded-xl bg-popover/85 p-1 backdrop-blur-lg"
      >
        <div
          aria-hidden
          data-slot="grouped-tab-popover-header"
          className="truncate px-2 pt-1 pb-1.5 text-ui font-semibold text-muted-foreground"
        >
          {head.detail ? `${head.label} ${head.detail}` : head.label}
        </div>
        {item.stacks.map(({ pane, tabs }, paneIndex) =>
          tabs.map((tab) => {
            const { label, icon: RowIcon, detail, status } = describe(tab);
            const showing = active && tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-slot="grouped-tab-row"
                data-tab-id={tab.id}
                // Not drawn (no pane badges, no checks): which pane a row is in,
                // and whether it is that pane's front, for probes reading the list.
                data-pane={paneIndex + 1}
                data-front={tab.id === (pane.activeTabId ?? tabs[0]?.id)}
                aria-current={showing ? "true" : undefined}
                aria-label={[label, detail, status].filter(Boolean).join(", ")}
                onClick={() => {
                  close();
                  onSelect(tab);
                }}
                className="grid w-full cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 py-1.5 text-left outline-none select-none hover:bg-accent/60 focus-visible:bg-accent/60"
              >
                <RowIcon aria-hidden className="size-3.5 text-muted-foreground" />
                <span
                  data-slot="grouped-tab-row-title"
                  className="truncate text-ui font-medium text-foreground"
                >
                  {label}
                </span>
                <span className="text-label text-muted-foreground">{status ?? null}</span>
                {detail ? (
                  <span className="col-start-2 col-end-4 truncate text-label text-muted-foreground">
                    {detail}
                  </span>
                ) : null}
              </button>
            );
          }),
        )}
        {onUngroup === undefined ? null : (
          <>
            <div role="separator" className="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-slot="grouped-tab-ungroup"
              onClick={() => {
                close();
                onUngroup(item.group.id);
              }}
              className="flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1 text-left text-ui text-muted-foreground outline-none select-none hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:text-foreground"
            >
              <LinkBreakIcon aria-hidden className="size-3.5" />
              Ungroup
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** ArrowUp/ArrowDown/Home/End across the popover's rows, wrapping. */
function moveRowFocus(event: React.KeyboardEvent<HTMLElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  if (rows.length === 0) return;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % rows.length
      : event.key === "ArrowUp"
        ? (at - 1 + rows.length) % rows.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

/** What a tab renderer is told about the tab it draws. */
export interface GroupedTabState {
  active: boolean;
  tabStop: boolean;
  /** Drawn as a group chip's front: no drag of its own, no menu of its own. */
  grouped: boolean;
}

/**
 * The tabs of one strip, ordinary ones and group chips alike, shared by Home's
 * and a Ticket view's strips. Pass `groups` only for the TOP strip; a group
 * pane's own strip draws its stack as plain tabs.
 *
 * `edgeTargets` marks each top-level item as a drop target for grouping by
 * edge (`split-dnd.tsx` reads `data-pair-target-id`): a tab dropped on a tab's
 * left or right quarter groups beside it. A pane strip does not opt in — a drop
 * on its tabs joins that pane's stack.
 */
export function GroupedTabList<T extends { id: string }>({
  tabs,
  groups,
  activeTabId,
  shownGroupId = null,
  edgeTargets = false,
  describe,
  onSelect,
  onUngroup,
  children,
}: {
  tabs: readonly T[];
  groups?: readonly TabGroup[];
  activeTabId: string;
  /** The group on screen, whose chip is drawn active. */
  shownGroupId?: string | null;
  edgeTargets?: boolean;
  describe(tab: T): TabMenuLabel;
  onSelect(tab: T): void;
  onUngroup?: (groupId: string) => void;
  children: (tab: T, state: GroupedTabState) => React.ReactNode;
}) {
  const items = groupTabItems(tabs, groups).map((item) =>
    item.group === null
      ? { item, front: item.tab }
      : { item, front: chipFront(item, item.group.id === shownGroupId, activeTabId) },
  );
  const ordered = items.flatMap(({ front }) => (front === undefined ? [] : [front]));
  const stop = tabStopIndex(
    ordered.length,
    ordered.findIndex((tab) => tab.id === activeTabId),
  );
  const stopId = stop === null ? undefined : ordered[stop]?.id;
  return items.map(({ item, front }) => {
    if (item.group === null) {
      const { tab } = item;
      return (
        <div
          key={tab.id}
          {...(edgeTargets ? { "data-pair-target-id": tab.id } : {})}
          className="relative flex shrink-0"
        >
          {children(tab, {
            active: tab.id === activeTabId,
            tabStop: tab.id === stopId,
            grouped: false,
          })}
        </div>
      );
    }
    if (front === undefined) return null;
    const active = item.group.id === shownGroupId;
    return (
      <GroupedTabChip
        key={item.group.id}
        item={item}
        front={front}
        active={active}
        activeTabId={activeTabId}
        edgeTarget={edgeTargets}
        describe={describe}
        onSelect={onSelect}
        onUngroup={onUngroup}
      >
        {children(front, { active, tabStop: front.id === stopId, grouped: true })}
      </GroupedTabChip>
    );
  });
}
