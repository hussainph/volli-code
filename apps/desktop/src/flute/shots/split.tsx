/**
 * Montage shot: split view in the main tab bar (VC-202, VC-333).
 *
 * Real: the whole `AppShell` on Home — Board, two Browser Tabs — seeded the
 * way the lab's `split-view-tab-bar` scratch seeds it. At 150ms the Home
 * surface splits right (`splitHomePane`, the store action the drop zones and
 * the ⌘\ shortcut call), which moves one tab into the new pane and splits the
 * main tab bar with it (VC-333); then the one divider is resized through
 * `setHomeSplitRatio`, the action the grip itself writes. Both are applied
 * from scene time, never from events. Browser pages are native views, so the
 * second pane shows the real chrome over an empty page — which is the lab's
 * honest limit, and also what the product looks like before a page paints.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import { SPLIT_VIEW_ROOT_PANE_ID } from "@volli/shared";
import type { BrowserTabState } from "../../ipc/contract";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import { ease, track } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { project, seedShell, shellApi, ShellWindow } from "../kit/split-shell";

/** The window, in lab CSS px. The rig in scripts/film/shots/split.mjs mirrors it. */
export const WINDOW = { width: 1600, height: 960 };

const T = { split: 150 };

/** The divider's share of the content card, over scene time. */
const RATIO: readonly (readonly [number, number])[] = [
  [150, 0.5],
  [260, 0.5],
  [760, 0.64],
  [1150, 0.57],
];

const BROWSER_TABS: BrowserTabState[] = [
  {
    id: "docs",
    title: "Voltaic docs — Split view",
    url: "https://voltaic.example/docs/split-view",
  },
  { id: "pricing", title: "Pricing — Voltaic", url: "https://voltaic.example/pricing" },
  { id: "changelog", title: "Changelog — Voltaic", url: "https://voltaic.example/changelog" },
  { id: "status", title: "Status — Voltaic", url: "https://status.voltaic.example" },
  { id: "roadmap", title: "Roadmap — Voltaic", url: "https://voltaic.example/roadmap" },
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

const TAB_IDS = [HOME_BOARD_TAB_ID, ...BROWSER_TABS.map((tab) => `browser:${tab.tabId}`)];

function seed(): void {
  seedShell();
  useBrowserTabsStore.setState({
    byId: Object.fromEntries(BROWSER_TABS.map((tab) => [tab.tabId, tab])),
    hydratedProjects: new Set([project.id]),
  });
}

const API = shellApi({}, BROWSER_TABS);

/** Brings the workspace store to what scene time `t` says, and no further. */
function applySplit(t: number): void {
  const want = t >= T.split;
  const view = useWorkspaceStore.getState().byProject[project.id]?.homeSplitView ?? null;
  const split = view !== null && view.root.kind === "split";
  if (!want) {
    if (split) seed();
    return;
  }
  if (!split) {
    useWorkspaceStore.getState().splitHomePane(project.id, SPLIT_VIEW_ROOT_PANE_ID, "right", {
      tabId: TAB_IDS[1]!,
      surfaceTabIds: TAB_IDS,
    });
  }
  const root = useWorkspaceStore.getState().byProject[project.id]?.homeSplitView?.root;
  if (root?.kind !== "split") return;
  const ratio = track(t, RATIO, ease.inOutCubic);
  if (Math.abs(root.ratio - ratio) > 1e-5) {
    useWorkspaceStore.getState().setHomeSplitRatio(project.id, root.id, ratio);
  }
}

const CUE: Cue = {
  at: 120,
  until: 1150,
  eyebrow: "VC-202 · VC-333",
  lines: ["Split view."],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower-right" }],
  portrait: [{ ...CUE, place: "upper" }],
};

export function SplitShot({ format }: { format: Format }) {
  const t = useFilm();
  useFixtures({ api: API, seed });
  React.useLayoutEffect(() => applySplit(t), [t]);

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
        content={<ShellWindow width={WINDOW.width} height={WINDOW.height} />}
      />
      <FrameLayer format={format}>
        <Vignette strength={0.6} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
