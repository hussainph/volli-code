/**
 * The Browser Tab feed for the Activity Island (VC-268).
 *
 * One of the island's four feeds, beside `use-island-plan.ts`: the slice of
 * the model that is the tabs cluster, the two verbs its card can call, and the
 * announcements the now channel makes about them. `useActivityIsland` spreads
 * it; nothing else reads it.
 *
 * It is built on {@link useChatBrowserTabs}, which moved here from
 * `chat-plane.tsx` rather than being copied: the plane still calls it for the
 * pinned preview and the transcript card's host, and there is exactly one
 * account of which tabs this chat answers for. Null where there is no bridge
 * — the UI lab — and the feed is simply empty there.
 *
 * WHAT IS PROJECTED, and the two rules that are not obvious:
 *
 *  • OWNED OR A CHILD'S. `sessionBrowserTabs` already says this: a parent that
 *    started a Session is answerable for the tabs it opened, and never for a
 *    sibling's or a person's. Children are read off the listing's provenance.
 *  • HOST FIRST. The island names a tab by its host, so the fallback chain is
 *    hostname → title → the new-tab name — the reverse of
 *    `browserTabDisplayTitle`, which the strip uses and which puts the title
 *    first. The start-page guard is shared: a brand-new tab is "New Tab", never
 *    the raw `about:blank` the address bar deliberately hides.
 *
 * HELD TABS (VC-239) are a different fact from ownership. `heldBy` says who is
 * driving a tab right now; the strip dot and the holder pill already show it,
 * and the cluster does not repeat it in v1. When it does, this is the
 * projection site: read `tab.heldBy` beside `ownerSessionId` below.
 *
 * THE NOW CHANNEL IS A DIFF. The store is a live push cache with no history,
 * so "opened", "loaded", "failed" and "closed" are not events it carries —
 * they are what changed between what this hook saw last render and what it
 * sees now, held in a ref. Two traps, both answered in `useEffect` below: the
 * first render after attach must not announce every tab that already existed,
 * and main bumps a tab's generation when a navigation STARTS, so "loaded" is
 * the generation having advanced AND the load having settled.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";

import { errorMessage } from "@volli/shared";
import type {
  ActivityIslandActions,
  ActivityIslandModel,
  IslandTab,
} from "@volli/session-presentation";

import { isBrowserStartUrl } from "../../../browser-start-page";
import type { BrowserTabState, Result } from "../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import type { BrowserCardHost } from "@renderer/components/browser/browser-tab-card";
import { toastError } from "@renderer/lib/toast";
import {
  BROWSER_NEW_TAB_TITLE,
  browserTabOwnerLabel,
  previewedBrowserTab,
  sessionBrowserTabs,
  useBrowserTabsStore,
} from "@renderer/stores/browser-tabs";
import {
  childSessionIds,
  sessionTitleOf,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import type { IslandFlashPush } from "./use-island-flash";

/* ------------------------------------------------------------- the plumbing */

/**
 * What this chat knows about the Browser Tabs its Sessions hold (VC-238): the
 * inventory the island counts, the one tab pinned as its preview, and the host
 * a row's card needs to act. Null where there is no bridge — the UI lab — so
 * every browser surface in the chat simply does not exist there.
 *
 * Children are read off the project listing's provenance, the same fact the
 * sidebar's mark draws; a child's tabs count here because a parent that
 * started a Session is answerable for the tabs it opened.
 */
export interface ChatBrowserTabs {
  api: BrowserApi;
  tabs: BrowserTabState[];
  preview: BrowserTabState | null;
  sessionTitle(sessionId: string): string | null;
  ownerLabel(tab: BrowserTabState): string;
  cardHost: BrowserCardHost;
}

export function useChatBrowserTabs(sessionId: string, projectId: string): ChatBrowserTabs | null {
  const api = typeof window === "undefined" ? undefined : window.api?.browser;
  const rows = useProjectSessionsStore((state) => state.byProject[projectId]);
  const children = React.useMemo(() => childSessionIds(rows, sessionId), [rows, sessionId]);
  const tabs = useBrowserTabsStore(
    useShallow((state) => sessionBrowserTabs(state.byId, sessionId, children)),
  );
  const preview = useBrowserTabsStore((state) => previewedBrowserTab(state.byId, sessionId));
  const sessionTitle = React.useCallback((id: string) => sessionTitleOf(rows, id), [rows]);
  const cardHost = React.useMemo(
    () => (api === undefined ? null : { sessionId, api, sessionTitle }),
    [api, sessionId, sessionTitle],
  );
  if (api === undefined || cardHost === null) return null;
  return {
    api,
    tabs,
    preview,
    sessionTitle,
    ownerLabel: (tab) => browserTabOwnerLabel(tab, sessionId, sessionTitle),
    cardHost,
  };
}

/* ------------------------------------------------------------ the projection */

/**
 * What the island names a tab by: hostname, then title, then the new-tab
 * name. The start page is checked first for the same reason
 * `browserTabDisplayTitle` checks it: `about:blank` has no hostname and no
 * title, and the scheme is the one string the address bar hides.
 */
export function islandTabHost(tab: Pick<BrowserTabState, "url" | "title">): string {
  if (isBrowserStartUrl(tab.url)) return BROWSER_NEW_TAB_TITLE;
  const host = hostnameOf(tab.url);
  if (host !== null) return host;
  const title = tab.title.trim();
  return title.length > 0 ? title : BROWSER_NEW_TAB_TITLE;
}

function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * One registry row as the island sees it. `promoted` is the pill's boolean
 * and `surface` is the card's answer to WHERE — both derived from the one
 * `presentation` fact so they cannot disagree. `owner` reuses the chat's
 * own owner vocabulary for a child (its title, or "another Session" for one
 * the listing cannot name), and says nothing for this Session's own tab.
 */
export function islandTabOf(
  tab: BrowserTabState,
  sessionId: string,
  titleOf: (sessionId: string) => string | null,
): IslandTab {
  return {
    id: tab.tabId,
    host: islandTabHost(tab),
    state: tab.loading ? "loading" : "ready",
    promoted: tab.presentation !== "headless",
    surface: tab.presentation === "headless" ? null : tab.presentation,
    owner: tab.ownerSessionId === sessionId ? null : browserTabOwnerLabel(tab, sessionId, titleOf),
  };
}

/* ------------------------------------------------------------------ the feed */

/**
 * The feed's shape, which every feed shares (see `use-activity-island.ts`):
 * its slice of the model under `model`, its verbs under `actions`, each ready
 * to be spread over the empty island and the unwired verbs.
 */
export interface IslandTabsFeed {
  model: Pick<ActivityIslandModel, "tabs">;
  actions: Pick<ActivityIslandActions, "closeTab" | "promoteTab">;
}

const NO_TABS: readonly IslandTab[] = [];

/**
 * What the diff remembers about each tab between renders. `settledGeneration`
 * is the last generation announced as loaded (or failed), so a load that
 * settles at the same generation — a reload of a page already announced, a
 * subframe — is not announced again.
 */
interface SeenTab {
  tab: BrowserTabState;
  settledGeneration: number;
}

function seenOf(tab: BrowserTabState): SeenTab {
  // A tab first seen mid-load has a page still to announce; one seen at rest
  // has already shown whatever it shows.
  return { tab, settledGeneration: tab.loading ? tab.generation - 1 : tab.generation };
}

const PRESENTATION_EVENT: Record<BrowserTabState["presentation"], string> = {
  preview: "Pinned here",
  tab: "Opened as tab",
  headless: "Hidden",
};

/**
 * The announcements between two readings of the registry, in the order they
 * are pushed — latest wins in the channel, so within one push a tab's failure
 * outranks its load, and the last tab to change is the one announced.
 */
function diffTabs(
  previous: ReadonlyMap<string, SeenTab>,
  tabs: readonly BrowserTabState[],
  flash: IslandFlashPush,
): Map<string, SeenTab> {
  const next = new Map<string, SeenTab>();
  for (const tab of tabs) {
    const host = islandTabHost(tab);
    const before = previous.get(tab.tabId);
    if (before === undefined) {
      flash("Opened", host);
      next.set(tab.tabId, seenOf(tab));
      continue;
    }
    let settledGeneration = before.settledGeneration;
    if (tab.presentation !== before.tab.presentation) {
      flash(PRESENTATION_EVENT[tab.presentation], host);
    }
    if (tab.error !== null && before.tab.error === null) {
      flash("Failed", host);
      settledGeneration = tab.generation;
    } else if (!tab.loading && tab.error === null && tab.generation > settledGeneration) {
      flash("Loaded", host);
      settledGeneration = tab.generation;
    }
    next.set(tab.tabId, { tab, settledGeneration });
  }
  for (const [tabId, before] of previous) {
    if (!next.has(tabId)) flash("Closed", islandTabHost(before.tab));
  }
  return next;
}

export function useIslandTabs(
  sessionId: string,
  projectId: string,
  flash: IslandFlashPush,
): IslandTabsFeed {
  const browser = useChatBrowserTabs(sessionId, projectId);
  // Hydration is the baseline. A chat can mount before main has answered the
  // project's listing, and the tabs that arrive with that answer existed all
  // along — announcing them would be the first-render trap arriving a beat
  // late. Until the project is hydrated nothing is diffed; the first hydrated
  // reading is remembered silently and every reading after it is news.
  const hydrated = useBrowserTabsStore((state) => state.hydratedProjects.has(projectId));
  const rawTabs = browser?.tabs;
  const titleOf = browser?.sessionTitle;
  const api = browser?.api;

  const tabs = React.useMemo<readonly IslandTab[]>(
    () =>
      rawTabs === undefined || titleOf === undefined
        ? NO_TABS
        : rawTabs.map((tab) => islandTabOf(tab, sessionId, titleOf)),
    [rawTabs, sessionId, titleOf],
  );

  const seen = React.useRef<Map<string, SeenTab> | null>(null);
  React.useEffect(() => {
    if (rawTabs === undefined || !hydrated) return;
    if (seen.current === null) {
      seen.current = new Map(rawTabs.map((tab) => [tab.tabId, seenOf(tab)]));
      return;
    }
    seen.current = diffTabs(seen.current, rawTabs, flash);
  }, [flash, hydrated, rawTabs]);

  // A verb is a request to main. Refusals surface the way every other failed
  // mutation does — a toast — and the channel says what happened, by host,
  // so the card's own confirmation line reads the refusal too. Never a throw:
  // the row's handler is fire-and-forget.
  const hostOf = React.useCallback(
    (tabId: string): string => {
      const tab = rawTabs?.find((one) => one.tabId === tabId);
      return tab === undefined ? tabId : islandTabHost(tab);
    },
    [rawTabs],
  );
  const request = React.useCallback(
    async (
      operation: (() => Promise<Result>) | undefined,
      verb: string,
      refusal: string,
      tabId: string,
    ) => {
      if (operation === undefined) return;
      try {
        const result = await operation();
        if (!result.ok) {
          toastError(`Could not ${verb} Browser Tab: ${result.error}`);
          flash(refusal, hostOf(tabId));
        }
      } catch (reason) {
        toastError(`Could not ${verb} Browser Tab: ${errorMessage(reason)}`);
        flash(refusal, hostOf(tabId));
      }
    },
    [flash, hostOf],
  );
  const actions = React.useMemo<IslandTabsFeed["actions"]>(
    () => ({
      closeTab: (tabId) => {
        void request(
          api === undefined ? undefined : () => api.close({ tabId }),
          "close",
          "Close refused",
          tabId,
        );
      },
      // VC-238's Show: the pinned preview above this chat's composer. The
      // cheap reveal; "Open as tab" stays on the preview chrome and the card.
      promoteTab: (tabId) => {
        void request(
          api === undefined
            ? undefined
            : () => api.setPresentation({ tabId, presentation: "preview" }),
          "show",
          "Show refused",
          tabId,
        );
      },
    }),
    [api, request],
  );

  return React.useMemo(() => ({ model: { tabs }, actions }), [tabs, actions]);
}
