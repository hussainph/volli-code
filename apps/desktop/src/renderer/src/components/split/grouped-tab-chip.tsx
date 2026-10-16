import * as React from "react";
import "./grouped-tab-chip.css";
import { LinkBreakIcon } from "@phosphor-icons/react/dist/csr/LinkBreak";

import { Button } from "@renderer/components/ui/button";
import { tabStopIndex } from "@renderer/components/ui/tab-strip";
import { cn } from "@renderer/lib/utils";

export interface TabPair {
  id: string;
  tabIds: readonly [string, string];
}

type TabGroup<T> = { pair: TabPair; tabs: readonly [T, T] } | { pair: null; tabs: readonly [T] };

/** Only complete, disjoint pairs in this strip group; stale/cross-pane pairs stay singles. */
export function groupTabItems<T extends { id: string }>(
  tabs: readonly T[],
  pairs: readonly TabPair[] = [],
): TabGroup<T>[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const byMember = new Map<string, TabGroup<T>>();
  for (const pair of pairs) {
    const [firstId, secondId] = pair.tabIds;
    const first = byId.get(firstId);
    const second = byId.get(secondId);
    if (
      first === undefined ||
      second === undefined ||
      firstId === secondId ||
      byMember.has(firstId) ||
      byMember.has(secondId)
    )
      continue;
    const group: TabGroup<T> = { pair, tabs: [first, second] };
    byMember.set(firstId, group);
    byMember.set(secondId, group);
  }
  const emitted = new Set<TabGroup<T>>();
  return tabs.flatMap((tab) => {
    const group = byMember.get(tab.id);
    if (group === undefined) return [{ pair: null, tabs: [tab] } as TabGroup<T>];
    if (emitted.has(group)) return [];
    emitted.add(group);
    return [group];
  });
}

/** One silhouette, two existing tabs: each keeps its own menu, close, rename and drag. */
function GroupedTabChip({
  pair,
  active,
  onUnpair,
  children,
}: {
  pair: TabPair;
  active: boolean;
  onUnpair?: (pairId: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Paired tabs"
      data-slot="grouped-tab-chip"
      data-pair-id={pair.id}
      data-active={active}
      className={cn(
        "flex shrink-0 items-center rounded-t-lg border border-b-0 border-border",
        // The group owns the folder outline; members retain their tab hit targets.
        "[&_[data-slot=tab]]:mb-0 [&_[data-slot=tab]]:rounded-none [&_[data-slot=tab]]:bg-transparent [&_[data-slot=tab]]:before:hidden [&_[data-slot=tab]]:after:hidden",
        active ? "-mb-px bg-background" : "bg-rail",
      )}
    >
      {children}
      {onUnpair !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mx-1 shrink-0 text-muted-foreground"
          aria-label="Unpair tabs"
          title="Unpair tabs"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onUnpair(pair.id);
          }}
        >
          <LinkBreakIcon aria-hidden weight="bold" className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

/** Shared grouping and selection for Home and Ticket strips, including their pane strips. */
export function GroupedTabList<T extends { id: string }>({
  tabs,
  pairs,
  activeTabId,
  onUnpair,
  children,
}: {
  tabs: readonly T[];
  pairs?: readonly TabPair[];
  activeTabId: string;
  onUnpair?: (pairId: string) => void;
  children: (
    tab: T,
    state: { active: boolean; tabStop: boolean; paired: boolean },
  ) => React.ReactNode;
}) {
  const groups = groupTabItems(tabs, pairs);
  const ordered = groups.flatMap((group) => group.tabs);
  const stop = tabStopIndex(
    ordered.length,
    ordered.findIndex((tab) => tab.id === activeTabId),
  );
  const stopId = stop === null ? undefined : ordered[stop]?.id;
  return groups.map((group) => {
    if (group.pair === null) {
      const tab = group.tabs[0];
      return (
        <div key={tab.id} data-pair-target-id={tab.id} className="relative flex shrink-0">
          {children(tab, {
            active: tab.id === activeTabId,
            tabStop: tab.id === stopId,
            paired: false,
          })}
        </div>
      );
    }
    const active = group.pair.tabIds.includes(activeTabId);
    return (
      <GroupedTabChip key={group.pair.id} pair={group.pair} active={active} onUnpair={onUnpair}>
        {group.tabs.map((tab, index) => (
          <div
            key={tab.id}
            data-slot="grouped-tab-member"
            data-pair-target-id={tab.id}
            data-focused={active && tab.id === activeTabId}
            className={cn("relative flex items-center", index === 1 && "border-l border-border")}
          >
            {children(tab, { active, tabStop: tab.id === stopId, paired: true })}
            {active && tab.id === activeTabId ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-primary"
              />
            ) : null}
          </div>
        ))}
      </GroupedTabChip>
    );
  });
}
