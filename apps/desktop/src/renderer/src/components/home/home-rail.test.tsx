import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HomeRail } from "./home-rail";
import { HOME_BOARD_TAB_ID } from "./home-tabs";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

/**
 * A mount check, at the store defaults a static render can see (zustand serves
 * `getInitialState()` during server rendering). The decisions this rail makes
 * are in `home-rail-model.ts` where tests can reach them; what this catches is
 * the failure a unit test never can — a rail that throws on the way up, or one
 * that quietly stops offering a page.
 */
function draw(activeTabId: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeRail projectId="p1" activeTabId={activeTabId} />
    </TooltipProvider>,
  );
}

describe("HomeRail", () => {
  it("mounts on its resting page and offers both", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain("home-rail");
    expect(markup).toContain("Now");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("home-rail-tab-now");
    expect(markup).toContain("home-rail-tab-sessions");
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
