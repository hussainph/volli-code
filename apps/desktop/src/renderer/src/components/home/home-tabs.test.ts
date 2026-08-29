import { describe, expect, it } from "vite-plus/test";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import {
  HOME_BOARD_TAB_ID,
  browserTabId,
  closeHomeTabHistory,
  resolveHomeTabs,
  sanitizeHomeActiveTab,
  visitHomeTab,
} from "./home-tabs";

/** The default input: a hydrated project with nothing open and the Board recorded. */
function input(over: Partial<Parameters<typeof resolveHomeTabs>[0]> = {}) {
  return {
    tabIds: [] as readonly string[],
    recorded: HOME_BOARD_TAB_ID,
    containerActive: null,
    durableChatIds: [] as readonly string[] | undefined,
    browserTabsHydrated: true,
    hydrated: true,
    ...over,
  };
}

const SETTLED = { kind: "settled" } as const;

describe("resolveHomeTabs — which Home tab is in front", () => {
  it("puts the Board in front when it is what was recorded, whatever else is open", () => {
    expect(resolveHomeTabs(input({ tabIds: ["term-1"], containerActive: "term-1" }))).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: SETTLED,
    });
  });

  it("puts the Board in front for a project that has never had a Session", () => {
    expect(resolveHomeTabs(input())).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });

  it("prefers the recorded tab while it still names one", () => {
    expect(
      resolveHomeTabs(
        input({ tabIds: ["term-1", "term-2"], recorded: "term-2", containerActive: "term-1" }),
      ),
    ).toEqual({ active: "term-2", restore: SETTLED });
  });

  it("falls back to the terminal container's own active tab, so closing the chat covering a terminal shows that terminal", () => {
    // The recorded chat is gone; `term-2` is what the terminal surface was last on.
    expect(
      resolveHomeTabs(
        input({
          tabIds: ["term-1", "term-2"],
          recorded: chatTabId("gone"),
          containerActive: "term-2",
          durableChatIds: [],
        }),
      ),
    ).toEqual({ active: "term-2", restore: SETTLED });
  });

  it("falls back to the head of the strip when the container names nothing open", () => {
    expect(
      resolveHomeTabs(
        input({ tabIds: ["term-1", "term-2"], recorded: "closed", containerActive: "closed" }),
      ),
    ).toEqual({ active: "term-1", restore: SETTLED });
  });

  it("falls back to the Board when the last Session tab closes", () => {
    expect(resolveHomeTabs(input({ recorded: "closed", containerActive: "closed" }))).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: SETTLED,
    });
  });
});

describe("resolveHomeTabs — restoring the Session that was in front on relaunch", () => {
  it("waits while the project's durable Session listing has not answered yet", () => {
    // "Not hydrated yet" must never read as "gone": resetting here would
    // silently drop the Session the user left in front.
    expect(
      resolveHomeTabs(
        input({ recorded: chatTabId("sess-9"), durableChatIds: undefined, hydrated: false }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: { kind: "pending" } });
  });

  it("adopts the recorded Session once the listing confirms it exists", () => {
    expect(
      resolveHomeTabs(
        input({
          recorded: chatTabId("sess-9"),
          durableChatIds: ["sess-1", "sess-9"],
          hydrated: false,
        }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: { kind: "adopt", sessionId: "sess-9" } });
  });

  it("settles on the fallback when the listing says the recorded Session is gone", () => {
    expect(
      resolveHomeTabs(
        input({ recorded: chatTabId("sess-9"), durableChatIds: ["sess-1"], hydrated: false }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });

  it("settles a persisted TERMINAL tab id without waiting — a PTY dies with the app", () => {
    expect(
      resolveHomeTabs(input({ recorded: "term-1", durableChatIds: undefined, hydrated: false })),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });

  it("never restores once the strip has been resolved for this run, so closing a tab cannot reopen it", () => {
    // The user just closed `sess-9`'s tab. Its Session is still durable, so an
    // ungated restore would adopt it straight back.
    expect(
      resolveHomeTabs(
        input({ recorded: chatTabId("sess-9"), durableChatIds: ["sess-9"], hydrated: true }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });

  it("waits for Browser Tabs to hydrate before discarding a recorded browser tab", () => {
    expect(
      resolveHomeTabs(
        input({
          recorded: browserTabId("tab-9"),
          browserTabsHydrated: false,
          hydrated: false,
        }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: { kind: "pending" } });
  });

  it("needs no durable Session lookup when a restored File tab is already open", () => {
    expect(
      resolveHomeTabs(
        input({
          tabIds: ["file:src/app.ts"],
          recorded: "file:src/app.ts",
          durableChatIds: undefined,
          hydrated: false,
        }),
      ),
    ).toEqual({ active: "file:src/app.ts", restore: SETTLED });
  });

  it("needs no restore when the recorded Session already has its tab open", () => {
    const tab = chatTabId("sess-9");
    expect(
      resolveHomeTabs(
        input({ tabIds: [tab], recorded: tab, durableChatIds: ["sess-9"], hydrated: false }),
      ),
    ).toEqual({ active: tab, restore: SETTLED });
  });

  it("needs no restore when the Board is what was recorded", () => {
    expect(resolveHomeTabs(input({ durableChatIds: undefined, hydrated: false }))).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: SETTLED,
    });
  });
});

describe("Home tab visit history", () => {
  it("visits and closes Browser Tabs by their prefixed opaque ids", () => {
    const browser = browserTabId("tab-7");
    const history = visitHomeTab([HOME_BOARD_TAB_ID, "file:a.ts"], browser);

    expect(history).toEqual([HOME_BOARD_TAB_ID, "file:a.ts", browser]);
    expect(
      closeHomeTabHistory({
        history,
        closedTabId: browser,
        openTabIds: [HOME_BOARD_TAB_ID, "file:a.ts"],
      }),
    ).toEqual({
      active: "file:a.ts",
      history: [HOME_BOARD_TAB_ID, "file:a.ts"],
    });
  });

  it("keeps tabs in most-recently-visited order without duplicates", () => {
    const history = visitHomeTab(
      visitHomeTab(visitHomeTab([], HOME_BOARD_TAB_ID), "chat:one"),
      "file:a.ts",
    );

    expect(visitHomeTab(history, "chat:one")).toEqual([HOME_BOARD_TAB_ID, "file:a.ts", "chat:one"]);
    expect(visitHomeTab(history, "file:a.ts")).toBe(history);
  });

  it("returns to the most recently visited tab that is still open", () => {
    expect(
      closeHomeTabHistory({
        history: [HOME_BOARD_TAB_ID, "chat:one", "file:a.ts", "file:b.ts"],
        closedTabId: "file:b.ts",
        openTabIds: [HOME_BOARD_TAB_ID, "chat:one", "file:a.ts"],
      }),
    ).toEqual({
      active: "file:a.ts",
      history: [HOME_BOARD_TAB_ID, "chat:one", "file:a.ts"],
    });
  });

  it("skips closed history and falls back to Board", () => {
    expect(
      closeHomeTabHistory({
        history: ["chat:closed", "file:closed.ts"],
        closedTabId: "file:closed.ts",
        openTabIds: [HOME_BOARD_TAB_ID],
      }),
    ).toEqual({ active: HOME_BOARD_TAB_ID, history: [HOME_BOARD_TAB_ID] });
  });
});

describe("sanitizeHomeActiveTab", () => {
  it("keeps a recorded tab id", () => {
    expect(sanitizeHomeActiveTab(chatTabId("sess-9"))).toBe(chatTabId("sess-9"));
    expect(sanitizeHomeActiveTab(HOME_BOARD_TAB_ID)).toBe(HOME_BOARD_TAB_ID);
  });

  it("falls back to the Board for anything a past build could have written", () => {
    for (const raw of [undefined, null, "", 7, {}, []]) {
      expect(sanitizeHomeActiveTab(raw)).toBe(HOME_BOARD_TAB_ID);
    }
  });
});
