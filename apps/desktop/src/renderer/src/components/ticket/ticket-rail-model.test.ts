import { describe, expect, it } from "vite-plus/test";

import { TICKET_BODY_TAB_ID } from "./ticket-body-tab";
import {
  DEFAULT_TICKET_RAIL_MODE,
  TICKET_RAIL_MODES,
  type TicketRailChrome,
  availableRailModes,
  isTicketRailMode,
  resolvePersistedRailMode,
  resolveRailMode,
  selectRailDestination,
  selectRailMode,
} from "./ticket-rail-model";

describe("selectRailMode (decision #46)", () => {
  it("changes the rail mode without opening, closing, or replacing the active main-view tab", () => {
    const before: TicketRailChrome = {
      mode: "sessions",
      activeTabId: TICKET_BODY_TAB_ID,
    };

    for (const mode of TICKET_RAIL_MODES) {
      const after = selectRailMode(before, mode);
      expect(after.mode).toBe(mode);
      expect(after.activeTabId).toBe(before.activeTabId);
    }

    // Starting from a non-body tab must also leave that tab alone.
    const onSession: TicketRailChrome = {
      mode: "properties",
      activeTabId: "session-abc",
    };
    expect(selectRailMode(onSession, "files").activeTabId).toBe("session-abc");
    expect(selectRailMode(onSession, "changes").activeTabId).toBe("session-abc");
  });

  it("offers every mode in strip order", () => {
    expect(availableRailModes()).toEqual([...TICKET_RAIL_MODES]);
    expect(resolveRailMode({ mode: "changes", activeTabId: TICKET_BODY_TAB_ID })).toBe("changes");
  });
});

describe("selectRailDestination", () => {
  it("retargets the tab and leaves the mode alone", () => {
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
  it("accepts every declared mode and nothing else", () => {
    for (const mode of TICKET_RAIL_MODES) expect(isTicketRailMode(mode)).toBe(true);
    expect(isTicketRailMode("bogus")).toBe(false);
    expect(isTicketRailMode(null)).toBe(false);
  });
});

describe("resolvePersistedRailMode", () => {
  it("prefers an explicit railMode, else migrates detailsExpanded:true to properties", () => {
    expect(resolvePersistedRailMode({ railMode: "files" })).toBe("files");
    // The removed Session navigator must not strand existing installs on an
    // unavailable surface, even if a legacy drawer value is also present.
    expect(resolvePersistedRailMode({ railMode: "session" })).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolvePersistedRailMode({ railMode: "session", detailsExpanded: true })).toBe(
      DEFAULT_TICKET_RAIL_MODE,
    );
    expect(resolvePersistedRailMode({ railMode: "bogus", detailsExpanded: true })).toBe(
      "properties",
    );
    expect(resolvePersistedRailMode({ detailsExpanded: true })).toBe("properties");
    expect(resolvePersistedRailMode({ detailsExpanded: false })).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolvePersistedRailMode({})).toBe(DEFAULT_TICKET_RAIL_MODE);
  });
});
