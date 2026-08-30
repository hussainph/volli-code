// @vitest-environment jsdom
/**
 * The plane, drawn once for both cases.
 *
 * The assertions that matter are the compatibility ones: an unsplit surface
 * must render as the bare plane it always was — no ring, no pane name, no
 * divider — because "splitting is strictly additive" is a claim about this file
 * and nowhere else. The rest is the vocabulary the terminal split already
 * speaks, asserted as relations (focused vs. not) rather than as hexes.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveSplitView,
  setSplitRatio,
  singlePaneSplitView,
  splitPane,
  SPLIT_VIEW_ROOT_PANE_ID,
  type ResolvedSplitView,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { paneIdForElement, SplitViewGrid } from "./split-view-grid";

const BODY = "doc";

/** One pane holding the whole strip — an unsplit surface. */
function unsplit(): ResolvedSplitView {
  return resolveSplitView(
    singlePaneSplitView([], BODY, SPLIT_VIEW_ROOT_PANE_ID),
    [BODY, "term"],
    BODY,
  );
}

/**
 * Two panes side by side, the second (focused) holding `term`. `splitPane`
 * mints the new PANE first and the branch that holds it second, so the ids are
 * `p1` and `p2` — which is also how the ratio is set below.
 */
function split(ratio = 0.5): ResolvedSplitView {
  let minted = 0;
  const opened = splitPane(
    singlePaneSplitView([BODY, "term"], BODY, SPLIT_VIEW_ROOT_PANE_ID),
    SPLIT_VIEW_ROOT_PANE_ID,
    "right",
    { tabId: "term" },
    () => {
      minted += 1;
      return `p${minted}`;
    },
  );
  return resolveSplitView(setSplitRatio(opened, "p2", ratio), [BODY, "term"], BODY);
}

function markup(view: ResolvedSplitView): string {
  return renderToStaticMarkup(
    <SplitViewGrid
      view={view}
      renderStrip={(pane) => (pane.isPrimary ? null : <div data-testid={`strip-${pane.id}`} />)}
      renderContent={(pane) => <div data-testid={`content-${pane.id}`}>{pane.activeTabId}</div>}
      onFocusPane={vi.fn()}
      onResizeSplit={vi.fn()}
    />,
  );
}

describe("SplitViewGrid", () => {
  it("draws an unsplit surface as one plain cell — no ring, no name, no divider", () => {
    const html = markup(unsplit());

    expect(html).toContain('data-testid="content-root"');
    expect(html).not.toContain("ring-inset");
    expect(html).not.toContain("aria-label");
    expect(html).not.toContain('role="separator"');
    // The primary pane draws no strip of its own: the surface's is its.
    expect(html).not.toContain("strip-root");
  });

  it("gives the primary pane the permanent tab and the second pane its own", () => {
    const html = markup(split());

    expect(html).toContain(">doc</div>");
    expect(html).toContain(">term</div>");
    expect(html).toContain('data-testid="strip-p1"');
  });

  it("rings the focused pane in the terminal split's own vocabulary", () => {
    const html = markup(split());

    // Both rings are drawn, and only the focused one is the primary colour —
    // asserted as a pair, because the pair is what says which pane the rail is
    // reading.
    expect(html).toContain("ring-1 ring-border/50 ring-inset");
    expect(html).toContain("ring-1 ring-primary/50 ring-inset");
    expect(html).toContain('data-pane-id="p1" data-focused="true"');
  });

  it("names each pane by its position once there is a choice to describe", () => {
    const html = markup(split());

    expect(html).toContain('aria-label="Pane 1 of 2"');
    expect(html).toContain('aria-label="Pane 2 of 2"');
  });

  it("sizes the first child by the branch ratio, minus its half of the divider", () => {
    // The terminal split's exact arithmetic: 6px of grip split evenly, so a
    // 0.5 ratio is visually equal rather than 3px off.
    expect(markup(split(0.5))).toContain("flex:0 0 calc(50% - 3px)");
    expect(markup(split(0.3))).toContain("flex:0 0 calc(30% - 3px)");
  });

  it("puts a resizable separator between the two panes", () => {
    const html = markup(split());

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize left and right panes"');
  });

  it("climbs from a node to the pane cell holding it, and says null outside one", () => {
    // The terminal viewport boxes' seam (validation V1): they are positioned
    // SIBLINGS of the grid, so they raise pane focus by climbing from the
    // anchor they were given. Zen's full-bleed anchor has no cell above it —
    // the climb must say so rather than invent one, which is what makes
    // firing it unconditionally safe.
    const cell = document.createElement("div");
    cell.setAttribute("data-pane-id", "p9");
    const anchor = document.createElement("div");
    cell.append(anchor);

    expect(paneIdForElement(anchor)).toBe("p9");
    expect(paneIdForElement(document.createElement("div"))).toBe(null);
    expect(paneIdForElement(null)).toBe(null);
  });
});
