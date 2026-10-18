import type { TabOrder } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import {
  HOME_BOARD_TAB_ID,
  browserTabId,
  closeHomeTabHistory,
  homeTabOrderReceipt,
  parseBrowserTabId,
  resolveHomeTabs,
  sanitizeHomeActiveTab,
  visitHomeTab,
} from "./home-tabs";

/** The default input: a hydrated project with nothing open and the Board recorded. */
function input(over: Partial<Parameters<typeof resolveHomeTabs>[0]> = {}) {
  return {
    tabIds: [] as readonly string[],
    recorded: HOME_BOARD_TAB_ID,
    recordedOrder: [] as TabOrder,
    containerActive: null,
    durableChatIds: [] as readonly string[] | undefined,
    browserTabsHydrated: true,
    hydrated: true,
    ...over,
  };
}

const SETTLED = { kind: "settled" } as const;

describe("Browser Home tab identity", () => {
  it("round-trips only a non-empty opaque Browser Tab id", () => {
    expect(parseBrowserTabId(browserTabId("tab-1"))).toBe("tab-1");
    expect(parseBrowserTabId("browser:")).toBeNull();
    expect(parseBrowserTabId("chat:tab-1")).toBeNull();
  });
});

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
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: { kind: "adopt", sessionIds: ["sess-9"] } });
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

describe("resolveHomeTabs — restoring the whole strip on relaunch (VC-105)", () => {
  const [a, b, c] = [chatTabId("sess-a"), chatTabId("sess-b"), chatTabId("sess-c")];
  /** The strip as it was left: three Sessions, a terminal and a file among them. */
  const strip: TabOrder = [a, "term-1", b, "file:src/app.ts", c];

  it("reopens every Session the strip names, in strip order, and nothing else", () => {
    // The terminal's PTY died with the app; the file tab restores itself (it
    // is resident in the File workspace), so only the chats are adopted.
    expect(
      resolveHomeTabs(
        input({
          recorded: b,
          recordedOrder: strip,
          durableChatIds: ["sess-c", "sess-b", "sess-a"],
          hydrated: false,
        }),
      ),
    ).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: { kind: "adopt", sessionIds: ["sess-a", "sess-b", "sess-c"] },
    });
  });

  it("holds the whole strip while the listing has not answered — never reads it as gone", () => {
    expect(
      resolveHomeTabs(
        input({ recorded: b, recordedOrder: strip, durableChatIds: undefined, hydrated: false }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: { kind: "pending" } });
  });

  it("drops a Session archived since the quit without failing its neighbours", () => {
    expect(
      resolveHomeTabs(
        input({
          recorded: a,
          recordedOrder: strip,
          durableChatIds: ["sess-a", "sess-c"],
          hydrated: false,
        }),
      ),
    ).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: { kind: "adopt", sessionIds: ["sess-a", "sess-c"] },
    });
  });

  it("settles once the adopted tabs are open, with the same tab in front", () => {
    expect(
      resolveHomeTabs(
        input({
          tabIds: [a, b, c, "file:src/app.ts"],
          recorded: b,
          recordedOrder: strip,
          durableChatIds: ["sess-a", "sess-b", "sess-c"],
          hydrated: false,
        }),
      ),
    ).toEqual({ active: b, restore: SETTLED });
  });

  it("lands on the Board when the tab in front did not survive, not on the head of the strip", () => {
    // `sess-b` was archived between quit and relaunch. Its neighbours came
    // back; which of them is first is an accident of the restore, so the
    // fallback a relaunch promises is the Board.
    expect(
      resolveHomeTabs(
        input({
          tabIds: [a, c],
          recorded: b,
          recordedOrder: strip,
          durableChatIds: ["sess-a", "sess-c"],
          hydrated: false,
        }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });

  it("lands on the Board when the tab in front was a terminal", () => {
    expect(
      resolveHomeTabs(
        input({
          tabIds: ["file:src/app.ts"],
          recorded: "term-1",
          recordedOrder: strip,
          durableChatIds: ["sess-a", "sess-b", "sess-c"],
          hydrated: false,
        }),
      ),
    ).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: { kind: "adopt", sessionIds: ["sess-a", "sess-b", "sess-c"] },
    });
  });

  it("restores the strip behind a tab in front that needs no restore of its own", () => {
    expect(
      resolveHomeTabs(
        input({ recordedOrder: [a, b], durableChatIds: ["sess-a", "sess-b"], hydrated: false }),
      ),
    ).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: { kind: "adopt", sessionIds: ["sess-a", "sess-b"] },
    });
    expect(
      resolveHomeTabs(
        input({
          tabIds: ["file:src/app.ts"],
          recorded: "file:src/app.ts",
          recordedOrder: [a],
          durableChatIds: ["sess-a"],
          hydrated: false,
        }),
      ),
    ).toEqual({ active: "file:src/app.ts", restore: { kind: "adopt", sessionIds: ["sess-a"] } });
  });

  it("brings back a tab in front the strip never named, after the strip — a record from before VC-105", () => {
    expect(
      resolveHomeTabs(
        input({
          recorded: c,
          recordedOrder: [a, b],
          durableChatIds: ["sess-a", "sess-b", "sess-c"],
          hydrated: false,
        }),
      ),
    ).toEqual({
      active: HOME_BOARD_TAB_ID,
      restore: { kind: "adopt", sessionIds: ["sess-a", "sess-b", "sess-c"] },
    });
  });

  it("adopts only the Sessions that are still missing a tab", () => {
    expect(
      resolveHomeTabs(
        input({
          tabIds: [a],
          recorded: a,
          recordedOrder: [a, b],
          durableChatIds: ["sess-a", "sess-b"],
          hydrated: false,
        }),
      ),
    ).toEqual({ active: a, restore: { kind: "adopt", sessionIds: ["sess-b"] } });
  });

  it("settles a strip of terminals without waiting for the listing", () => {
    expect(
      resolveHomeTabs(
        input({ recordedOrder: ["term-1", "term-2"], durableChatIds: undefined, hydrated: false }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });

  it("holds the strip behind a recorded Browser Tab until main's registry answers", () => {
    expect(
      resolveHomeTabs(
        input({
          recorded: browserTabId("tab-9"),
          recordedOrder: [a],
          durableChatIds: ["sess-a"],
          browserTabsHydrated: false,
          hydrated: false,
        }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: { kind: "pending" } });
  });

  it("never restores once this run has resolved the strip, so a closed Session stays closed", () => {
    expect(
      resolveHomeTabs(
        input({ recordedOrder: [a, b], durableChatIds: ["sess-a", "sess-b"], hydrated: true }),
      ),
    ).toEqual({ active: HOME_BOARD_TAB_ID, restore: SETTLED });
  });
});

describe("homeTabOrderReceipt — the strip's record", () => {
  const drawn = [HOME_BOARD_TAB_ID, chatTabId("sess-b"), "term-1", chatTabId("draft"), "file:a.ts"];

  it("records nothing until the restore has settled — a missing tab may not have arrived yet", () => {
    expect(homeTabOrderReceipt({ drawn, transient: new Set(), restored: false })).toBeNull();
  });

  it("records the strip as drawn, without the Board or an empty Draft", () => {
    expect(
      homeTabOrderReceipt({ drawn, transient: new Set([chatTabId("draft")]), restored: true }),
    ).toEqual([chatTabId("sess-b"), "term-1", "file:a.ts"]);
  });

  it("records an empty strip, so a record carrying nothing can be pruned", () => {
    expect(
      homeTabOrderReceipt({ drawn: [HOME_BOARD_TAB_ID], transient: new Set(), restored: true }),
    ).toEqual([]);
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
