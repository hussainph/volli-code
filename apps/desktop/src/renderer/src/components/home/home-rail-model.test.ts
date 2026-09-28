import { describe, expect, it } from "vite-plus/test";
import type {
  ChatSessionRecord,
  SessionHarnessState,
  SessionRecord,
  VenueSnapshot,
} from "@volli/shared";

import { WORKING_WINDOW_MS, type SessionTab } from "@renderer/stores/sessions";
import {
  DEFAULT_HOME_RAIL_MODE,
  EMPTY_HOME_TERMINAL_PULSE,
  HOME_RAIL_MODES,
  HOME_RAIL_MODE_LABELS,
  HOME_SESSION_FILTER_THRESHOLD,
  chatSessionIsLive,
  filterHomeSessionRows,
  homeCheckoutGlance,
  homeLivePanes,
  homeSessionRows,
  homeTerminalIndex,
  nextHomeSessionStatusChangeAt,
  partitionHomeSessionRows,
  sanitizeHomeRailMode,
  venuePathTail,
  type HomeLivePane,
  type HomeTerminalPulse,
} from "./home-rail-model";

describe("Home rail pages", () => {
  it("opens on the resting page", () => {
    expect(DEFAULT_HOME_RAIL_MODE).toBe("now");
    expect(HOME_RAIL_MODES[0]).toBe(DEFAULT_HOME_RAIL_MODE);
  });

  // Every page appends, and that is the rule rather than an accident of two
  // tickets: the list is a keyboard order, so inserting one in the middle moves
  // every page after it under a reader's fingers. VC-406 REMOVED one instead:
  // the roster is a block on Now, so Sessions is not a page and the order of
  // the three that remain is unchanged.
  it("offers exactly Now, Files and Search, in that order", () => {
    expect(HOME_RAIL_MODES).toEqual(["now", "files", "search"]);
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
    expect(sanitizeHomeRailMode("files")).toBe("files");
    expect(sanitizeHomeRailMode("search")).toBe("search");
  });

  // A RETIRED page is not a corrupt one: somebody who left the rail on Sessions
  // was reading the roster, and the roster moved to Now.
  it("sends a retired page to where its content went", () => {
    expect(sanitizeHomeRailMode("sessions")).toBe("now");
  });

  it("lands a corrupt page on the resting one", () => {
    expect(sanitizeHomeRailMode("changes")).toBe(DEFAULT_HOME_RAIL_MODE);
    expect(sanitizeHomeRailMode(undefined)).toBe(DEFAULT_HOME_RAIL_MODE);
    expect(sanitizeHomeRailMode(3)).toBe(DEFAULT_HOME_RAIL_MODE);
    expect(sanitizeHomeRailMode(null)).toBe(DEFAULT_HOME_RAIL_MODE);
    expect(sanitizeHomeRailMode({ mode: "files" })).toBe(DEFAULT_HOME_RAIL_MODE);
  });

  // Persisted JSON can hold any string, including the ones every ordinary
  // object already answers to. Against an object-literal lookup `"__proto__"`
  // returns `Object.prototype` and `"toString"` returns a function — both
  // truthy, so `?? DEFAULT` never runs and the rail rehydrates onto something
  // that is not a page at all.
  it("lands a prototype key on the resting page like any other corrupt value", () => {
    for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(sanitizeHomeRailMode(key)).toBe(DEFAULT_HOME_RAIL_MODE);
    }
  });

  it("always returns a page this build offers, whatever it was handed", () => {
    for (const raw of ["__proto__", "toString", "sessions", "changes", "now", 7, null, []]) {
      expect(HOME_RAIL_MODES).toContain(sanitizeHomeRailMode(raw));
    }
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
    outcome: null,
    lastActivityAt: 10,
    bornTicketless: true,
    role: "project",
    parentSessionId: null,
    model: null,
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

/** The instant every pulse below is read at. */
const NOW = 1_700_000_000_000;

/**
 * This project's slice of the sessions store, as the rail passes it in. The
 * resting shape knows nothing — no pane, no output, nothing parked, nothing
 * reporting — which is what a project with no open tabs actually looks like.
 */
function pulse(over: Partial<HomeTerminalPulse> = {}): HomeTerminalPulse {
  return { ...EMPTY_HOME_TERMINAL_PULSE, now: NOW, ...over };
}

/** `ids` as live panes, each the root of its own tab — the ordinary case. */
function panes(...ids: string[]): Map<string, HomeLivePane> {
  return new Map(ids.map((id) => [id, { exitCode: null, tabId: id }]));
}

/** What a harness has declared about one pane; everything else is the resting default. */
function harness(declared: SessionHarnessState["declared"]): SessionHarnessState {
  return {
    harnessId: "claude-code",
    expectsEvents: true,
    declaresInputNeeded: true,
    startedAt: NOW - 60_000,
    delivered: true,
    declared,
    newestFiredAt: null,
  };
}

/** The dot one chat row draws. */
function chatDot(row: ChatSessionRecord) {
  return homeSessionRows([row], [], [], pulse())[0]?.state;
}

/** The dot and the word one terminal row draws, given this project's live facts. */
function terminalRow(row: SessionRecord, over: Partial<HomeTerminalPulse> = {}) {
  const built = homeSessionRows([], [row], [], pulse(over))[0];
  return { state: built?.state, label: built?.stateLabel, live: built?.live };
}

/** One reading of the Main checkout, as the venue store holds it. */
function venue(over: Partial<VenueSnapshot> = {}): VenueSnapshot {
  return {
    kind: "main-checkout",
    path: "/code/volli-code",
    branch: "main",
    files: { committed: 0, modified: 0, added: 0, untracked: 0 },
    diff: null,
    ...over,
  };
}

describe("homeSessionRows", () => {
  it("puts both kinds in one list, newest first", () => {
    const rows = homeSessionRows(
      [chat({ sessionId: "c1", lastActivityAt: 30 })],
      [terminal({ id: "t1", lastActivityAt: 40 })],
      [],
      pulse(),
    );

    expect(rows.map((row) => row.id)).toEqual(["t1", "c1"]);
    expect(rows.map((row) => row.kind)).toEqual(["terminal", "chat"]);
  });

  it("marks the Sessions a tab is holding", () => {
    const rows = homeSessionRows([chat()], [terminal()], ["c1"], pulse());

    expect(rows.find((row) => row.id === "c1")?.open).toBe(true);
    expect(rows.find((row) => row.id === "t1")?.open).toBe(false);
  });

  it("reads a chat's activity with waiting outranking working", () => {
    expect(chatDot(chat({ activity: "waiting" }))).toBe("waiting");
    expect(chatDot(chat({ activity: "working" }))).toBe("working");
    // Attachment is not a visual state. Both quiet rows use the same idle dot.
    expect(chatDot(chat({ activity: "idle", live: true }))).toBe("idle");
    expect(chatDot(chat({ activity: "idle", live: false }))).toBe("idle");
    // A turn that died is not that quiet (VC-324): it keeps its own dot.
    expect(chatDot(chat({ activity: "interrupted" }))).toBe("interrupted");
  });

  it("calls a terminal live only while a live pane holds it", () => {
    expect(terminalRow(terminal(), { panes: panes("t1") }).live).toBe(true);
    // A PTY dies with the app: a durable row no pane holds is over, whatever
    // the ledger's `endedAt` says.
    expect(terminalRow(terminal()).live).toBe(false);
    expect(terminalRow(terminal({ endedAt: 5 }), { panes: panes("t1") }).live).toBe(false);
    // The pane is still in the layout, but its shell is gone.
    expect(
      terminalRow(terminal(), { panes: new Map([["t1", { exitCode: 0, tabId: "t1" }]]) }).live,
    ).toBe(false);
  });

  // VC-406, the spec review's finding 6: Home mapped EVERY open, non-ended
  // terminal to `ready`/"Open" — so a pane blocked at a permission prompt, a
  // parked pane and a pane printing a build log read identically, while the
  // Ticket rail derived all three from `sessionActivityState`. One Session,
  // two answers, and the one that mattered most was the one Home could not say.
  it("derives a terminal's state from the same facts the Ticket roster does", () => {
    const open = { panes: panes("t1") };

    // A harness's own word outranks output recency: a blocked agent prints
    // nothing, so recency alone reads it as quiet — exactly backwards.
    expect(terminalRow(terminal(), { ...open, harness: { t1: harness("waiting") } })).toMatchObject(
      { state: "waiting", label: "Waiting for you", live: true },
    );
    // SIGSTOP'd by the warm-park tier, and still a Session to go back to.
    expect(
      terminalRow(terminal(), { ...open, parkState: { t1: { parked: true, keepAwake: false } } }),
    ).toMatchObject({ state: "parked", label: "Parked", live: true });
    // Printed within the window.
    expect(terminalRow(terminal(), { ...open, lastOutputAt: { t1: NOW - 1_000 } })).toMatchObject({
      state: "working",
      label: "Working",
      live: true,
    });
    // Live and quiet — the resting word, not a surface-invented "Open".
    expect(terminalRow(terminal(), open)).toMatchObject({ state: "idle", label: "Idle" });
    // A harness may declare the work over; the pane being attached does not
    // make it live again.
    expect(terminalRow(terminal(), { ...open, harness: { t1: harness("stopped") } })).toMatchObject(
      { state: "stopped", label: "Stopped", live: false },
    );
    expect(terminalRow(terminal())).toMatchObject({ state: "exited", label: "Exited" });
  });

  // The canonical selector's own precedence, which a "was it recently noisy?"
  // shortcut gets wrong in the one direction that matters: a pane that printed
  // a line and then died is not working, it is gone.
  it("never calls a terminal working once its pane is gone", () => {
    const justPrinted = { lastOutputAt: { t1: NOW - 1_000 } };

    expect(terminalRow(terminal(), justPrinted)).toMatchObject({ state: "exited", live: false });
    expect(
      terminalRow(terminal(), {
        ...justPrinted,
        panes: new Map([["t1", { exitCode: 1, tabId: "t1" }]]),
      }),
    ).toMatchObject({ state: "exited", live: false });
    // …and the ledger's own end stamp is honoured even where a pane lingers.
    expect(
      terminalRow(terminal({ endedAt: NOW - 500 }), { ...justPrinted, panes: panes("t1") }),
    ).toMatchObject({ state: "exited", live: false });
  });

  it("makes a chat a door whether or not a tab holds it", () => {
    // A transcript is durable, so a closed chat is re-adopted rather than lost.
    expect(homeSessionRows([chat()], [], ["c1"], pulse())[0]?.reopenable).toBe(true);
    expect(homeSessionRows([chat()], [], [], pulse())[0]?.reopenable).toBe(true);
  });

  it("makes a terminal a door only while a pane still holds it, and names its tab", () => {
    // Nothing to bring forward once the pane is gone, so the row stops being a
    // target rather than becoming one that lands nowhere.
    const held = homeSessionRows([], [terminal()], [], pulse({ panes: panes("t1") }))[0];
    expect(held?.reopenable).toBe(true);
    // A durable terminal record is a PANE: activation and a split drop both
    // take the TAB holding it, which a pane id is not.
    expect(held?.tabId).toBe("t1");

    const closed = homeSessionRows([], [terminal()], [], pulse())[0];
    expect(closed?.reopenable).toBe(false);
    expect(closed?.tabId).toBeNull();
  });

  // A split's second pane has a durable record of its own, so the project's
  // listing holds it; matching it against the store's TAB ids alone left it
  // drawn as an inert "Exited" row while its PTY was printing.
  it("keeps a live split pane live, under the tab that holds it", () => {
    const rows = homeSessionRows(
      [],
      [terminal({ id: "root" }), terminal({ id: "split" })],
      [],
      pulse({
        panes: new Map([
          ["root", { exitCode: null, tabId: "root" }],
          ["split", { exitCode: null, tabId: "root" }],
        ]),
        lastOutputAt: { split: NOW - 1_000 },
      }),
    );

    const split = rows.find((row) => row.id === "split");
    expect(split?.live).toBe(true);
    expect(split?.state).toBe("working");
    // The tab, not the pane: nothing can bring a pane forward on its own.
    expect(split?.tabId).toBe("root");
  });

  it("draws nothing for a project that has run nothing", () => {
    expect(homeSessionRows([], [], [], pulse())).toEqual([]);
  });

  it("names a row's state in the app's own words, never the surface's", () => {
    const rows = homeSessionRows(
      [chat({ sessionId: "c1", activity: "waiting" })],
      [terminal({ id: "t1" })],
      [],
      pulse({ panes: panes("t1"), harness: { t1: harness("waiting") } }),
    );

    // One vocabulary for both kinds: a terminal blocked on a person says what a
    // chat blocked on a person says, and what its Ticket's rail says.
    expect(rows.find((row) => row.id === "c1")?.stateLabel).toBe("Waiting for you");
    expect(rows.find((row) => row.id === "t1")?.stateLabel).toBe("Waiting for you");
    expect(homeSessionRows([], [terminal()], [], pulse())[0]?.stateLabel).toBe("Exited");
  });

  it("leaves a Subagent Session out — it is reached from the chat that delegated it", () => {
    const rows = homeSessionRows(
      [
        chat({ sessionId: "parent" }),
        chat({ sessionId: "child", role: "subagent", parentSessionId: "parent" }),
      ],
      [],
      // Promoted to a tab and still not a row: the page lists the project's own
      // Sessions, and a child belongs to one turn of one of them.
      ["child"],
      pulse(),
    );

    expect(rows.map((row) => row.id)).toEqual(["parent"]);
  });
});

/** One tab whose layout is a split: two panes, one tab id. */
function splitTab(): SessionTab {
  return {
    sessionId: "root",
    title: "Terminal 1",
    scope: { kind: "project", projectId: "p1" },
    layout: {
      kind: "split",
      id: "s",
      direction: "vertical",
      ratio: 0.5,
      first: { kind: "pane", sessionId: "root", exitCode: null },
      second: { kind: "pane", sessionId: "split", exitCode: 0 },
    },
    activePaneId: "root",
  };
}

describe("homeLivePanes", () => {
  it("walks every pane of every tab, not just the roots", () => {
    const byPane = homeLivePanes([splitTab()]);

    expect([...byPane.keys()].toSorted()).toEqual(["root", "split"]);
    // Each pane keeps its OWN exit code and the tab that holds it.
    expect(byPane.get("root")).toEqual({ exitCode: null, tabId: "root" });
    expect(byPane.get("split")).toEqual({ exitCode: 0, tabId: "root" });
  });

  it("knows nothing for a project with no open tabs", () => {
    expect(homeLivePanes([]).size).toBe(0);
  });
});

describe("homeTerminalIndex", () => {
  const terminals = [terminal({ id: "t1" }), terminal({ id: "t2" })];

  it("keeps only what this project's records can name", () => {
    expect(homeTerminalIndex({ t1: 5, "other-project-session": 9 }, terminals)).toEqual({ t1: 5 });
  });

  // The point of the narrowing: the store replaces its flat per-session maps
  // wholesale on every output bump, anywhere in the app, about once a second
  // per busy session. Shallow-compared, a bump this project cannot name yields
  // an EQUAL object, so Home does not re-render for it at all.
  it("answers the same object's worth for an unrelated session's bump", () => {
    const before = homeTerminalIndex({ t1: 5, elsewhere: 1 }, terminals);
    const after = homeTerminalIndex({ t1: 5, elsewhere: 2 }, terminals);

    expect(after).toEqual(before);
  });

  it("carries values through untouched, whatever they are", () => {
    const parked = { parked: true, keepAwake: false };
    expect(homeTerminalIndex({ t1: parked }, terminals).t1).toBe(parked);
  });
});

describe("nextHomeSessionStatusChangeAt", () => {
  it("names the instant a working row starts reading idle", () => {
    const at = nextHomeSessionStatusChangeAt(
      [terminal({ id: "t1" })],
      pulse({ panes: panes("t1"), lastOutputAt: { t1: NOW - 1_000 } }),
    );

    // Inclusive window, so the first instant the answer differs is one
    // millisecond past its end.
    expect(at).toBe(NOW - 1_000 + WORKING_WINDOW_MS + 1);
  });

  it("arms nothing where no row can change on its own", () => {
    // Quiet for longer than the window: it reads idle now and stays idle until
    // a new line moves the stamp, which is an input change, not a clock one.
    expect(
      nextHomeSessionStatusChangeAt(
        [terminal({ id: "t1" })],
        pulse({ panes: panes("t1"), lastOutputAt: { t1: NOW - WORKING_WINDOW_MS - 5_000 } }),
      ),
    ).toBeNull();
    // Nothing has printed at all.
    expect(
      nextHomeSessionStatusChangeAt([terminal({ id: "t1" })], pulse({ panes: panes("t1") })),
    ).toBeNull();
    // A gone pane's word is permanent.
    expect(
      nextHomeSessionStatusChangeAt(
        [terminal({ id: "t1" })],
        pulse({ lastOutputAt: { t1: NOW - 1_000 } }),
      ),
    ).toBeNull();
    expect(nextHomeSessionStatusChangeAt([], pulse())).toBeNull();
  });

  // The soonest, whichever end of the list it is at: a roster is walked in
  // recency order, so the row that flips first is as likely to be the last one
  // read as the first, and a boundary that only ever took the earlier of the
  // two would leave the other row saying the wrong word.
  it("takes the soonest across the roster, in either order", () => {
    const facts = { panes: panes("t1", "t2"), now: NOW };
    const soonest = NOW - 4_000 + WORKING_WINDOW_MS + 1;
    const rows = [terminal({ id: "t1" }), terminal({ id: "t2" })];

    expect(
      nextHomeSessionStatusChangeAt(
        rows,
        pulse({ ...facts, lastOutputAt: { t1: NOW - 1_000, t2: NOW - 4_000 } }),
      ),
    ).toBe(soonest);
    expect(
      nextHomeSessionStatusChangeAt(
        rows,
        pulse({ ...facts, lastOutputAt: { t1: NOW - 4_000, t2: NOW - 1_000 } }),
      ),
    ).toBe(soonest);
  });
});

describe("chatSessionIsLive", () => {
  // The audit's rule, and the one thing the roster must not get wrong: closing
  // a tab ends nothing, and a Session that is asking for a person is the last
  // row that may be folded away as history.
  it("reads the record's own lifecycle, not whether an attachment is open", () => {
    expect(chatSessionIsLive(chat({ activity: "idle", live: false }))).toBe(true);
    expect(chatSessionIsLive(chat({ activity: "waiting", live: false }))).toBe(true);
    // VC-324: nobody ended it, so it is a Session to go back to.
    expect(chatSessionIsLive(chat({ activity: "interrupted", live: false }))).toBe(true);
    // VC-86: somebody did.
    expect(chatSessionIsLive(chat({ activity: "stopped", live: false }))).toBe(false);
  });
});

describe("partitionHomeSessionRows", () => {
  it("keeps every live Session out of the record, whatever holds a tab", () => {
    const { live, earlier } = partitionHomeSessionRows(
      homeSessionRows(
        [
          chat({ sessionId: "closed-but-live", activity: "idle", lastActivityAt: 30 }),
          chat({ sessionId: "ended", activity: "stopped", lastActivityAt: 40 }),
        ],
        [terminal({ id: "dead-pty", lastActivityAt: 50 })],
        [],
        pulse(),
      ),
    );

    expect(live.map((row) => row.id)).toEqual(["closed-but-live"]);
    expect(earlier.map((row) => row.id)).toEqual(["dead-pty", "ended"]);
  });

  it("sorts what is asking for a person to the top, and leaves the rest by recency", () => {
    const { live } = partitionHomeSessionRows(
      homeSessionRows(
        [
          chat({ sessionId: "newest", activity: "working", lastActivityAt: 90 }),
          chat({ sessionId: "blocked", activity: "waiting", lastActivityAt: 10 }),
          chat({ sessionId: "quiet", activity: "idle", lastActivityAt: 50 }),
          chat({ sessionId: "died", activity: "interrupted", lastActivityAt: 20 }),
        ],
        [],
        [],
        pulse(),
      ),
    );

    expect(live.map((row) => row.id)).toEqual(["blocked", "died", "newest", "quiet"]);
  });

  // The finding's own repro, in one list: a Board TERMINAL blocked on a person
  // used to read "Open" and sort wherever its record's age put it — below a
  // noisier terminal that printed more recently. It is the first row now,
  // because its state is the canonical one and attention outranks recency.
  it("ranks a blocked terminal above newer work, whatever printed last", () => {
    const { live, earlier } = partitionHomeSessionRows(
      homeSessionRows(
        [chat({ sessionId: "chatting", activity: "working", lastActivityAt: 95 })],
        [
          terminal({ id: "noisy", lastActivityAt: 100 }),
          terminal({ id: "blocked", lastActivityAt: 10 }),
          terminal({ id: "napping", lastActivityAt: 80 }),
          terminal({ id: "gone", lastActivityAt: 90 }),
        ],
        [],
        pulse({
          panes: panes("noisy", "blocked", "napping"),
          lastOutputAt: { noisy: NOW - 1_000, blocked: NOW - 600_000 },
          parkState: { napping: { parked: true, keepAwake: false } },
          harness: { blocked: harness("waiting") },
        }),
      ),
    );

    expect(live.map((row) => row.id)).toEqual(["blocked", "noisy", "chatting", "napping"]);
    // A parked pane is live — SIGSTOP'd, not over — and the pane that is gone
    // is the only thing in the record.
    expect(earlier.map((row) => row.id)).toEqual(["gone"]);
  });

  it("folds only what is over into the record, from the canonical state", () => {
    const { live, earlier } = partitionHomeSessionRows(
      homeSessionRows(
        [],
        [
          terminal({ id: "idle-live", lastActivityAt: 40 }),
          terminal({ id: "parked-live", lastActivityAt: 30 }),
          terminal({ id: "stopped", lastActivityAt: 20 }),
          terminal({ id: "exited", lastActivityAt: 10 }),
        ],
        [],
        pulse({
          panes: panes("idle-live", "parked-live", "stopped"),
          parkState: { "parked-live": { parked: true, keepAwake: false } },
          harness: { stopped: harness("stopped") },
        }),
      ),
    );

    expect(live.map((row) => row.id)).toEqual(["idle-live", "parked-live"]);
    expect(earlier.map((row) => row.id)).toEqual(["stopped", "exited"]);
  });

  it("leaves the record strictly chronological", () => {
    const { earlier } = partitionHomeSessionRows(
      homeSessionRows(
        [
          chat({ sessionId: "old", activity: "stopped", lastActivityAt: 10 }),
          chat({ sessionId: "recent", activity: "stopped", lastActivityAt: 90 }),
        ],
        [],
        [],
        pulse(),
      ),
    );

    expect(earlier.map((row) => row.id)).toEqual(["recent", "old"]);
  });
});

describe("filterHomeSessionRows", () => {
  const rows = homeSessionRows(
    [
      chat({ sessionId: "live", title: "Plan the next release", activity: "waiting" }),
      chat({ sessionId: "past", title: "Trace terminal startup", activity: "stopped" }),
    ],
    [],
    [],
    pulse(),
  );

  it("matches the title and the state word the row actually draws", () => {
    expect(filterHomeSessionRows(rows, "release").map((row) => row.id)).toEqual(["live"]);
    expect(filterHomeSessionRows(rows, "waiting").map((row) => row.id)).toEqual(["live"]);
    expect(filterHomeSessionRows(rows, "  ").map((row) => row.id)).toEqual(["live", "past"]);
  });

  // The search spans the record: a roster that answered "no matching sessions"
  // while holding one is the filter failing at the only thing it is for.
  it("reaches Sessions that are over", () => {
    const matched = partitionHomeSessionRows(filterHomeSessionRows(rows, "terminal"));
    expect(matched.live).toEqual([]);
    expect(matched.earlier.map((row) => row.id)).toEqual(["past"]);
  });
});

describe("homeCheckoutGlance", () => {
  it("says nothing before the first read has landed", () => {
    // The row then shows the branch alone, which is true — rather than a
    // placeholder fact, which would not be.
    expect(homeCheckoutGlance({ venue: null, failed: false })).toBeNull();
  });

  it("leads with the fault, which outranks every other fact", () => {
    // Every other fact about the tree is unreadable while it stands, and the
    // body under the row is where its Retry lives.
    expect(homeCheckoutGlance({ venue: venue(), failed: true })).toEqual({
      phrase: "Unreadable",
      tone: "error",
    });
  });

  it("counts what is loose right now, and stays quiet about it", () => {
    // The dot is neutral for local state: uncommitted work is the resting
    // condition of a checkout someone is working in, and a tone lit for it
    // would be lit nearly always.
    expect(
      homeCheckoutGlance({
        venue: venue({ files: { committed: 9, modified: 2, added: 1, untracked: 3 } }),
        failed: false,
      }),
    ).toEqual({ phrase: "6 uncommitted", tone: "idle" });
  });

  it("says a clean tree is clean — committed work is not loose", () => {
    expect(
      homeCheckoutGlance({
        venue: venue({ files: { committed: 40, modified: 0, added: 0, untracked: 0 } }),
        failed: false,
      }),
    ).toEqual({ phrase: "Clean", tone: "idle" });
  });
});

describe("HOME_SESSION_FILTER_THRESHOLD", () => {
  it("is the Ticket roster's own number rather than a second copy of it", () => {
    expect(HOME_SESSION_FILTER_THRESHOLD).toBe(4);
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
