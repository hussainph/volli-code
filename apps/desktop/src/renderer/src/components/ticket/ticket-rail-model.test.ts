import { describe, expect, it } from "vite-plus/test";

import { TICKET_BODY_TAB_ID } from "./ticket-body-tab";
import {
  DEFAULT_TICKET_RAIL_MODE,
  TICKET_RAIL_MODES,
  TICKET_RAIL_MODE_LABELS,
  type TicketRailChrome,
  availableRailModes,
  isTicketRailMode,
  resolvePersistedRailMode,
  resolveRailMode,
  selectRailDestination,
  selectRailMode,
} from "./ticket-rail-model";

describe("selectRailMode (decision #46)", () => {
  it("changes the rail page without opening, closing, or replacing the active main-view tab", () => {
    const before: TicketRailChrome = {
      mode: "now",
      activeTabId: TICKET_BODY_TAB_ID,
    };

    for (const mode of TICKET_RAIL_MODES) {
      const after = selectRailMode(before, mode);
      expect(after.mode).toBe(mode);
      expect(after.activeTabId).toBe(before.activeTabId);
    }

    // Starting from a non-body tab must also leave that tab alone.
    const onSession: TicketRailChrome = {
      mode: "now",
      activeTabId: "session-abc",
    };
    expect(selectRailMode(onSession, "files").activeTabId).toBe("session-abc");
    expect(selectRailMode(onSession, "changes").activeTabId).toBe("session-abc");
  });

  // Search appends rather than sitting beside Files (VC-193): the list is a
  // keyboard order too, so a page inserted in the middle would move every page
  // after it under a reader's fingers.
  it("offers exactly the four Calm Stack pages, in tab order", () => {
    expect(availableRailModes()).toEqual(["now", "changes", "files", "search"]);
    expect(resolveRailMode({ mode: "changes", activeTabId: TICKET_BODY_TAB_ID })).toBe("changes");
    expect(resolveRailMode({ mode: "search", activeTabId: TICKET_BODY_TAB_ID })).toBe("search");
  });

  it("labels the pages the way the tab pill reads them", () => {
    expect(TICKET_RAIL_MODE_LABELS).toEqual({
      now: "Now",
      changes: "Diffs",
      files: "Files",
      search: "Search",
    });
  });

  // The rule the whole page contract exists for, restated for the new page: a
  // rail switching to Search must not open, close or retarget a main-view tab.
  it("leaves the active tab alone when Search is selected", () => {
    const chrome: TicketRailChrome = { mode: "files", activeTabId: "session-abc" };
    expect(selectRailMode(chrome, "search")).toEqual({
      mode: "search",
      activeTabId: "session-abc",
    });
  });
});

describe("selectRailDestination", () => {
  it("retargets the tab and leaves the page alone", () => {
    const chrome: TicketRailChrome = {
      mode: "changes",
      activeTabId: TICKET_BODY_TAB_ID,
    };
    const after = selectRailDestination(chrome, "session-abc");
    expect(after.mode).toBe("changes");
    expect(after.activeTabId).toBe("session-abc");
  });
});

describe("isTicketRailMode", () => {
  it("accepts every declared page and nothing else", () => {
    for (const mode of TICKET_RAIL_MODES) expect(isTicketRailMode(mode)).toBe(true);
    expect(isTicketRailMode("bogus")).toBe(false);
    expect(isTicketRailMode(null)).toBe(false);
    // The retired pages are readable but are not pages any more.
    expect(isTicketRailMode("sessions")).toBe(false);
    expect(isTicketRailMode("properties")).toBe(false);
    expect(isTicketRailMode("session")).toBe(false);
  });
});

describe("resolvePersistedRailMode", () => {
  it("prefers a page this build still offers", () => {
    expect(resolvePersistedRailMode({ railMode: "now" })).toBe("now");
    expect(resolvePersistedRailMode({ railMode: "changes" })).toBe("changes");
    expect(resolvePersistedRailMode({ railMode: "files" })).toBe("files");
    // A live page wins over a legacy key that would say otherwise.
    expect(resolvePersistedRailMode({ railMode: "files", detailsExpanded: true })).toBe("files");
  });

  // Every string a shipped build could have written, and where its user lands.
  // A retired page that stops resolving does not error — it strands whoever
  // persisted it, silently, on the next launch.
  it.each([
    // The session list is the tail of the Now page.
    ["sessions", "now"],
    // The Details drawer's successor folded inline into Now.
    ["properties", "now"],
    // A contextual rail surface, removed rather than repurposed.
    ["session", "now"],
  ] as const)("lands the retired %s page on %s", (stored, expected) => {
    expect(resolvePersistedRailMode({ railMode: stored })).toBe(expected);
    // A retired page still wins over the legacy drawer key beside it.
    expect(resolvePersistedRailMode({ railMode: stored, detailsExpanded: true })).toBe(expected);
  });

  it("migrates the pre-icon-rail Details drawer onto the page that absorbed it", () => {
    expect(resolvePersistedRailMode({ detailsExpanded: true })).toBe("now");
    expect(resolvePersistedRailMode({ railMode: "bogus", detailsExpanded: true })).toBe("now");
    expect(resolvePersistedRailMode({ detailsExpanded: false })).toBe(DEFAULT_TICKET_RAIL_MODE);
  });

  it("defaults when nothing usable is persisted", () => {
    expect(DEFAULT_TICKET_RAIL_MODE).toBe("now");
    expect(resolvePersistedRailMode({})).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolvePersistedRailMode({ railMode: "bogus" })).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolvePersistedRailMode({ railMode: 7 })).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolvePersistedRailMode({ railMode: null })).toBe(DEFAULT_TICKET_RAIL_MODE);
    // `toString` resolves on a bare object literal — a prototype-chain hit must
    // not be mistaken for a retired page.
    expect(resolvePersistedRailMode({ railMode: "toString" })).toBe(DEFAULT_TICKET_RAIL_MODE);
  });
});
