// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChatSessionRecord, Project, SessionHarnessState, SessionRecord } from "@volli/shared";

import { seedSlice } from "@volli/session-presentation";
import { HomeRail } from "./home-rail";
import { HOME_BOARD_TAB_ID } from "./home-tabs";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useRemoteSessionAvailabilityStore } from "@renderer/stores/remote-session-availability";
import { useSessionsStore, type SessionLayout, type SessionTab } from "@renderer/stores/sessions";
import {
  DEFAULT_RAIL_FOLDS,
  RAIL_DEFAULT_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_NARROW_MAX_WIDTH,
  useUiStore,
} from "@renderer/stores/ui";
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
  useUiStore.getInitialState().railFolds = DEFAULT_RAIL_FOLDS;
  useUiStore.getInitialState().railWidth = RAIL_DEFAULT_WIDTH;
  useChatSessionsStore.getInitialState().sessions = {};
  useVenueStore.getInitialState().byScope = {};
  useProjectSessionsStore.getInitialState().byProject = {};
  useProjectSessionsStore.getInitialState().listingState = {};
  useSessionsStore.getInitialState().byOwner = {};
  useSessionsStore.getInitialState().lastOutputAt = {};
  useSessionsStore.getInitialState().parkState = {};
  useSessionsStore.getInitialState().harness = {};
});

/** One durable terminal record, as the project's listing caches it. */
function terminal(id: string, title: string): SessionRecord {
  return {
    id,
    projectId: "p1",
    ticketId: null,
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "shell",
    placement: "tab",
    title,
    cwd: "/code/volli-code",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    lastActivityAt: 10,
    bornTicketless: true,
  };
}

/** One open tab in the project's scope, holding `layout`. */
function tab(sessionId: string, layout: SessionLayout): SessionTab {
  return {
    sessionId,
    title: sessionId,
    scope: { kind: "project", projectId: "p1" },
    layout,
    activePaneId: sessionId,
  };
}

function pane(sessionId: string): SessionLayout {
  return { kind: "pane", sessionId, exitCode: null };
}

/** A harness reporting `declared` about its pane — the fact recency cannot infer. */
function harness(declared: SessionHarnessState["declared"]): SessionHarnessState {
  return {
    harnessId: "claude-code",
    expectsEvents: true,
    declaresInputNeeded: true,
    startedAt: 1,
    delivered: true,
    declared,
    newestFiredAt: null,
  };
}

/** Seed a loaded project listing of terminals, with no chats. */
function seedTerminals(records: readonly SessionRecord[]): void {
  useProjectSessionsStore.getInitialState().byProject = {
    p1: { terminal: records, chat: [], provenance: {} },
  };
  useProjectSessionsStore.getInitialState().listingState = { p1: "loaded" };
}

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
  it("mounts on its resting page and offers exactly Now, Files and Search", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain("home-rail");
    expect(markup).toContain("Now");
    expect(markup).toContain("Files");
    expect(markup).toContain("Search");
    expect(markup).toContain("home-rail-tab-now");
    expect(markup).toContain("home-rail-tab-files");
    expect(markup).toContain("home-rail-tab-search");
    // VC-406: the roster is a block on Now, so the duplicate page is gone and
    // the pill cannot offer a door to it.
    expect(markup).not.toContain("home-rail-tab-sessions");
  });

  // VC-406 follow-up: the same marker the Ticket rail carries, because the two
  // rails are one panel at two scopes and a scrollbar that only one of them
  // reserved space for would be a fold that moved the rows at Home and not on a
  // Ticket. globals.css keys its rail-scrollbar rule to this attribute.
  it("marks its column as the scope globals.css hides rail scrollbars in", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain('data-volli-rail="home"');
    // On the root, ahead of the pill and of the page that scrolls under it.
    const root = markup.indexOf('data-volli-rail="home"');
    expect(root).toBeLessThan(markup.indexOf('role="tablist"'));
    expect(root).toBeLessThan(markup.indexOf("overflow-y-auto"));
    expect([...markup.matchAll(/data-volli-rail=/g)]).toHaveLength(1);
  });

  // The narrow-rail contract, asserted as behaviour rather than as class
  // strings: an inactive page drops its WORD (that is what lets the pill fit at
  // the 240px floor) but must keep its NAME, or the icon that replaces the word
  // is unreadable to a screen reader and unnameable to a query.
  it("names every page even where only the selected one wears its label", () => {
    const markup = draw("chat:s1");

    expect(markup).toContain('aria-label="Now"');
    expect(markup).toContain('aria-label="Files"');
    expect(markup).toContain('aria-label="Search"');
    // Resting page selected; the other two are icons, so their word is absent.
    expect(markup).toContain(">Now<");
    expect(markup).not.toContain(">Files<");
    expect(markup).not.toContain(">Search<");
  });

  // VC-406. Home hardcoded `data-narrow="false"` while the Ticket rail computed
  // it from the width both rails share, so a column dragged to its floor kept
  // 16px gutters at Home and 12px on a Ticket — one panel, two answers, and a
  // pinned checkout footer 4px out of line with the page above it.
  it("tightens its gutters with the rail's width, on the Ticket rail's own threshold", () => {
    useUiStore.getInitialState().railWidth = RAIL_DEFAULT_WIDTH;
    expect(draw("chat:s1")).toContain('data-narrow="false"');

    useUiStore.getInitialState().railWidth = RAIL_MIN_WIDTH;
    const narrow = draw("chat:s1");

    expect(narrow).toContain('data-narrow="true"');
    // Read as behaviour rather than as a class string: the flag is what every
    // block — including the footer outside the tabpanel — insets from.
    expect(narrow).toContain("group-data-[narrow=true]/rail:px-3");

    // The boundary itself, so the two rails cannot drift apart at 260px: at or
    // below the threshold is narrow, the first pixel above it is not.
    useUiStore.getInitialState().railWidth = RAIL_NARROW_MAX_WIDTH;
    expect(draw("chat:s1")).toContain('data-narrow="true"');
    useUiStore.getInitialState().railWidth = RAIL_NARROW_MAX_WIDTH + 1;
    expect(draw("chat:s1")).toContain('data-narrow="false"');
  });

  it("mounts the Main-checkout navigator on its Files page", () => {
    // Server rendering reads Zustand's initial snapshot rather than its live
    // snapshot, so select the page on the same seam this mount check observes.
    useUiStore.getInitialState().homeRailMode = "files";

    const markup = draw("chat:s1");

    expect(markup).toContain('data-testid="home-files-panel"');
    expect(markup).toContain('data-testid="files-navigator-header"');
    expect(markup).not.toContain("Project files");
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

  it("draws ONE block on Now — the roster — and no Session-identity card", () => {
    // VC-406, revision 05. Now carried a Session-identity card (model, tier,
    // effort) over a venue card over the usage card, and the roster arrived as
    // a fourth thing between them. The approved page is the roster: the
    // identity was a second answer to what the front tab and the composer's
    // own pill already say, and it stood between the page's title and the block
    // the page exists for.
    seedVenue();
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
      scheduledResume: null,
    };
    useChatSessionsStore.getInitialState().sessions = { s1: slice };

    const markup = draw("chat:s1");

    expect(markup).toContain("Board sessions");
    expect(markup).not.toContain('data-testid="home-session-card"');
    // Nothing of the identity card survives on the page: not the model it
    // named, not the qualifiers under it, not the eyebrow over it.
    expect(markup).not.toContain("haiku-4.5");
    expect(markup).not.toContain("Low effort");
    expect(markup).not.toContain("No session in front");
  });

  it("marks Home Run Sessions without printing another title at normal or narrow widths", () => {
    const chat: ChatSessionRecord = {
      sessionId: "chat-run",
      title: "Review the runtime migration",
      projectId: "p1",
      ticketId: null,
      createdAt: 1,
      adapterId: "pi",
      live: true,
      activity: "working",
      waitingOn: null,
      outcome: null,
      lastActivityAt: 2,
      bornTicketless: true,
      role: "project",
      parentSessionId: null,
      model: null,
    };
    useProjectSessionsStore.getInitialState().listingState = { p1: "loaded" };
    useProjectSessionsStore.getInitialState().byProject = {
      p1: {
        terminal: [
          terminal("terminal-run", "Review the shell migration"),
          terminal("manual", "My shell"),
        ],
        chat: [chat],
        provenance: {
          "chat-run": {
            kind: "automation",
            automationRunId: null,
            automationName: "BE Code Review",
          },
          "terminal-run": { kind: "automation", automationRunId: null, automationName: null },
        },
      },
    };
    // The live chat and the recorded terminal both keep their origin mark.
    useUiStore.getInitialState().railFolds = { ...DEFAULT_RAIL_FOLDS, sessionsRecord: true };

    for (const width of [RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH]) {
      useUiStore.getInitialState().railWidth = width;
      const markup = draw(HOME_BOARD_TAB_ID);
      expect(markup).toContain('aria-label="Started by the Automation BE Code Review"');
      expect(markup).toContain('aria-label="Started by an Automation"');
      expect(markup.match(/aria-label="Started by/g)).toHaveLength(2);
      expect(markup).toContain("Review the runtime migration\nAutomation · BE Code Review");
      expect(new DOMParser().parseFromString(markup, "text/html").body.textContent).not.toContain(
        "BE Code Review",
      );
      expect(markup).not.toContain('title="My shell"');
      expect(markup).toContain("My shell");
    }
  });

  it("pins the Main checkout under EVERY page, and cost under Now alone", () => {
    seedVenue();

    for (const page of ["now", "files", "search"] as const) {
      useUiStore.getInitialState().homeRailMode = page;
      const markup = draw("chat:s1");
      expect(markup).toContain('data-testid="home-checkout-footer"');
      // Outside the tabpanel: the checkout is true of the project whichever
      // page is up, so it must not be part of a page's content.
      const panelEnd = markup.indexOf('data-testid="home-checkout-footer"');
      expect(markup.slice(0, panelEnd)).toContain("</section>");
    }

    // Cost is Now's alone — a spend figure under a folder listing is a fact
    // about neither the folder nor the file. Absent here in any case: a static
    // render has metered nothing, and "nothing metered" is not "$0.00".
    useUiStore.getInitialState().homeRailMode = "files";
    expect(draw("chat:s1")).not.toContain('data-testid="home-usage-footer"');
  });

  it("says the checkout's branch on the row and its one fact beside it", () => {
    seedVenue();
    const markup = draw("chat:s1");

    // The identity is the branch, drawn from the venue reading rather than
    // from anything this surface invents.
    expect(markup).toContain("volli/VC-288-narrow-pane-follow-ups-beyond-vc-264");
    // The one fact: what is loose in the tree right now (2 modified + 1 added),
    // in the words the body under it uses.
    expect(markup).toContain("3 uncommitted");
    expect(markup).toContain('data-testid="home-checkout-glance"');
  });

  it("keeps the whole checkout path within a keyboard's reach, in the fold", () => {
    // VC-288. A path truncates in a rail this narrow and its full form was
    // behind a pointer; the reveal is a focus stop Radix opens on focus as well
    // as on hover. It lives in the footer's body now rather than on a card.
    seedVenue();
    useUiStore.getInitialState().railFolds = { ...DEFAULT_RAIL_FOLDS, worktree: true };

    const markup = draw("chat:s1");

    expect(markup).toContain(
      'aria-label="Worktree · /Users/someone/.volli/worktrees/volli-code-f3732f45/VC-288-narrow-pane"',
    );
    expect(markup.slice(markup.indexOf("home-checkout-footer"))).toContain("<button");
    // The branch is on the row above, so the body does not repeat it; what it
    // adds is the count the row could not fit.
    expect(markup).toContain("3 uncommitted files");
  });

  it("holds the checkout's own read states apart", () => {
    useUiStore.getInitialState().railFolds = { ...DEFAULT_RAIL_FOLDS, worktree: true };
    // Before any read: the body waits, and the row states no fact — a
    // placeholder fact would be a claim about a tree nobody has looked at.
    expect(draw("chat:s1")).toContain('data-testid="home-checkout-loading"');
    expect(draw("chat:s1")).not.toContain('data-testid="home-checkout-glance"');

    useVenueStore.getInitialState().byScope = {
      [venueKey("p1", null)]: { status: "error", error: "not a git repository" },
    };
    const failed = draw("chat:s1");

    expect(failed).not.toContain('data-testid="home-checkout-loading"');
    expect(failed).toContain('data-testid="home-checkout-error"');
    expect(failed).toContain("Retry");
    // A fault leads the glance: every other fact about the tree is unreadable
    // while it stands.
    expect(failed).toContain("Unreadable");
    // The diagnostic rides `title`, never the row — at this width it pushes
    // Retry off the end.
    expect(failed).toContain('title="not a git repository"');
  });

  it("ships no Mentioned block until there is a mechanism behind it", () => {
    // VC-104 owns `@vc-nn` backlinks; a section that can never fill in this
    // build is furniture.
    expect(draw("chat:s1")).not.toContain("Mentioned");
  });

  it("draws the Board Session roster on Now rather than on a page of its own", () => {
    // VC-406: Now described the Session in front and a second page listed the
    // Sessions there are, which is one question split across two tabs.
    useProjectSessionsStore.getInitialState().byProject = {
      p1: { terminal: [], chat: [], provenance: {} },
    };
    useProjectSessionsStore.getInitialState().listingState = { p1: "loaded" };
    const markup = draw(HOME_BOARD_TAB_ID);

    expect(markup).toContain("Board sessions");
  });

  it("holds the roster's rows until the project's listing answers (VC-383)", () => {
    // Static markup reads the store's initial state, which here is exactly the
    // state before any read: the block must hold the rows' box, not say the
    // project has no Sessions.
    const markup = draw(HOME_BOARD_TAB_ID);

    expect(markup).toContain('data-testid="home-sessions-loading"');
    expect(markup).not.toContain("No sessions yet");
  });

  it("says the roster is empty only once the listing has said so", () => {
    useProjectSessionsStore.getInitialState().byProject = {
      p1: { terminal: [], chat: [], provenance: {} },
    };
    useProjectSessionsStore.getInitialState().listingState = { p1: "loaded" };
    const markup = draw(HOME_BOARD_TAB_ID);

    expect(markup).not.toContain('data-testid="home-sessions-loading"');
    expect(markup).toContain("No sessions yet");
  });

  // VC-406, the spec review's finding 6. Home mapped every open, non-ended
  // terminal to `ready`/"Open": a pane blocked at a permission prompt read the
  // same as one printing a build log, and sorted wherever its record's age put
  // it. The rail reads the sessions store's own facts now — the same ones the
  // Ticket rail's roster derives from.
  it("says what a Board terminal is actually doing, attention first", () => {
    seedTerminals([
      terminal("noisy", "Run the build"),
      terminal("blocked", "Ask before writing"),
      terminal("gone", "Yesterday's shell"),
    ]);
    useSessionsStore.getInitialState().byOwner = {
      p1: {
        tabs: [tab("noisy", pane("noisy")), tab("blocked", pane("blocked"))],
        activeSessionId: "noisy",
      },
    };
    useSessionsStore.getInitialState().lastOutputAt = { noisy: Date.now() - 1_000 };
    useSessionsStore.getInitialState().harness = { blocked: harness("waiting") };

    const markup = draw(HOME_BOARD_TAB_ID);

    // The app's own vocabulary, not this surface's invented one.
    expect(markup).toContain("Waiting for you");
    expect(markup).toContain("Working");
    expect(markup).not.toContain(">Open<");
    // The one row asking for a person leads, whatever printed more recently.
    expect(markup.indexOf("Ask before writing")).toBeLessThan(markup.indexOf("Run the build"));
    // …and only the Session no pane holds is in the record under them.
    expect(markup).toContain("Show 1 earlier session");
  });

  // A split's second pane has a durable record of its own, so it is in the
  // project's listing; matching that listing against the store's TAB ids alone
  // drew it as an inert "Exited" row while its PTY was printing.
  it("keeps a live split pane on the page rather than in the record", () => {
    seedTerminals([terminal("root", "Left pane"), terminal("split", "Right pane")]);
    useSessionsStore.getInitialState().byOwner = {
      p1: {
        tabs: [
          tab("root", {
            kind: "split",
            id: "s1",
            direction: "vertical",
            ratio: 0.5,
            first: pane("root"),
            second: pane("split"),
          }),
        ],
        activeSessionId: "root",
      },
    };

    const markup = draw(HOME_BOARD_TAB_ID);
    const live = markup.slice(markup.indexOf('data-testid="home-sessions-live"'));

    expect(live).toContain("Left pane");
    expect(live).toContain("Right pane");
    // Nothing is over, so the roster offers no fold at all.
    expect(markup).not.toContain('data-testid="home-sessions-fold"');
    expect(markup).not.toContain("Exited");
  });

  it("stands the skeleton down after a failed listing without calling the Project empty", () => {
    useProjectSessionsStore.getInitialState().listingState = { p1: "failed" };
    const markup = draw(HOME_BOARD_TAB_ID);

    expect(markup).not.toContain('data-testid="home-sessions-loading"');
    expect(markup).not.toContain("No sessions yet");
    // The failure is the body, and it brings the retry with it: a refused read
    // that drew nothing but a sentence left the reader with no way to try again.
    expect(markup).toContain('data-testid="home-sessions-error"');
    expect(markup).toContain("Sessions failed to read");
    expect(markup).toContain("Retry");
  });

  it("names a host that grants no Sessions instead of a failure with a Retry (VC-713, B3)", () => {
    useProjectSessionsStore.getInitialState().byProject = {
      p1: { terminal: [], chat: [], provenance: {}, read: {} },
    };
    useProjectSessionsStore.getInitialState().listingState = { p1: "loaded" };
    useRemoteSessionAvailabilityStore.getInitialState().unavailable = {
      p1: "Sessions aren’t available on box — update it to use them here",
    };
    try {
      const markup = draw(HOME_BOARD_TAB_ID);
      expect(markup).toContain('data-testid="home-sessions-unavailable"');
      expect(markup).toContain("Sessions aren’t available on box — update it to use them here");
      expect(markup).not.toContain("No sessions yet");
      expect(markup).not.toContain("Retry");
    } finally {
      useRemoteSessionAvailabilityStore.getInitialState().unavailable = {};
    }
  });
});
