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
  resolveSplitView,
  singlePaneSplitView,
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

function descriptors(...ids: string[]): Descriptor[] {
  return ids.map((id) => ({ id, label: id.toUpperCase() }));
}

/** A ticket-shaped split: Body + `chat` in the primary, `term` beside them. */
function twoPanes(): SplitViewState {
  let ids = 0;
  const materialized = singlePaneSplitView([BODY, "chat", "term"], BODY, SPLIT_VIEW_ROOT_PANE_ID);
  return splitPane(materialized, SPLIT_VIEW_ROOT_PANE_ID, "right", { tabId: "term" }, () => {
    ids += 1;
    return `p${ids}`;
  });
}

describe("paneTabs", () => {
  it("gives a pane its own tabs in its own order", () => {
    const view = resolveSplitView(twoPanes(), [BODY, "chat", "term"], BODY);
    const tabs = descriptors(BODY, "chat", "term");

    expect(paneTabs(view.panes[0]!, tabs).map((tab) => tab.id)).toEqual([BODY, "chat"]);
    expect(paneTabs(view.panes[1]!, tabs).map((tab) => tab.id)).toEqual(["term"]);
  });

  it("keeps the PANE's order, not the strip's", () => {
    // The pane was dragged into `chat, file` while the surface still composes
    // files after chats — the strip that draws the pane must follow the pane.
    const state: SplitViewState = {
      root: {
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
      focusedPaneId: "b",
    };
    const view = resolveSplitView(state, [BODY, "chat:1", "file:b.ts"], BODY);

    expect(paneTabs(view.panes[1]!, descriptors(BODY, "chat:1", "file:b.ts"))).toEqual([
      { id: "file:b.ts", label: "FILE:B.TS" },
      { id: "chat:1", label: "CHAT:1" },
    ]);
  });

  it("drops an id nothing answers to rather than drawing a blank tab", () => {
    const view = resolveSplitView(twoPanes(), [BODY, "chat", "term"], BODY);

    // A caller that resolved against one list and drew another: the tab simply
    // is not there, and the strip is still the strip.
    expect(paneTabs(view.panes[0]!, descriptors(BODY)).map((tab) => tab.id)).toEqual([BODY]);
  });

  it("gives an empty pane nothing at all", () => {
    const opened = splitPane(
      singlePaneSplitView([BODY], BODY, SPLIT_VIEW_ROOT_PANE_ID),
      SPLIT_VIEW_ROOT_PANE_ID,
      "down",
      {},
      () => "p1",
    );
    const view = resolveSplitView(opened, [BODY], BODY);

    expect(paneTabs(view.panes[1]!, descriptors(BODY))).toEqual([]);
  });
});

describe("partitionPaneTabs", () => {
  it("cuts the whole strip, primary first", () => {
    const view = resolveSplitView(twoPanes(), [BODY, "chat", "term"], BODY);

    expect(
      partitionPaneTabs(view, descriptors(BODY, "chat", "term")).map((entry) => ({
        pane: entry.pane.id,
        tabs: entry.tabs.map((tab) => tab.id),
      })),
    ).toEqual([
      { pane: SPLIT_VIEW_ROOT_PANE_ID, tabs: [BODY, "chat"] },
      { pane: "p1", tabs: ["term"] },
    ]);
  });

  it("hands an unsplit surface its whole strip as one pane", () => {
    // The compatibility case: one pane, every tab, in the arranged order — what
    // the surface drew before it knew about panes at all.
    const view = resolveSplitView(
      singlePaneSplitView([], "chat", SPLIT_VIEW_ROOT_PANE_ID),
      [BODY, "chat", "term"],
      BODY,
    );

    expect(partitionPaneTabs(view, descriptors(BODY, "chat", "term"))).toHaveLength(1);
    expect(
      partitionPaneTabs(view, descriptors(BODY, "chat", "term"))[0]!.tabs.map((tab) => tab.id),
    ).toEqual([BODY, "chat", "term"]);
  });
});

describe("pane labels", () => {
  it("counts panes from one, for the strip and for the cell", () => {
    const view = resolveSplitView(twoPanes(), [BODY, "chat", "term"], BODY);

    expect(paneStripLabel(view.panes[0]!)).toBe("Pane 1 tabs");
    expect(paneStripLabel(view.panes[1]!)).toBe("Pane 2 tabs");
    expect(paneCellLabel(view.panes[1]!, view.panes.length)).toBe("Pane 2 of 2");
  });
});
