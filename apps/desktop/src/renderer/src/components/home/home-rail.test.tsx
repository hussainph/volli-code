import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Project } from "@volli/shared";

import { HomeRail } from "./home-rail";
import { HOME_BOARD_TAB_ID } from "./home-tabs";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";

/**
 * A mount check, at the store defaults a static render can see (zustand serves
 * `getInitialState()` during server rendering). The decisions this rail makes
 * are in `home-rail-model.ts` where tests can reach them; what this catches is
 * the failure a unit test never can — a rail that throws on the way up, or one
 * that quietly stops offering a page.
 */
const project: Project = {
  id: "p1",
  name: "Volli Code",
  path: "/code/volli-code",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function draw(activeTabId: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeRail project={project} activeTabId={activeTabId} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  useUiStore.setState({ homeRailMode: "now" });
  useUiStore.getInitialState().homeRailMode = "now";
});

describe("HomeRail", () => {
  it("mounts on its resting page and offers all three pages", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain("home-rail");
    expect(markup).toContain("Now");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Files");
    expect(markup).toContain("home-rail-tab-now");
    expect(markup).toContain("home-rail-tab-sessions");
    expect(markup).toContain("home-rail-tab-files");
  });

  // The narrow-rail contract, asserted as behaviour rather than as class
  // strings: an inactive page drops its WORD (that is what lets three fit the
  // pill at the 240px floor) but must keep its NAME, or the icon that replaces
  // the word is unreadable to a screen reader and unnameable to a query.
  it("names every page even where only the selected one wears its label", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain('aria-label="Now"');
    expect(markup).toContain('aria-label="Sessions"');
    expect(markup).toContain('aria-label="Files"');
    // Resting page selected; the other two are icons, so their word is absent.
    expect(markup).toContain(">Now<");
    expect(markup).not.toContain(">Sessions<");
    expect(markup).not.toContain(">Files<");
  });

  it("mounts the Main-checkout navigator on its Files page", () => {
    // Server rendering reads Zustand's initial snapshot rather than its live
    // snapshot, so select the page on the same seam this mount check observes.
    useUiStore.getInitialState().homeRailMode = "files";

    const markup = draw("chat:s1");

    expect(markup).toContain('data-testid="home-files-panel"');
    expect(markup).toContain("Project files");
    expect(markup).toContain("Volli Code");
  });

  it("names the venue block and the session block", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain("Venue");
    expect(markup).toContain("Model");
    expect(markup).toContain("Effort");
    expect(markup).toContain("Activity");
  });

  it("says there is no Session in front when the Board tab is", () => {
    // The board is not a Session, so the block that describes one says so in a
    // line rather than drawing a table of dashes.
    expect(draw(HOME_BOARD_TAB_ID)).toContain("No session in front");
  });

  it("asks a terminal tab what it actually has, not what a chat has", () => {
    // A PTY has no model and no effort; printing two dashes for them would be
    // calling an absence a reading.
    const markup = draw("terminal-session-1");

    expect(markup).not.toContain("Effort");
    expect(markup).not.toContain("Model");
  });

  it("ships no Mentioned block until there is a mechanism behind it", () => {
    // VC-104 owns `@vc-nn` backlinks; a section that can never fill in this
    // build is furniture.
    expect(draw("chat:s1")).not.toContain("Mentioned");
  });
});
