import { describe, expect, it } from "vite-plus/test";

import { TICKET_BODY_TAB_ID } from "./ticket-body-tab";
import {
  DEFAULT_TICKET_RAIL_MODE,
  TICKET_RAIL_MODES,
  type TicketRailChrome,
  availableRailModes,
  isRailModeAvailable,
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
      activeTabKind: "session",
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

  it("falls back to the default when the requested mode is not offered", () => {
    const onBody: TicketRailChrome = { mode: "files", activeTabId: TICKET_BODY_TAB_ID };
    expect(selectRailMode(onBody, "session").mode).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(selectRailMode(onBody, "session").activeTabId).toBe(TICKET_BODY_TAB_ID);

    const onFile: TicketRailChrome = {
      mode: "files",
      activeTabId: "file:src/a.ts",
      activeTabKind: "file",
    };
    expect(selectRailMode(onFile, "session").mode).toBe(DEFAULT_TICKET_RAIL_MODE);
  });
});

describe("the session-mode gate", () => {
  it("offers session only while a session tab is active", () => {
    expect(isRailModeAvailable("session", { activeTabKind: "session" })).toBe(true);
    expect(isRailModeAvailable("session", { activeTabKind: "body" })).toBe(false);
    expect(isRailModeAvailable("session", { activeTabKind: "file" })).toBe(false);
    expect(isRailModeAvailable("session", { activeTabKind: "diff" })).toBe(false);
    expect(isRailModeAvailable("session", {})).toBe(false);

    // Every unconditional mode stays available regardless of the active tab.
    for (const mode of TICKET_RAIL_MODES) {
      if (mode === "session") continue;
      expect(isRailModeAvailable(mode, {})).toBe(true);
      expect(isRailModeAvailable(mode, { activeTabKind: "session" })).toBe(true);
    }
  });

  it("lists offered modes in strip order", () => {
    expect(availableRailModes({})).toEqual(["sessions", "files", "changes", "properties"]);
    expect(availableRailModes({ activeTabKind: "session" })).toEqual([...TICKET_RAIL_MODES]);
  });

  it("renders the default while a stored session mode is out of context, then restores it", () => {
    const onDoc: TicketRailChrome = { mode: "session", activeTabId: TICKET_BODY_TAB_ID };
    expect(resolveRailMode(onDoc)).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolveRailMode({ ...onDoc, activeTabKind: "session" })).toBe("session");
    expect(resolveRailMode({ mode: "changes", activeTabId: TICKET_BODY_TAB_ID })).toBe("changes");
  });
});

describe("selectRailDestination", () => {
  it("retargets the tab and leaves the mode alone", () => {
    const chrome: TicketRailChrome = {
      mode: "changes",
      activeTabId: TICKET_BODY_TAB_ID,
      activeTabKind: "body",
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
    expect(resolvePersistedRailMode({ railMode: "session" })).toBe("session");
    expect(resolvePersistedRailMode({ railMode: "bogus", detailsExpanded: true })).toBe(
      "properties",
    );
    expect(resolvePersistedRailMode({ detailsExpanded: true })).toBe("properties");
    expect(resolvePersistedRailMode({ detailsExpanded: false })).toBe(DEFAULT_TICKET_RAIL_MODE);
    expect(resolvePersistedRailMode({})).toBe(DEFAULT_TICKET_RAIL_MODE);
  });
});
