import * as React from "react";
import "./grouped-tab-chip.css";
import type { Icon } from "@phosphor-icons/react";
import { LinkBreakIcon } from "@phosphor-icons/react/dist/csr/LinkBreak";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { tabStopIndex } from "@renderer/components/ui/tab-strip";
import { cn } from "@renderer/lib/utils";

/** One pane of a group, as the strip draws it: its live stack and its front. */
export interface TabGroupPane {
  paneId: string;
  tabIds: readonly string[];
  activeTabId: string | null;
}

/** One tab group, as the top strip draws it — see `split-tab-groups.ts`. */
export interface TabGroup {
  id: string;
  /** Reading order. A pane with no live tab draws no segment. */
  panes: readonly TabGroupPane[];
}

/** What the chip's menu says about one tab. */
export interface TabMenuLabel {
  label: string;
  icon: Icon;
  /**
   * The second line that tells two like tabs apart — a Browser Tab's
   * host:port/path, a File tab's folder. `null` when the title is enough.
   */
  detail?: string | null;
}

type StripItem<T> =
  | { group: null; tab: T }
  | {
      group: TabGroup;
      /** Each pane's front, in pane order: the chip's segments. */
      segments: readonly T[];
      /** Each pane's whole live stack, in pane order: the chip's menu. */
      stacks: readonly { pane: TabGroupPane; tabs: readonly T[] }[];
    };

/**
 * The top strip's items: an ordinary tab is itself; a group is ONE chip, placed
 * where the earliest of its tabs sits, drawing each pane's front. A group's
 * other tabs never also appear as top-level tabs, and a group none of whose
 * tabs is live draws nothing at all.
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
 * One chip for a whole group: each pane's front tab is a segment (a click
 * selects that pane), and the right-click menu lists every tab of the group,
 * pane by pane — choosing one brings it to the front of its
 * pane — with Ungroup to dissolve the group, every tab staying open.
 *
 * The menu (VC-614, owner feedback) is one row per tab, in pane order: its
 * glyph, its title over the line that tells like tabs apart (a page's
 * host:port/path, a file's folder), and its pane's number at the trailing edge.
 * The tab on screen is emphasised and a tab stacked behind its pane's front is
 * muted; no checkmarks, which on a group of single-tab panes would mark every
 * row and say nothing.
 *
 * A group that is NOT on screen draws SUMMARIZED (`compact`): the first pane's
 * front keeps a shortened label and the other panes fold into a `+n` count, so
 * a three- or four-pane group stops costing three or four full tabs of strip.
 * The count's tooltip names what it folds, the chip's menu lists every tab,
 * and the chip opens out again once selected.
 */
function GroupedTabChip<T extends { id: string }>({
  item,
  active,
  activeTabId,
  compact,
  describe,
  onSelect,
  onUngroup,
  children,
}: {
  item: Extract<StripItem<T>, { group: TabGroup }>;
  active: boolean;
  /** The surface's active tab: the one on screen, if this group is shown. */
  activeTabId: string;
  /** Summarized: see `grouped-tab-chip.css`. */
  compact: boolean;
  describe(tab: T): TabMenuLabel;
  onSelect(tab: T): void;
  onUngroup?(groupId: string): void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="group"
          aria-label="Tab group"
          data-slot="grouped-tab-chip"
          data-group-id={item.group.id}
          data-active={active}
          data-compact={compact}
          className={cn(
            "flex shrink-0 items-center rounded-t-lg border border-b-0 border-border",
            // The group owns the folder outline; members retain their tab hit targets.
            "[&_[data-slot=tab]]:mb-0 [&_[data-slot=tab]]:rounded-none [&_[data-slot=tab]]:bg-transparent [&_[data-slot=tab]]:before:hidden [&_[data-slot=tab]]:after:hidden",
            active ? "-mb-px bg-background" : "bg-rail",
          )}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-slot="grouped-tab-menu" className="w-72">
        <div
          aria-hidden
          className="flex items-center justify-between px-2 pt-1 pb-1.5 text-label text-muted-foreground"
        >
          <span>Tab group</span>
          <span className="tabular-nums">{`${item.stacks.filter((stack) => stack.tabs.length > 0).length} panes`}</span>
        </div>
        {item.stacks.map(({ pane, tabs }, index) =>
          tabs.map((tab) => {
            const { label, icon, detail } = describe(tab);
            const front = tab.id === (pane.activeTabId ?? tabs[0]?.id);
            const showing = active && tab.id === activeTabId;
            return (
              <ContextMenuItem
                key={tab.id}
                icon={icon}
                data-pane={index + 1}
                data-front={front}
                data-showing={showing}
                aria-label={`${label}, pane ${index + 1}${showing ? ", showing" : front ? "" : ", behind"}`}
                onSelect={() => onSelect(tab)}
                className={cn(
                  "py-1.5",
                  showing && "font-medium [&>svg]:text-foreground",
                  !front && "text-muted-foreground",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{label}</span>
                  {detail ? (
                    <span className="truncate text-label font-normal text-muted-foreground">
                      {detail}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border text-label font-normal text-muted-foreground tabular-nums"
                >
                  {index + 1}
                </span>
              </ContextMenuItem>
            );
          }),
        )}
        {onUngroup === undefined ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem icon={LinkBreakIcon} onSelect={() => onUngroup(item.group.id)}>
              Ungroup
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The `+n` a summarized chip ends with: how many other panes it folds, their
 * fronts named in the tooltip. A press shows the group, the same as pressing
 * its first segment. Out of the tab order — the segments carry the strip's
 * roving focus, and the chip's menu reaches every tab by keyboard.
 */
function GroupMoreCount({ hidden, onSelect }: { hidden: readonly string[]; onSelect(): void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-slot="grouped-tab-more"
      aria-label={`${hidden.length} more in this group: ${hidden.join(", ")}`}
      title={hidden.join("\n")}
      onClick={onSelect}
      className="mr-1.5 flex h-5 shrink-0 cursor-default items-center rounded-sm px-1 text-ui text-muted-foreground tabular-nums outline-none hover:bg-accent/50 hover:text-foreground"
    >
      +{hidden.length}
    </button>
  );
}

/** What a tab renderer is told about the tab it draws. */
export interface GroupedTabState {
  active: boolean;
  tabStop: boolean;
  /** Drawn as a group chip's segment: no drag of its own, no menu of its own. */
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
  const items = groupTabItems(tabs, groups);
  const ordered = items.flatMap((item) => (item.group === null ? [item.tab] : item.segments));
  const stop = tabStopIndex(
    ordered.length,
    ordered.findIndex((tab) => tab.id === activeTabId),
  );
  const stopId = stop === null ? undefined : ordered[stop]?.id;
  const target = (id: string) => (edgeTargets ? { "data-pair-target-id": id } : {});
  return items.map((item) => {
    if (item.group === null) {
      const { tab } = item;
      return (
        <div key={tab.id} {...target(tab.id)} className="relative flex shrink-0">
          {children(tab, {
            active: tab.id === activeTabId,
            tabStop: tab.id === stopId,
            grouped: false,
          })}
        </div>
      );
    }
    if (item.segments.length === 0) return null;
    const active = item.group.id === shownGroupId;
    const compact = !active && item.segments.length > 1;
    return (
      <GroupedTabChip
        key={item.group.id}
        item={item}
        active={active}
        activeTabId={activeTabId}
        compact={compact}
        describe={describe}
        onSelect={onSelect}
        onUngroup={onUngroup}
      >
        {item.segments.map((tab, index) => (
          <div
            key={tab.id}
            data-slot="grouped-tab-member"
            {...target(tab.id)}
            data-focused={active && tab.id === activeTabId}
            className={cn("relative flex items-center", index > 0 && "border-l border-border")}
          >
            {children(tab, { active, tabStop: tab.id === stopId, grouped: true })}
            {active && tab.id === activeTabId ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-primary"
              />
            ) : null}
          </div>
        ))}
        {compact ? (
          <GroupMoreCount
            hidden={item.segments.slice(1).map((tab) => describe(tab).label)}
            onSelect={() => onSelect(item.segments[0]!)}
          />
        ) : null}
      </GroupedTabChip>
    );
  });
}
