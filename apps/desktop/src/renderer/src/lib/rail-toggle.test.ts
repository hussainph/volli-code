import { describe, expect, it } from "vite-plus/test";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { railToggleTargetForChrome, type RailToggleChrome } from "./rail-toggle";

function chrome(over: Partial<RailToggleChrome> = {}): RailToggleChrome {
  return {
    selectedProjectId: "p1",
    nav: "home",
    homeActiveTab: HOME_BOARD_TAB_ID,
    settingsOpen: false,
    openTicketId: null,
    terminalFocusActive: false,
    ...over,
  };
}

describe("railToggleTargetForChrome", () => {
  it("names the ticket rail while a ticket is the surface in front", () => {
    expect(railToggleTargetForChrome(chrome({ openTicketId: "t1" }))).toBe("ticket");
  });

  it("names Home's rail on one of the project's own Session tabs", () => {
    expect(railToggleTargetForChrome(chrome({ homeActiveTab: "chat:s1" }))).toBe("home");
    expect(railToggleTargetForChrome(chrome({ homeActiveTab: "terminal-session-1" }))).toBe("home");
  });

  it("still names Home's rail when a ticket is merely remembered behind it", () => {
    // `openTicketId` survives leaving the ticket; without the tab check this
    // would collapse a ticket rail nobody can see.
    expect(
      railToggleTargetForChrome(chrome({ homeActiveTab: "chat:s1", openTicketId: "t1" })),
    ).toBe("home");
  });

  it("names nothing on the plain board — the board has no rail", () => {
    expect(railToggleTargetForChrome(chrome())).toBeNull();
  });

  it("names nothing off Home, even with a ticket remembered", () => {
    expect(railToggleTargetForChrome(chrome({ nav: "files", openTicketId: "t1" }))).toBeNull();
    expect(
      railToggleTargetForChrome(chrome({ nav: "configure", homeActiveTab: "chat:s1" })),
    ).toBeNull();
  });

  it("names nothing from underneath Settings", () => {
    expect(
      railToggleTargetForChrome(chrome({ settingsOpen: true, homeActiveTab: "chat:s1" })),
    ).toBeNull();
    expect(
      railToggleTargetForChrome(chrome({ settingsOpen: true, openTicketId: "t1" })),
    ).toBeNull();
  });

  it("names nothing with no project selected", () => {
    expect(
      railToggleTargetForChrome(chrome({ selectedProjectId: null, homeActiveTab: "chat:s1" })),
    ).toBeNull();
  });

  it("names nothing from inside terminal focus, on either surface", () => {
    // Zen takes the whole canvas and both rails step aside, so the chord has
    // nothing on screen to collapse. Home's own terminals may enter it, which
    // is what makes the Session-tab arm reachable and not just the ticket's.
    expect(
      railToggleTargetForChrome(
        chrome({ homeActiveTab: "terminal-session-1", terminalFocusActive: true }),
      ),
    ).toBeNull();
    expect(
      railToggleTargetForChrome(chrome({ openTicketId: "t1", terminalFocusActive: true })),
    ).toBeNull();
  });
});
