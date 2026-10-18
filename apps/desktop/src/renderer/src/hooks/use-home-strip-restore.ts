/**
 * Home's relaunch: which tab is in front, putting the persisted strip back, and
 * keeping the record that strip is put back FROM (VC-54, VC-105).
 *
 * The decisions are pure and live in `home-tabs.ts` (`resolveHomeTabs`,
 * `homeTabOrderReceipt`). What lives here is their timing, which is the part a
 * pure function cannot state: when a project counts as restored, which record
 * the restore reads, and when the strip may be written back. Each of those is
 * an ordering between renders and effects, and each one wrong is a Session
 * silently lost or silently reopened.
 */
import * as React from "react";
import { EMPTY_TAB_ORDER, type TabOrder } from "@volli/shared";

import {
  homeTabOrderReceipt,
  resolveHomeTabs,
  type HomeTabResolution,
} from "@renderer/components/home/home-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

export interface HomeStripRestoreInput {
  projectId: string | null;
  /** The project's open tabs in composed order. The Board is not among them. */
  tabIds: readonly string[];
  /** The strip as drawn, Board first: `arrangeTabs` over `tabIds`. */
  orderedTabIds: readonly string[];
  /** Tabs on screen that must never reach the record: an empty Chat Draft's. */
  emptyTabIds: ReadonlySet<string>;
  /** The tab the record puts in front (or an empty Draft's renderer-only focus). */
  recorded: string;
  /** `homeTabOrder` off the workspace record, live. */
  tabOrder: TabOrder;
  /** The terminal container's own active session id, or null. */
  containerActive: string | null;
  /** The project's durable ticketless chat Session ids, or `undefined` before the first read. */
  durableChatIds: readonly string[] | undefined;
  /** Whether main's Browser Tab registry has answered for this project. */
  browserTabsHydrated: boolean;
  /** `recordHomeTabOrder` — injected for the reason `useHomeTabReceipt` takes its writer. */
  recordTabOrder(projectId: string, order: readonly string[]): void;
}

export function useHomeStripRestore(input: HomeStripRestoreInput): HomeTabResolution {
  const {
    projectId,
    tabIds,
    orderedTabIds,
    emptyTabIds,
    recorded,
    tabOrder,
    containerActive,
    durableChatIds,
    browserTabsHydrated,
    recordTabOrder,
  } = input;

  /**
   * Projects whose strip has been restored once in this app run. Restoration is
   * a boot-time act: after it, a recorded id that names nothing is a tab the
   * user CLOSED, and adopting it back would reopen the tab they just shut.
   * A ref rather than state — nothing renders from it, and the render that
   * consults it is always followed by one the store triggers.
   */
  const hydratedRef = React.useRef(new Set<string>());

  /**
   * The strip each project is restored FROM: its `homeTabOrder` exactly as this
   * run first read it.
   *
   * Captured once rather than read live because the live record may move
   * before the restore it feeds has finished: a drag while the listing is still
   * in flight rewrites the arrangement to the tabs the strip has so far
   * (`movedTabOrder`), and a restore that read it afterwards would quietly drop
   * every Session still waiting to come back. A ref for `hydratedRef`'s reason.
   */
  const restoreOrdersRef = React.useRef(new Map<string, TabOrder>());
  if (projectId !== null && !restoreOrdersRef.current.has(projectId)) {
    restoreOrdersRef.current.set(projectId, tabOrder);
  }
  const recordedOrder =
    (projectId === null ? undefined : restoreOrdersRef.current.get(projectId)) ?? EMPTY_TAB_ORDER;
  const hydrated = projectId === null || hydratedRef.current.has(projectId);

  // Memoized so an adopt's Session list keeps its identity across renders that
  // change nothing it was derived from — it is the restore effect's dependency.
  const resolution = React.useMemo(
    () =>
      resolveHomeTabs({
        tabIds,
        recorded,
        recordedOrder,
        containerActive,
        durableChatIds,
        browserTabsHydrated,
        hydrated,
      }),
    [
      tabIds,
      recorded,
      recordedOrder,
      containerActive,
      durableChatIds,
      browserTabsHydrated,
      hydrated,
    ],
  );
  const restoreKind = resolution.restore.kind;
  const adoptSessionIds =
    resolution.restore.kind === "adopt" ? resolution.restore.sessionIds : null;

  /**
   * Put the persisted strip back, or accept that what it named is gone.
   *
   * Same adopt/wait/fallback discipline `ticket-detail.tsx` runs for a ticket's
   * own persisted tab, looped over the whole strip, and for the same reason: a
   * chat Session survives a relaunch, so a `chat:<id>` that names no open tab
   * is not evidence of anything until the durable listing has answered.
   * Adopted in strip order, so the chats arrive in the order the arrangement
   * then sorts them into anyway.
   *
   * The restore is finished when the resolution SETTLES, not when it adopts:
   * the render after an adopt finds those tabs open, and it is that render which
   * decides the tab in front — the recorded one, or the Board when it is gone.
   */
  React.useEffect(() => {
    if (projectId === null || restoreKind === "pending") return;
    if (adoptSessionIds === null) {
      hydratedRef.current.add(projectId);
      return;
    }
    const chat = useChatSessionsStore.getState();
    for (const sessionId of adoptSessionIds) {
      chat.adoptChatSession(sessionId);
      chat.openChatTab(projectId, sessionId);
    }
  }, [projectId, restoreKind, adoptSessionIds]);

  /**
   * The strip written back as its own record, which is what the next relaunch
   * reopens. A fixed point — the strip as drawn, fed back as its own overlay —
   * so recording it moves nothing. Held back until the restore has settled and
   * main's Browser Tab registry has answered: before then, a tab missing from
   * the strip may simply not have arrived yet.
   *
   * Declared after the restore effect, so the commit that settles the restore
   * marks the project restored before this reads it.
   */
  React.useEffect(() => {
    if (projectId === null) return;
    const order = homeTabOrderReceipt({
      drawn: orderedTabIds,
      transient: emptyTabIds,
      restored:
        restoreKind === "settled" && hydratedRef.current.has(projectId) && browserTabsHydrated,
    });
    if (order !== null) recordTabOrder(projectId, order);
  }, [browserTabsHydrated, emptyTabIds, orderedTabIds, projectId, recordTabOrder, restoreKind]);

  return resolution;
}
