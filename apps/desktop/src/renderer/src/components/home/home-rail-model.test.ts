import { describe, expect, it } from "vite-plus/test";
import type { ChatSessionRecord, SessionRecord } from "@volli/shared";

import {
  DEFAULT_HOME_RAIL_MODE,
  HOME_RAIL_MODES,
  HOME_RAIL_MODE_LABELS,
  homeSessionRows,
  sanitizeHomeRailMode,
  venuePathTail,
} from "./home-rail-model";

describe("Home rail pages", () => {
  it("opens on the resting page", () => {
    expect(DEFAULT_HOME_RAIL_MODE).toBe("now");
    expect(HOME_RAIL_MODES[0]).toBe(DEFAULT_HOME_RAIL_MODE);
  });

  // Every page appends, and that is the rule rather than an accident of two
  // tickets: the list is a keyboard order, so inserting one in the middle moves
  // every page after it under a reader's fingers.
  it("adds Project Files, then Search, after the two original pages", () => {
    expect(HOME_RAIL_MODES).toEqual(["now", "sessions", "files", "search"]);
    expect(HOME_RAIL_MODE_LABELS.files).toBe("Files");
    expect(HOME_RAIL_MODE_LABELS.search).toBe("Search");
  });

  it("names every page it offers", () => {
    for (const mode of HOME_RAIL_MODES) {
      expect(HOME_RAIL_MODE_LABELS[mode].length).toBeGreaterThan(0);
    }
  });
});

describe("sanitizeHomeRailMode", () => {
  it("keeps every page this build offers", () => {
    expect(sanitizeHomeRailMode("now")).toBe("now");
    expect(sanitizeHomeRailMode("sessions")).toBe("sessions");
    expect(sanitizeHomeRailMode("files")).toBe("files");
  });

  it("keeps the page this build added", () => {
    expect(sanitizeHomeRailMode("search")).toBe("search");
  });

  it("lands a retired or corrupt page on the resting one", () => {
    expect(sanitizeHomeRailMode("changes")).toBe(DEFAULT_HOME_RAIL_MODE);
    expect(sanitizeHomeRailMode(undefined)).toBe(DEFAULT_HOME_RAIL_MODE);
    expect(sanitizeHomeRailMode(3)).toBe(DEFAULT_HOME_RAIL_MODE);
  });
});

function chat(over: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "c1",
    title: "Shape the 0.1.0 train",
    projectId: "p1",
    ticketId: null,
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "idle",
    waitingOn: null,
    lastActivityAt: 10,
    bornTicketless: true,
    ...over,
  };
}

function terminal(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "t1",
    projectId: "p1",
    ticketId: null,
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "shell",
    placement: "tab",
    title: "Terminal 1",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    lastActivityAt: 20,
    bornTicketless: true,
    ...over,
  };
}

/** The dot one chat row draws. */
function chatDot(row: ChatSessionRecord) {
  return homeSessionRows([row], [], [], [])[0]?.state;
}

/** The dot one terminal row draws, given which terminals still have a tab. */
function terminalDot(row: SessionRecord, openTerminalIds: string[]) {
  return homeSessionRows([], [row], [], openTerminalIds)[0]?.state;
}

describe("homeSessionRows", () => {
  it("puts both kinds in one list, newest first", () => {
    const rows = homeSessionRows(
      [chat({ sessionId: "c1", lastActivityAt: 30 })],
      [terminal({ id: "t1", lastActivityAt: 40 })],
      [],
      [],
    );

    expect(rows.map((row) => row.id)).toEqual(["t1", "c1"]);
    expect(rows.map((row) => row.kind)).toEqual(["terminal", "chat"]);
  });

  it("marks the Sessions a tab is holding", () => {
    const rows = homeSessionRows([chat()], [terminal()], ["c1"], []);

    expect(rows.find((row) => row.id === "c1")?.open).toBe(true);
    expect(rows.find((row) => row.id === "t1")?.open).toBe(false);
  });

  it("reads a chat's liveness with waiting outranking working", () => {
    expect(chatDot(chat({ activity: "waiting" }))).toBe("waiting");
    expect(chatDot(chat({ activity: "working" }))).toBe("working");
    expect(chatDot(chat({ activity: "idle", live: true }))).toBe("ready");
    expect(chatDot(chat({ activity: "idle", live: false }))).toBe("idle");
  });

  it("calls a terminal live only while a tab holds it and it has not ended", () => {
    expect(terminalDot(terminal(), ["t1"])).toBe("ready");
    // A PTY dies with the app: a durable row with no tab is over, whatever the
    // ledger's `endedAt` says.
    expect(terminalDot(terminal(), [])).toBe("exited");
    expect(terminalDot(terminal({ endedAt: 5 }), ["t1"])).toBe("exited");
  });

  it("makes a chat a door whether or not a tab holds it", () => {
    // A transcript is durable, so a closed chat is re-adopted rather than lost.
    expect(homeSessionRows([chat()], [], ["c1"], [])[0]?.reopenable).toBe(true);
    expect(homeSessionRows([chat()], [], [], [])[0]?.reopenable).toBe(true);
  });

  it("makes a terminal a door only while its tab still holds a PTY", () => {
    // Nothing to bring forward once the pane is gone, so the row stops being a
    // target rather than becoming one that lands nowhere.
    expect(homeSessionRows([], [terminal()], [], ["t1"])[0]?.reopenable).toBe(true);
    expect(homeSessionRows([], [terminal()], [], [])[0]?.reopenable).toBe(false);
  });

  it("draws nothing for a project that has run nothing", () => {
    expect(homeSessionRows([], [], [], [])).toEqual([]);
  });
});

describe("venuePathTail", () => {
  it("keeps the tail, which is the part that identifies the venue", () => {
    expect(venuePathTail("/Users/p/Desktop/code/volli-code")).toBe("…/code/volli-code");
    expect(venuePathTail("/Users/p/.volli/worktrees/volli-code-abc/VC-81-auto-title")).toBe(
      "…/volli-code-abc/VC-81-auto-title",
    );
  });

  it("leaves a path that is already short enough alone", () => {
    expect(venuePathTail("/repo")).toBe("/repo");
    expect(venuePathTail("/code/repo")).toBe("/code/repo");
    expect(venuePathTail("")).toBe("");
  });

  it("survives a trailing slash", () => {
    expect(venuePathTail("/Users/p/code/volli-code/")).toBe("…/code/volli-code");
  });

  it("honours a caller's own depth", () => {
    expect(venuePathTail("/a/b/c/d", 1)).toBe("…/d");
  });
});
