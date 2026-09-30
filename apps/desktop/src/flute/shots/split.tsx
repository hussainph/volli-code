/**
 * Montage shot: multitasking — split view in the main tab bar.
 *
 * Real: the whole `AppShell` on Home, with two ticketless chat tabs and one
 * Browser Tab open. Everything is applied from scene time through the store
 * actions the product itself calls:
 *
 *   0      one chat, full width.
 *   250    `splitHomePane(root, "right", browser)` — the browser joins on the
 *          right; `setHomeSplitRatio` then shoves that divider right so the
 *          (native, so empty-in-the-lab) page stays a narrow strip.
 *   1650   `splitHomePane(<chat pane>, "right", chat B)` — a second chat joins
 *          as a third pane between them; its divider slides into place.
 *
 * Chat content: the chat plane talks to its harness over `sessionRpc`, which
 * the lab does not serve, so each chat pane's body is covered by a transcript
 * built from the real message components (`Message`, `GuardedResponse`) with
 * invented fixture turns — the way the island shot builds its feed.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { Surface } from "@webprodigies/flute";
import { SPLIT_VIEW_ROOT_PANE_ID } from "@volli/shared";
import type { BrowserTabState } from "../../ipc/contract";

import { GuardedResponse } from "@renderer/components/chat/markdown-boundary";
import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useSessionsStore } from "@renderer/stores/sessions";
import { getOrCreateEngine } from "@renderer/terminal/registry";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import { ease, track } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFilmWallClock,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { NOW } from "../../renderer/lab/fixtures";
import {
  chatSessions,
  project,
  seedShell,
  sessionRows,
  shellApi,
  ShellWindow,
} from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

/** The window, in lab CSS px. The rig in scripts/film/shots/split.mjs mirrors it. */
export const WINDOW = { width: 1600, height: 960 };

export const T = { browser: 250, chat: 1650 };

/** The outer divider (chat side | browser) over scene time. */
const OUTER: readonly (readonly [number, number])[] = [
  [250, 0.5],
  [330, 0.5],
  [950, 0.7],
  [1650, 0.7],
  [2300, 0.78],
];
/** The inner divider (chat A | chat B), once the third pane exists. */
const INNER: readonly (readonly [number, number])[] = [
  [1650, 0.5],
  [1730, 0.5],
  [2400, 0.42],
  [3000, 0.47],
];

/* ------------------------------------------------------------- fixtures */

interface FilmChat {
  id: string;
  title: string;
  turns: { from: "user" | "assistant"; text: string }[];
}

const CHATS: FilmChat[] = [
  {
    id: "film-chat-retry",
    title: "Retry budget for the API client",
    turns: [
      {
        from: "user",
        text: "Add a retry budget to the Atlas API client. Keep the backoff jitter.",
      },
      {
        from: "assistant",
        text: "Done. Retries now stop once the budget is spent, and jitter stays on. Three call sites changed.",
      },
      { from: "user", text: "Show me the docs page for the new option." },
      {
        from: "assistant",
        text: "Opened it beside us. `retryBudget` defaults to 3 and resets per request.",
      },
    ],
  },
  {
    id: "film-chat-tests",
    title: "Checkout discount tests",
    turns: [
      { from: "user", text: "Write tests for the checkout discount rules." },
      {
        from: "assistant",
        text: "Added 12 cases: stacked codes, expired codes and rounding at the cent. Running them now.",
      },
      { from: "assistant", text: "All 12 pass. One rounding edge was wrong; it's fixed." },
    ],
  },
];

const CHAT_RECORDS = CHATS.map((chat) => ({
  ...chatSessions[0]!,
  sessionId: chat.id,
  ticketId: null,
  projectId: project.id,
  title: chat.title,
  activity: "idle" as const,
  waitingOn: null,
}));

const CHAT_ROW = sessionRows.find((row) => row.kind === "chat")!;
// oxlint-disable-next-line no-map-spread -- a fixture built once at module load
const EXTRA_ROWS = CHAT_RECORDS.map((record) => ({ ...CHAT_ROW, record }));

const BROWSER_TABS: BrowserTabState[] = [
  {
    id: "docs",
    title: "Atlas API — Retries",
    url: "https://atlas.example/docs/retries",
  },
].map((tab) => ({
  tabId: `home-${tab.id}`,
  projectId: project.id,
  ticketId: null,
  createdBy: "user" as const,
  ownerSessionId: null,
  presentation: "tab" as const,
  url: tab.url,
  title: tab.title,
  loading: false,
  error: null,
  canGoBack: true,
  canGoForward: false,
  generation: 0,
  heldBy: null,
}));

/** A real terminal tab: the app's xterm engine, fed invented output. */
const TERM = "film-term-tests";
const TERM_TITLE = "pnpm test";
const TERM_OUTPUT = [
  "\x1b[38;5;244m~/work/atlas\x1b[0m \x1b[35m$\x1b[0m pnpm test",
  "",
  "\x1b[1m RUN \x1b[0m v2.1.4 \x1b[38;5;244m/work/atlas\x1b[0m",
  "",
  " \x1b[32m✓\x1b[0m src/client/retry.test.ts \x1b[38;5;244m(9)\x1b[0m",
  " \x1b[32m✓\x1b[0m src/client/backoff.test.ts \x1b[38;5;244m(6)\x1b[0m",
  " \x1b[32m✓\x1b[0m src/checkout/discount.test.ts \x1b[38;5;244m(12)\x1b[0m",
  " \x1b[32m✓\x1b[0m src/checkout/rounding.test.ts \x1b[38;5;244m(4)\x1b[0m",
  " \x1b[32m✓\x1b[0m src/cart/totals.test.ts \x1b[38;5;244m(8)\x1b[0m",
  "",
  "\x1b[38;5;244m Test Files \x1b[0m \x1b[1;32m5 passed\x1b[0m",
  "\x1b[38;5;244m      Tests \x1b[0m \x1b[1;32m39 passed\x1b[0m",
  "",
  "\x1b[38;5;244m~/work/atlas\x1b[0m \x1b[35m$\x1b[0m ",
].join("\r\n");

const CHAT_A = chatTabId(CHATS[0]!.id);
const BROWSER = `browser:${BROWSER_TABS[0]!.tabId}`;
const TAB_IDS = [HOME_BOARD_TAB_ID, TERM, CHAT_A, BROWSER];

const ok = <T extends object>(value: T) => Promise.resolve({ ok: true as const, ...value });

function seed(): void {
  seedShell();
  useBrowserTabsStore.setState({
    byId: Object.fromEntries(BROWSER_TABS.map((tab) => [tab.tabId, tab])),
    hydratedProjects: new Set([project.id]),
  });
  useChatSessionsStore.setState({
    openTabs: { [project.id]: [CHATS[0]!.id] },
  });
  // The strip reads a chat tab's title from its Session projection or, before
  // that arrives, its provisional Draft: seed the Draft so the tab wears it.
  const drafts = useChatDraftsStore.getState();
  for (const chat of CHATS) {
    if (drafts.drafts[chat.id]?.provisional === undefined) {
      drafts.openProvisional(chat.id, {
        projectId: project.id,
        ticketId: null,
        operationId: `op-${chat.id}`,
        title: chat.title,
      });
    }
  }
  useSessionsStore.setState({
    byOwner: {
      [project.id]: {
        tabs: [
          {
            sessionId: TERM,
            title: TERM_TITLE,
            scope: { kind: "project", projectId: project.id },
            layout: { kind: "pane", sessionId: TERM, exitCode: null },
            activePaneId: TERM,
          },
        ],
        activeSessionId: null,
      },
    },
  });
  useWorkspaceStore.getState().setHomeActiveTab(project.id, CHAT_A);
}

const API = shellApi(
  {
    sessions: {
      list: (input?: { projectId?: string }) =>
        ok({
          sessions: [...sessionRows, ...EXTRA_ROWS].filter(
            (row) => input?.projectId === undefined || row.record.projectId === input.projectId,
          ),
        }),
    },
  },
  BROWSER_TABS,
);

/* ---------------------------------------------------------- split tree */

type Node =
  | { kind: "pane"; id: string; tabIds: readonly string[]; activeTabId: string | null }
  | { kind: "split"; id: string; ratio: number; first: Node; second: Node };

function homeRoot(): Node | null {
  const view = useWorkspaceStore.getState().byProject[project.id]?.homeSplitView ?? null;
  return (view?.root as Node | undefined) ?? null;
}

function panes(node: Node | null): Extract<Node, { kind: "pane" }>[] {
  if (node === null) return [];
  return node.kind === "pane" ? [node] : [...panes(node.first), ...panes(node.second)];
}

function paneHolding(tabId: string): string | null {
  return panes(homeRoot()).find((pane) => pane.tabIds.includes(tabId))?.id ?? null;
}

function setRatio(splitId: string, ratio: number, current: number): void {
  if (Math.abs(current - ratio) > 1e-5) {
    useWorkspaceStore.getState().setHomeSplitRatio(project.id, splitId, ratio);
  }
}

/** Brings the workspace store to what scene time `t` says, and no further. */
function applySplit(t: number): void {
  const count = panes(homeRoot()).length;
  const want = t >= T.chat ? 3 : t >= T.browser ? 2 : 1;
  if (count > want) {
    seed();
    applySplit(t);
    return;
  }
  const split = useWorkspaceStore.getState().splitHomePane;
  if (want >= 2 && count < 2) {
    split(project.id, SPLIT_VIEW_ROOT_PANE_ID, "right", {
      tabId: BROWSER,
      surfaceTabIds: TAB_IDS,
    });
  }
  if (want >= 3 && panes(homeRoot()).length < 3) {
    const home = paneHolding(CHAT_A) ?? SPLIT_VIEW_ROOT_PANE_ID;
    split(project.id, home, "right", { tabId: TERM, surfaceTabIds: TAB_IDS });
  }
  const root = homeRoot();
  if (root?.kind !== "split") return;
  setRatio(root.id, track(t, OUTER, ease.inOutCubic), root.ratio);
  if (root.first.kind === "split") {
    setRatio(root.first.id, track(t, INNER, ease.inOutCubic), root.first.ratio);
  }
}

/** Feeds the real terminal engine its invented run, once. */
let fed = false;
function feedTerminal(): void {
  if (fed) return;
  fed = true;
  getOrCreateEngine(TERM).write(TERM_OUTPUT);
}

/* ------------------------------------------------------ chat overlays */

function Transcript({ chat }: { chat: FilmChat }) {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col bg-background"
      style={{ padding: "28px 28px 0" }}
    >
      <ContentColumn className="flex min-h-0 flex-1 flex-col px-0">
        <div className="flex flex-col gap-6 overflow-hidden pb-4">
          {chat.turns.map((turn) => (
            <Message key={turn.text} from={turn.from} className="relative max-w-full">
              <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2">
                <GuardedResponse>{turn.text}</GuardedResponse>
              </MessageContent>
            </Message>
          ))}
        </div>
      </ContentColumn>
    </div>
  );
}

/** Covers each chat pane's body with its fixture transcript. */
function ChatOverlays({ t }: { t: number }) {
  const [targets, setTargets] = React.useState<{ el: Element; chat: FilmChat }[]>([]);
  // Finds the chat panes after every commit (the split tree follows scene
  // time); setTargets only fires when the set of panes changed.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    const next: { el: Element; chat: FilmChat }[] = [];
    const live = panes(homeRoot());
    for (const chat of CHATS) {
      const tab = chatTabId(chat.id);
      const pane = live.find((p) => p.activeTabId === tab);
      const el =
        pane === undefined
          ? live.length === 0 && t < T.browser && chat === CHATS[0]
            ? document.querySelector('.film-shell [data-slot="split-view-pane"]')
            : null
          : document.querySelector(
              `.film-shell [data-slot="split-view-pane"][data-pane-id="${pane.id}"]`,
            );
      if (el !== null) next.push({ el, chat });
    }
    setTargets((prev) =>
      prev.length === next.length && prev.every((p, i) => p.el === next[i]!.el) ? prev : next,
    );
  });
  return (
    <>
      {targets.map(({ el, chat }) => (
        <React.Fragment key={chat.id}>
          {createPortal(<Transcript chat={chat} />, el)}
        </React.Fragment>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- shot */

const CUE: Cue = {
  at: 200,
  until: 3300,
  eyebrow: "Multitasking",
  lines: ["Chats, browsers, terminals.", "Side by side."],
  weights: [780, 320],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower-right" }],
  // 9:16: the long line breaks, so every glyph stays inside 1080px.
  portrait: [
    {
      ...CUE,
      lines: ["Chats, browsers,", "terminals.", "Side by side."],
      weights: [780, 780, 320],
      place: "lower",
    },
  ],
};

export function SplitShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmWallClock(t, NOW);
  useFilmTheme("rose");
  useFixtures({ api: API, seed });
  React.useLayoutEffect(() => {
    feedTerminal();
    applySplit(t);
  }, [t]);

  return (
    <>
      <Surface
        id="window"
        style={{
          position: "absolute",
          left: `calc(50% - ${WINDOW.width / 2}px)`,
          top: `calc(50% - ${WINDOW.height / 2}px)`,
          width: WINDOW.width,
          height: WINDOW.height,
        }}
        content={
          <ShellWindow width={WINDOW.width} height={WINDOW.height}>
            <ChatOverlays t={t} />
          </ShellWindow>
        }
      />
      <Backdrop t={t} theme="rose" focus={format === "landscape" ? [0.7, 0.7] : [0.5, 0.75]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
