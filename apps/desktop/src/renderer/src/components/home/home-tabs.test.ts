import { describe, expect, it } from "vite-plus/test";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { HOME_BOARD_TAB_ID, resolveHomeTabs, sanitizeHomeActiveTab } from "./home-tabs";

/** The default input: a hydrated project with nothing open and the Board recorded. */
function input(over: Partial<Parameters<typeof resolveHomeTabs>[0]> = {}) {
  return {
    tabIds: [] as readonly string[],
    recorded: HOME_BOARD_TAB_ID,
    containerActive: null,
    durableChatIds: [] as readonly string[] | undefined,
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
