import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Project } from "@volli/shared";

import { seedSlice } from "@volli/session-presentation";
import { HomeRail } from "./home-rail";
import { HOME_BOARD_TAB_ID } from "./home-tabs";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey } from "@renderer/stores/venue";

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
  useChatSessionsStore.getInitialState().sessions = {};
  useVenueStore.getInitialState().byScope = {};
});

/** A venue with values longer than the rail is wide, which is the ordinary case. */
function seedVenue(): void {
  useVenueStore.getInitialState().byScope = {
    [venueKey("p1", null)]: {
      status: "ready",
      venue: {
        kind: "worktree",
        path: "/Users/someone/.volli/worktrees/volli-code-f3732f45/VC-288-narrow-pane",
        branch: "volli/VC-288-narrow-pane-follow-ups-beyond-vc-264",
        files: { committed: 4, modified: 2, added: 1, untracked: 0 },
        diff: { added: 12, removed: 3, base: "main" },
      },
    },
  };
}

describe("HomeRail", () => {
  it("mounts on its resting page and offers all four pages", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain("home-rail");
    expect(markup).toContain("Now");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Files");
    expect(markup).toContain("Search");
    expect(markup).toContain("home-rail-tab-now");
    expect(markup).toContain("home-rail-tab-sessions");
    expect(markup).toContain("home-rail-tab-files");
    expect(markup).toContain("home-rail-tab-search");
  });

  // The narrow-rail contract, asserted as behaviour rather than as class
  // strings: an inactive page drops its WORD (that is what lets four fit the
  // pill at the 240px floor) but must keep its NAME, or the icon that replaces
  // the word is unreadable to a screen reader and unnameable to a query.
  it("names every page even where only the selected one wears its label", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain('aria-label="Now"');
    expect(markup).toContain('aria-label="Sessions"');
    expect(markup).toContain('aria-label="Files"');
    expect(markup).toContain('aria-label="Search"');
    // Resting page selected; the other three are icons, so their word is absent.
    expect(markup).toContain(">Now<");
    expect(markup).not.toContain(">Sessions<");
    expect(markup).not.toContain(">Files<");
    expect(markup).not.toContain(">Search<");
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

  it("mounts the Search page at Home scope, pointed at the Main checkout", () => {
    useUiStore.getInitialState().homeRailMode = "search";

    const markup = draw("chat:s1");

    expect(markup).toContain('data-testid="file-search-panel"');
    // The navigator's own sub-line: at Home scope it names the project, the
    // same word the Files page uses for the same checkout.
    expect(markup).toContain("Volli Code");
    // Idle until something is typed: an empty Search page is a resting state,
    // not a list of the whole checkout.
    expect(markup).toContain('data-testid="file-search-idle"');
  });

  it("puts the whole venue path and branch within a keyboard's reach", () => {
    // VC-288. Both values truncate in a rail this narrow, and both had their
    // full form behind a pointer: the path on a tooltip attached to a `<p>`,
    // and the branch with no reveal at all. The rail is where a reader checks
    // WHICH tree they are about to change something in, so "hover to find out"
    // is the wrong last word on it.
    seedVenue();
    const markup = draw("chat:s1");

    expect(markup).toContain(
      'aria-label="Worktree · /Users/someone/.volli/worktrees/volli-code-f3732f45/VC-288-narrow-pane"',
    );
    expect(markup).toContain(
      'aria-label="Branch · volli/VC-288-narrow-pane-follow-ups-beyond-vc-264"',
    );
    // Both reveals are buttons — focus stops Radix opens on focus as well as
    // on hover — rather than the text elements they were.
    const venueCard = markup.slice(markup.indexOf("Venue"));
    expect(venueCard.slice(0, venueCard.indexOf("Model"))).toContain("<button");
  });

  it("names the venue block and the session block", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain("Venue");
    expect(markup).toContain("Model");
    expect(markup).toContain("Effort");
    expect(markup).toContain("Activity");
  });

  it("leads the model with the tier it resolved from, where a start named one", () => {
    // A static render reads the store's initial state, so the Session in
    // front is seeded there: one started as `fast`, pinned to haiku.
    const slice = seedSlice("ready");
    slice.projection = {
      session: {
        id: "s1",
        projectId: "p1",
        ticketId: null,
        title: null,
        role: "project",
        parentSessionId: null,
        createdAt: 1,
      },
      status: "open",
      liveExecutor: null,
      attention: { active: [], primary: null },
      interactions: { active: [], resolved: [] },
      signal: null,
      modelSelection: { providerId: "anthropic", modelId: "haiku-4.5", reasoningLevel: "low" },
      modelTier: "fast",
      turnActive: false,
      lastActivityAt: 1,
      bornTicketless: true,
    };
    useChatSessionsStore.getInitialState().sessions = { s1: slice };

    // Split rather than `replace`: the tags are separators here, not
    // something being sanitized away, and a lone `replace` of a tag pattern
    // reads to a scanner as a half-written sanitizer.
    expect(
      draw("chat:s1")
        .split(/<[^>]+>/)
        .join(""),
    ).toContain("Fast · haiku-4.5");
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
