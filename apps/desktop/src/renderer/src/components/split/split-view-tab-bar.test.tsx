// @vitest-environment jsdom
/**
 * The top strip's bar (VC-614): one band across the whole surface, whatever
 * is on screen below it — a shown group's panes draw their own strips in the
 * grid, so the bar is never cut into per-pane segments any more.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SplitViewTabBar } from "./split-view-tab-bar";

describe("SplitViewTabBar", () => {
  it("draws the one top strip it is given, undivided", () => {
    const html = renderToStaticMarkup(
      <SplitViewTabBar>
        <div role="tablist" aria-label="Home tabs" />
      </SplitViewTabBar>,
    );
    expect(html).toContain('data-slot="split-view-tab-bar"');
    expect(html).toContain('aria-label="Home tabs"');
    expect(html).not.toContain("split-view-tab-pane");
    expect(html).not.toContain('role="separator"');
  });
});
