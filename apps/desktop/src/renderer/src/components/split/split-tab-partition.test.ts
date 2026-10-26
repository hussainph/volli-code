/**
 * The cut from one strip into per-pane strips.
 *
 * Every assertion here is about ORDER and MEMBERSHIP, which is the whole of
 * what this module decides: the resolution already said which ids live where,
 * and the failure this guards against is a pane drawing its tabs in the
 * surface's order instead of its own — which looks right until a drag inside
 * one pane rearranges another.
 */
import {
  emptySplitView,
  openTab,
  projectSplitView,
  sanitizeSplitView,
  selectTab,
  splitPane,
  SPLIT_VIEW_ROOT_PANE_ID,
  type SplitViewState,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { paneCellLabel, paneStripLabel, paneTabs, partitionPaneTabs } from "./split-tab-partition";

interface Descriptor {
  id: string;
  label: string;
}

const BODY = "doc";
const LIVE = [BODY, "chat", "term"];

function descriptors(...ids: string[]): Descriptor[] {
  return ids.map((id) => ({ id, label: id.toUpperCase() }));
}

/** A ticket-shaped group: Body + `chat` stacked in one pane, `term` beside them. */
function twoPanes(): SplitViewState {
  let ids = 0;
  const grouped = splitPane(
    emptySplitView(BODY),
    SPLIT_VIEW_ROOT_PANE_ID,
    "right",
    { tabId: "term" },
    () => {
      ids += 1;
      return `p${ids}`;
    },
  );
  return selectTab(openTab(selectTab(grouped, BODY), "chat"), BODY);
}

describe("paneTabs", () => {
  it("gives a pane its own stack in its own order", () => {
    const view = projectSplitView(twoPanes(), LIVE, BODY, BODY);
    const tabs = descriptors(...LIVE);

    expect(paneTabs(view.panes[0]!, tabs).map((tab) => tab.id)).toEqual([BODY, "chat"]);
    expect(paneTabs(view.panes[1]!, tabs).map((tab) => tab.id)).toEqual(["term"]);
  });

  it("keeps the PANE's order, not the strip's", () => {
    // The pane was dragged into `file, chat` while the surface still composes
    // files after chats — the strip that draws the pane must follow the pane.
    const state = sanitizeSplitView({
      pairs: [
        {
          kind: "split",
          id: "s",
          direction: "row",
          ratio: 0.5,
          first: { kind: "pane", id: "a", tabIds: [BODY], activeTabId: BODY },
          second: {
            kind: "pane",
            id: "b",
            tabIds: ["file:b.ts", "chat:1"],
            activeTabId: "chat:1",
          },
        },
      ],
      selectedTabId: "chat:1",
      focusedPaneId: "b",
    });
    const view = projectSplitView(state, [BODY, "chat:1", "file:b.ts"], "chat:1", BODY);

    expect(paneTabs(view.panes[1]!, descriptors(BODY, "chat:1", "file:b.ts"))).toEqual([
      { id: "file:b.ts", label: "FILE:B.TS" },
      { id: "chat:1", label: "CHAT:1" },
    ]);
  });

  it("drops an id nothing answers to rather than drawing a blank tab", () => {
    const view = projectSplitView(twoPanes(), LIVE, BODY, BODY);

    // A caller that resolved against one list and drew another: the tab simply
    // is not there, and the strip is still the strip.
    expect(paneTabs(view.panes[0]!, descriptors(BODY)).map((tab) => tab.id)).toEqual([BODY]);
  });

  it("gives an empty pane nothing at all", () => {
    const opened = splitPane(emptySplitView(BODY), SPLIT_VIEW_ROOT_PANE_ID, "down", {}, () =>
      String(Math.random()),
    );
    const view = projectSplitView(opened, [BODY], BODY, BODY);

    expect(paneTabs(view.panes[1]!, descriptors(BODY))).toEqual([]);
  });
});

describe("partitionPaneTabs", () => {
  it("cuts a shown group's panes, in reading order", () => {
    const view = projectSplitView(twoPanes(), LIVE, BODY, BODY);

    expect(
      partitionPaneTabs(view, descriptors(...LIVE)).map((entry) => ({
        pane: entry.pane.id,
        tabs: entry.tabs.map((tab) => tab.id),
      })),
    ).toEqual([
      { pane: "p3", tabs: [BODY, "chat"] },
      { pane: "p1", tabs: ["term"] },
    ]);
  });

  it("hands a full-width tab one pane holding just that tab", () => {
    const view = projectSplitView(null, LIVE, "chat", BODY);

    expect(partitionPaneTabs(view, descriptors(...LIVE))).toEqual([
      { pane: view.panes[0], tabs: [{ id: "chat", label: "CHAT" }] },
    ]);
  });
});

describe("pane labels", () => {
  it("counts panes from one, for the strip and for the cell", () => {
    const view = projectSplitView(twoPanes(), LIVE, BODY, BODY);

    expect(paneStripLabel(view.panes[0]!)).toBe("Pane 1 tabs");
    expect(paneStripLabel(view.panes[1]!)).toBe("Pane 2 tabs");
    expect(paneCellLabel(view.panes[1]!, view.panes.length)).toBe("Pane 2 of 2");
  });
});
