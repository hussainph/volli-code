import * as React from "react";
import "./grouped-tab-chip.css";
import { type IconComponent as Icon, UnlinkIcon, CloseIcon } from "@renderer/components/ui/icon";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import { ListRow } from "@renderer/components/ui/list-row";
import { Tab, tabStopIndex } from "@renderer/components/ui/tab-strip";
import {
  TabActionScope,
  TabDropdownDismissContext,
  type TabAction,
} from "@renderer/components/ui/tab-actions";
import { Button } from "@renderer/components/ui/button";

/** One pane of a group, as the strip draws it: its live stack and its front. */
export interface TabGroupPane {
  paneId: string;
  tabIds: readonly string[];
  activeTabId: string | null;
}

/** One tab group, as the top strip draws it — see `split-tab-groups.ts`. */
export interface TabGroup {
  id: string;
  title?: string;
  /** Reading order. A pane with no live tab draws no segment. */
  panes: readonly TabGroupPane[];
}

/** What the chip's menu says about one tab. */
export interface TabMenuLabel {
  label: string;
  icon: Icon;
  /** Optional vendor artwork, kept inside the existing icon box. */
  artwork?: React.ReactNode;
  /**
   * The second line that tells two like tabs apart — a Browser Tab's
   * host:port/path, a File tab's folder. `null` when the title is enough.
   */
  detail?: string | null;
  /** Existing tab liveness, when this kind carries one. */
  status?: string;
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

const EMPTY_ACTIONS: readonly TabAction[] = [];
const noActions = () => EMPTY_ACTIONS;

function MemberIcon({ description, className }: { description: TabMenuLabel; className: string }) {
  const { icon: Mark, artwork } = description;
  return artwork === undefined ? (
    <Mark className={className} />
  ) : (
    <span aria-hidden className={`inline-flex shrink-0 ${className}`}>
      {artwork}
    </span>
  );
}

/** The same two-line member rows serve hover inspection and the tab dropdown. */
function GroupMemberRows<T extends { id: string }>({
  tabs,
  describe,
  onSelect,
  actionsFor,
}: {
  tabs: readonly T[];
  describe(tab: T): TabMenuLabel;
  onSelect(tab: T): void;
  actionsFor(tab: T): readonly TabAction[];
}) {
  const dismiss = React.useContext(TabDropdownDismissContext);
  return tabs.map((tab) => {
    const description = describe(tab);
    const { label, detail, status } = description;
    return (
      <ListRow
        key={tab.id}
        data-tab-id={tab.id}
        density="two-line"
        leading={<MemberIcon description={description} className="size-4 shrink-0" />}
        primary={label}
        secondary={detail ?? status ?? undefined}
        trailing={
          status ? (
            <span className="text-label text-muted-foreground capitalize">{status}</span>
          ) : undefined
        }
        onActivate={() => {
          onSelect(tab);
          dismiss();
        }}
        actions={actionsFor(tab).map((action) => (
          <Button
            key={action.label}
            size="icon-sm"
            variant="ghost"
            aria-label={`${action.label}: ${label}`}
            title={action.label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              action.run();
              dismiss();
            }}
          >
            <action.icon className="size-3.5" />
          </Button>
        ))}
      />
    );
  });
}

function GroupedTabChip<T extends { id: string }>({
  item,
  active,
  tabStop,
  activeTabId,
  describe,
  onSelect,
  onUngroup,
  onClose,
  actionsFor,
}: {
  item: Extract<StripItem<T>, { group: TabGroup }>;
  active: boolean;
  tabStop: boolean;
  activeTabId: string;
  describe(tab: T): TabMenuLabel;
  onSelect(tab: T): void;
  onUngroup?(id: string): void;
  onClose?(tab: T): void;
  actionsFor(tab: T): readonly TabAction[];
}) {
  const [hoverOpen, setHoverOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const tabs = item.stacks.flatMap((stack) => stack.tabs);
  const front = item.segments.find((tab) => tab.id === activeTabId) ?? item.segments[0]!;
  const title = item.group.title ?? describe(item.segments[0]!).label;
  const groupActions: TabAction[] = onUngroup
    ? [{ label: "Ungroup", icon: UnlinkIcon, run: () => onUngroup(item.group.id) }]
    : [];
  const memberActions = (tab: T) => [
    ...actionsFor(tab),
    ...(onClose
      ? [{ label: "Close", icon: CloseIcon, run: () => onClose(tab), destructive: true }]
      : []),
  ];
  const rows = (
    <>
      <div className="truncate px-2 py-2 text-ui font-semibold">{title}</div>
      <GroupMemberRows
        tabs={tabs}
        describe={describe}
        onSelect={onSelect}
        actionsFor={memberActions}
      />
    </>
  );
  return (
    <HoverCard
      open={menuOpen ? false : hoverOpen}
      onOpenChange={(open) => setHoverOpen(!menuOpen && open)}
      openDelay={250}
      closeDelay={100}
    >
      <ContextMenu
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) setHoverOpen(false);
        }}
      >
        <HoverCardTrigger asChild>
          <ContextMenuTrigger asChild>
            <div
              data-slot="grouped-tab-chip"
              data-group-id={item.group.id}
              data-active={active}
              data-pair-target-id={front.id}
              className="relative flex shrink-0"
            >
              <TabActionScope actions={groupActions}>
                <Tab
                  label={title}
                  active={active}
                  tabStop={tabStop}
                  onActivate={() => onSelect(front)}
                  onClose={onClose ? () => tabs.forEach(onClose) : undefined}
                  leading={
                    <span className="group-icon-stack" aria-hidden>
                      {tabs.slice(0, 3).map((tab) => (
                        <span key={tab.id} className="group-icon-disc">
                          <MemberIcon description={describe(tab)} className="size-3.5" />
                        </span>
                      ))}
                      {tabs.length > 3 ? (
                        <span className="text-label tabular-nums">+{tabs.length - 3}</span>
                      ) : null}
                    </span>
                  }
                  actionsContent={rows}
                  onActionsOpenChange={(open) => {
                    setMenuOpen(open);
                    if (open) setHoverOpen(false);
                  }}
                />
              </TabActionScope>
            </div>
          </ContextMenuTrigger>
        </HoverCardTrigger>
        <ContextMenuContent data-slot="grouped-tab-menu" className="w-80">
          {tabs.map((tab) => {
            const { label, icon } = describe(tab);
            return (
              <React.Fragment key={tab.id}>
                <ContextMenuItem icon={icon} onSelect={() => onSelect(tab)}>
                  {label}
                </ContextMenuItem>
                {memberActions(tab).map((action) => (
                  <ContextMenuItem
                    key={action.label}
                    icon={action.icon}
                    aria-label={`${action.label}: ${label}`}
                    onSelect={() => action.run()}
                  >
                    {action.label}: {label}
                  </ContextMenuItem>
                ))}
              </React.Fragment>
            );
          })}
          {onUngroup ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem icon={UnlinkIcon} onSelect={() => onUngroup(item.group.id)}>
                Ungroup
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <HoverCardContent align="start" aria-label="Tab group items">
        {rows}
      </HoverCardContent>
    </HoverCard>
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
  onClose,
  actionsFor = noActions,
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
  onClose?: (tab: T) => void;
  actionsFor?: (tab: T) => readonly TabAction[];
  children: (tab: T, state: GroupedTabState) => React.ReactNode;
}) {
  const items = groupTabItems(tabs, groups);
  const ordered = items.flatMap((item) => (item.group === null ? [item.tab] : item.segments));
  const stop = tabStopIndex(
    ordered.length,
    ordered.findIndex((tab) => tab.id === activeTabId),
  );
  const stopId = stop === null ? undefined : ordered[stop]?.id;
  const target = (id: string) => ({
    "data-strip-tab-id": id,
    ...(edgeTargets ? { "data-pair-target-id": id } : {}),
  });
  return items.map((item) => {
    if (item.group === null) {
      const { tab } = item;
      return (
        <div key={tab.id} {...target(tab.id)} className="relative flex shrink-0">
          <TabActionScope actions={actionsFor(tab)}>
            {children(tab, {
              active: tab.id === activeTabId,
              tabStop: tab.id === stopId,
              grouped: false,
            })}
          </TabActionScope>
        </div>
      );
    }
    if (item.segments.length === 0) return null;
    const active = item.group.id === shownGroupId;
    return (
      <GroupedTabChip
        key={item.group.id}
        item={item}
        active={active}
        tabStop={item.segments.some((tab) => tab.id === stopId)}
        activeTabId={activeTabId}
        describe={describe}
        onSelect={onSelect}
        onUngroup={onUngroup}
        onClose={onClose}
        actionsFor={actionsFor}
      />
    );
  });
}
