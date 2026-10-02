/**
 * The rail's session rows, with a roster that has something in it.
 *
 * Separate from `ticket-sessions-panel-actions.test.tsx` because of how the
 * roster has to be populated: `renderToStaticMarkup` reads a zustand store's
 * INITIAL state (`getInitialState`, zustand v5), so a `setState` before the
 * render is invisible and a populated listing can only come from a store that
 * starts populated — which is a module mock, and a file-wide one.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ChatSessionRecord,
  SessionListingRow,
  SessionProvenance,
  SessionRecord,
  SessionUsageSummary,
} from "@volli/shared";

const fixture = vi.hoisted(() => {
  // Spelled out rather than imported: this block is hoisted above the module's
  // own imports, so a shared constant would be in its temporal dead zone here.
  // Unmetered, which is what these rows are about — nothing here calls a model.
  // Spelled out for the same reason, and it is the resting case: these rows
  // are Sessions a person opened, so they carry no mark at all (VC-131).
  const personStarted: SessionProvenance = { kind: "user" };
  const unmetered: SessionUsageSummary = {
    requestCount: 0,
    tokenRequestCount: 0,
    pricedRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    knownCostUsd: null,
    costCoverage: "unavailable",
    costBasis: "unavailable",
    cachedInputShare: null,
  };
  const record: ChatSessionRecord = {
    sessionId: "chat-1",
    title: "Trace the dropped decorations",
    projectId: "project-1",
    ticketId: "ticket-6",
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "waiting",
    waitingOn: "question",
    outcome: null,
    lastActivityAt: 2,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    model: null,
  };
  // `live: false` is what puts a chat Session in History (session-history.ts).
  const ended: ChatSessionRecord = {
    ...record,
    sessionId: "chat-0",
    title: "Previous implementation",
    live: false,
    activity: "stopped",
    waitingOn: null,
    outcome: null,
  };
  // The rail is a listing like any other, so it draws the same three marks the
  // sidebar's bands do (VC-131). One Run, one Session-started child, one row a
  // person opened — which is the row that must gain nothing.
  const byRun: ChatSessionRecord = {
    ...record,
    sessionId: "chat-run",
    title: "Fix the flaky worktree test",
    live: true,
    activity: "working",
    waitingOn: null,
    outcome: null,
  };
  const byAgent: ChatSessionRecord = {
    ...record,
    sessionId: "chat-child",
    title: "Second opinion",
    live: true,
    activity: "working",
    waitingOn: null,
    outcome: null,
  };
  // Finished AND unread (VC-30, D6): the Session left a turn behind and then
  // went quiet. Its lifecycle says record, its receipt says nobody has seen it
  // — and unread wins, or the dot would be folded away behind the caret.
  const unreadFinished: ChatSessionRecord = {
    ...record,
    sessionId: "chat-unseen",
    title: "Finished while nobody watched",
    live: false,
    activity: "stopped",
    waitingOn: null,
    outcome: null,
  };
  // VC-324: `interrupted` is durable — a relaunch does not end the fact that
  // the last turn died, so a History row for one must keep saying so.
  const interrupted: ChatSessionRecord = {
    ...record,
    sessionId: "chat-interrupted",
    title: "Died mid-run",
    live: false,
    activity: "interrupted",
    waitingOn: null,
    outcome: "interrupted",
  };
  // A terminal that exited and had its tab closed: no live tab, so History is
  // where it lives and its saved record is all there is of it (VC-290).
  const closedTerminal: SessionRecord = {
    id: "terminal-0",
    projectId: "project-1",
    ticketId: "ticket-6",
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "shell",
    placement: "tab",
    title: "Closed shell",
    cwd: "/repo",
    createdAt: 1,
    endedAt: 3,
    exitCode: 0,
    lastActivityAt: 3,
    bornTicketless: false,
  };
  // A startup listing may briefly contain an open durable attachment before
  // recovery settles it, while this renderer has no live tab for it. It is not
  // a closed record yet and must not borrow the detail destination.
  const recoveringTerminal: SessionRecord = {
    ...closedTerminal,
    id: "terminal-recovering",
    title: "Recovering shell",
    endedAt: null,
    exitCode: null,
  };
  const rows: SessionListingRow[] = [
    { kind: "terminal", record: closedTerminal, usage: unmetered, provenance: personStarted },
    { kind: "terminal", record: recoveringTerminal, usage: unmetered, provenance: personStarted },
    // Unread (VC-30): the one row that carries a receipt, so the dot, the
    // heavier title and the menu's direction all have a subject.
    {
      kind: "chat",
      record,
      usage: unmetered,
      provenance: personStarted,
      read: { unreadSince: 5 },
    },
    { kind: "chat", record: ended, usage: unmetered, provenance: personStarted },
    {
      kind: "chat",
      record: unreadFinished,
      usage: unmetered,
      provenance: personStarted,
      read: { unreadSince: 7 },
    },
    { kind: "chat", record: interrupted, usage: unmetered, provenance: personStarted },
    {
      kind: "chat",
      record: byRun,
      usage: unmetered,
      provenance: { kind: "automation", automationRunId: null, automationName: "Nightly sweep" },
    },
    {
      kind: "chat",
      record: byAgent,
      usage: unmetered,
      provenance: {
        kind: "session",
        parentSessionId: "chat-0",
        parentTitle: "Previous implementation",
      },
    },
  ];
  return {
    record,
    ended,
    unreadFinished,
    interrupted,
    byRun,
    byAgent,
    closedTerminal,
    recoveringTerminal,
    rows,
  };
});

// Partial: the STORE is a fixture, but `ticketSessionListingStateOf` is kept
// real (VC-383). It is a pure reader, and these rows depend on the arm it
// states — a ticket whose rows were seeded directly, with no recorded listing
// state, is a LANDED answer and must draw its rows rather than a skeleton.
// Re-declaring it here would let the fixture and the store disagree about that.
vi.mock("@renderer/stores/ticket-session-records", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/stores/ticket-session-records")>();
  const { create } = await import("zustand");
  return {
    ...actual,
    useTicketSessionRecordsStore: create(() => ({
      byTicket: { "ticket-6": fixture.rows },
      listingState: {},
      listingError: {},
      refresh: () => Promise.resolve(),
      renameLocally: () => {},
      setActiveHarness: () => {},
    })),
  };
});

// The record is folded by default (VC-406), and most of these rows live IN
// the record, so the UI store starts with the fold OPEN here — for the reason
// the module doc gives: a static render reads a store's initial state, and
// Radix mounts the fold's body only while it is open. The folded state and the
// toggle are exercised in `ticket-sessions-panel-push.test.tsx`, under jsdom.
vi.mock("@renderer/stores/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/stores/ui")>();
  const { create } = await import("zustand");
  return {
    ...actual,
    useUiStore: create(() => ({
      ...actual.useUiStore.getInitialState(),
      railFolds: { sessionsRecord: true, worktree: false, usage: false },
    })),
  };
});

const { TicketSessionsPanel } = await import("./ticket-sessions-panel");

const noop = (): void => {};

function panel(): string {
  return renderToStaticMarkup(
    <TicketSessionsPanel
      projectId="project-1"
      ticketId="ticket-6"
      creating={false}
      onNewSession={noop}
      onNewChat={noop}
      onActivateSession={noop}
      onActivateChat={noop}
    />,
  );
}

describe("TicketSessionsPanel rows", () => {
  it("keeps the design of record's always-present control in the Sessions header", () => {
    // The scratch's `SessionRows` header is `justify-between` around the label
    // and a ghost "+", present whether the roster is full or empty. Dropping the
    // control but keeping the row it sat in left a header with dead space at its
    // right edge on every populated roster.
    const html = panel();

    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain("justify-between");
  });

  it("leads a row with the Session's mark, not with a kind glyph (VC-30)", () => {
    const html = panel();

    // The mark IS the kind and the state: one glyph, named with both, replacing
    // the `ChatCircle`/`TerminalWindow` icon and the status dot beside it.
    expect(html).toContain('aria-label="Chat · Waiting for you"');
    expect(html).toContain('data-session-glyph="waiting"');
    expect(html).toContain(fixture.record.title);
    expect(html).not.toContain("Chat · Live");
    // A companion's mark is named by the shipped source rule, the one the left
    // band reads: this record was launched as a bare SHELL, so it is `Shell` —
    // never the default harness its `harnessId` falls back to, which would put
    // Claude Code's name and logo on a plain terminal.
    expect(html).toContain('aria-label="Shell · Exited"');
    expect(html).not.toContain('aria-label="Claude Code · Exited"');
  });

  it("gives a live row the age alone, and keeps the state word in the record", () => {
    // D5: the mark carries the state, so a live row's second line is only when
    // — but a record row's whole content is how it ended and when, so the word
    // stays there.
    const html = panel();
    const live = html.indexOf(fixture.record.title);
    const folded = html.indexOf('data-testid="session-history"');

    expect(live).toBeGreaterThan(-1);
    expect(html.slice(live, folded)).not.toContain("Waiting for you<");
    expect(html.slice(folded)).toContain("Stopped · ");
    // The live half no longer draws a status dot at all; the record still does.
    expect(html.slice(live, folded)).not.toContain('data-slot="status-dot"');
    expect(html.slice(folded)).toContain('data-slot="status-dot"');
  });

  it("marks an unread Session with the dot and a heavier title, and nothing else with either", () => {
    const html = panel();
    const at = html.indexOf(fixture.record.title);

    expect(html).toContain('data-unread=""');
    expect(html).toContain("Unread");
    expect(html).toContain("bg-info");
    // Only the rows that carry a receipt: the live unread one and the
    // finished-but-unseen one, and nothing else in the roster.
    expect(html.match(/data-unread-dot/g)).toHaveLength(2);
    expect(html.slice(html.lastIndexOf("<span", at), at)).toContain("font-semibold");
  });

  it("keeps an unread Session out of the fold after it goes quiet (VC-30, D6)", () => {
    // The defect: the live half was `chatRows.filter((row) => row.isLive)`, so
    // a Session that finished with work nobody had seen dropped into the
    // collapsed record and took its dot with it. Unread is never retired for
    // being old or idle — the row stays above the record fold.
    const html = panel();
    const unseen = html.indexOf(fixture.unreadFinished.title);
    const folded = html.indexOf('data-testid="session-history"');

    expect(unseen).toBeGreaterThan(-1);
    expect(folded).toBeGreaterThan(-1);
    expect(unseen).toBeLessThan(folded);
    // Its dot is on the page, in the live half, rather than behind the caret.
    expect(html.slice(0, folded)).toContain("data-unread-dot");
    // …and the READ finished Session is still in the record, which is what
    // says the rule is unread and not "every chat row stays up top".
    expect(html.slice(folded)).toContain(fixture.ended.title);
  });

  it("addresses every row for the peek, live rows and record alike", () => {
    const html = panel();

    expect(html).toContain('data-peek-row="chat:chat-1"');
    expect(html).toContain('data-peek-row="session:terminal-0"');
    expect(html).toContain('data-peek-surface="rail"');
  });

  describe("who started the Session", () => {
    it("carries only the bolt on a Run's row and keeps its origin accessible", () => {
      const html = panel();

      expect(html).toContain('aria-label="Started by the Automation Nightly sweep"');
      expect(html.replace(/<[^>]*>/g, "")).not.toContain("Nightly sweep");
    });

    it("drops the native tooltip on a peekable row, where the card now says it", () => {
      // D1: a browser tooltip would open on top of the peek card at nearly the
      // same instant. The provenance line rides the card instead, so the row's
      // `title` attribute goes — including the one a Session-started child's
      // mark used as its whole mark.
      const html = panel();

      expect(html).not.toContain('title="Automation · Nightly sweep"');
      expect(html).not.toContain('title="Started by Previous implementation"');
    });

    it("gives a person's row nothing — no mark, and no empty tooltip", () => {
      const html = panel();

      // The row a person opened is present and titled, and carries neither the
      // Automation's accessible name nor a provenance tooltip of its own.
      expect(html).toContain(fixture.record.title);
      expect(html).not.toContain('title=""');
      expect(html.match(/aria-label="Started by the Automation/g)).toHaveLength(1);
    });
  });

  it("folds the record under the live rows, in one section — never the old rail's drawer", () => {
    // ONE section (VC-406): no "History" heading, no count badge on the face.
    // The eyebrow's label is the fold, and the record sits under the live rows
    // when it is open. Nothing bleeds past the section's inset — the drawer's
    // full-bleed seam is the thing this must never grow back.
    const html = panel();

    expect(html).not.toContain(">History<");
    expect(html).toContain(fixture.ended.title);
    expect(html).toContain('data-testid="ticket-sessions-fold"');
    expect(html).toContain('aria-label="Hide past sessions"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("count-pill");
    expect(html).not.toContain("border-t border-sidebar-border");
    expect(html.match(/<section/g)).toHaveLength(1);
  });

  // It used to be inert — a row you could read and not open, with the saved
  // record it names reachable from nowhere. It now opens that record, which is
  // the same destination the sidebar's Previous row and ⌘K reach (VC-290).
  it("lets a closed terminal in History be opened, not just read", () => {
    const html = panel();
    const at = html.indexOf(fixture.closedTerminal.title);

    expect(at).toBeGreaterThan(-1);
    // `ListRow` renders an activatable row as a button and an inert one as a
    // div, so the element the title sits in IS the assertion.
    expect(html.lastIndexOf("<button", at)).toBeGreaterThan(html.lastIndexOf("<div", at));
  });

  it("does not offer details for a durable record that has not closed", () => {
    const html = panel();
    const at = html.indexOf(fixture.recoveringTerminal.title);

    expect(at).toBeGreaterThan(-1);
    expect(html.lastIndexOf("<div", at)).toBeGreaterThan(html.lastIndexOf("<button", at));
  });

  it("keeps a stopped chat visibly stopped after it moves to History", () => {
    const html = panel();

    expect(html).toContain("Stopped");
    expect(html).toContain('data-state="stopped"');
  });

  it("keeps an interrupted chat visibly interrupted, after a relaunch (VC-324)", () => {
    const html = panel();
    const at = html.indexOf(fixture.interrupted.title);

    expect(at).toBeGreaterThan(-1);
    // `interrupted` is durable, and it is still SAID — by the mark now, whose
    // badge and accessible name carry it on a live row (VC-30, D5). Collapsing
    // it into generic ended history is still the drift this guards.
    expect(html.slice(0, at)).toContain('aria-label="Chat · Interrupted"');
    expect(html.slice(0, at)).toContain('data-session-glyph="interrupted"');
  });

  it("insets the record with the column instead of a hardcoded edge", () => {
    // The drawer's own `px-4` ignored the rail's narrow step, so at ≤270px
    // History alone stayed at 16px and stepped the column's edge. The record
    // is inside the one section now, so it inherits the one inset token and
    // the rail's edge is a straight line.
    const html = panel();
    const marker = html.indexOf('data-testid="session-history"');
    const openingTag = html.slice(html.lastIndexOf("<section", marker), marker);

    expect(openingTag).toContain("group-data-[narrow=true]/rail:px-3");
    expect(html.match(/group-data-\[narrow=true\]\/rail:px-3/g)?.length).toBe(1);
  });
});
