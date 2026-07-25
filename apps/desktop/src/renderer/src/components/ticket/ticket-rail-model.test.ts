import { describe, expect, it } from "vite-plus/test";

import { TICKET_BODY_TAB_ID } from "./ticket-body-tab";
import { TICKET_RAIL_MODES, type TicketRailChrome, selectRailMode } from "./ticket-rail-model";

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
});
