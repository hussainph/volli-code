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
    { kind: "chat", record, usage: unmetered, provenance: personStarted },
    { kind: "chat", record: ended, usage: unmetered, provenance: personStarted },
    {
      kind: "chat",
      record: byRun,
      usage: unmetered,
      provenance: { kind: "automation", automationName: "Nightly sweep" },
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
  return { record, ended, byRun, byAgent, closedTerminal, recoveringTerminal, rows };
});

vi.mock("@renderer/stores/ticket-session-records", async () => {
  const { create } = await import("zustand");
  return {
    useTicketSessionRecordsStore: create(() => ({
      byTicket: { "ticket-6": fixture.rows },
      refresh: () => Promise.resolve(),
      renameLocally: () => {},
      setActiveHarness: () => {},
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

  it("draws a row as one line: kind, title, status", () => {
    const html = panel();

    // The kind is the leading glyph's label now, not a second line of prose, so
    // the row has to keep SAYING which kind it is.
    expect(html).toContain('aria-label="Chat"');
    expect(html).toContain(fixture.record.title);
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain("Chat · Live");
  });

  it("reports a chat Session's own activity, in the terminal rows' vocabulary", () => {
    // `ChatSessionRecord.activity` is a subset of `SessionActivityState`, so one
    // status column serves both kinds — the attention tone for an agent that is
    // blocked on you, the same one the sidebar's Active band and the ticket tab
    // strip paint, because all three now ask `ui/status-dot.tsx`.
    //
    // Asserted on the STATE rather than on `bg-attention`: the class is
    // `StatusDot`'s business and this panel's job is to hand it the right state.
    // A test that matched the class would fail the day the dot is restyled and
    // pass the day this panel starts reporting the wrong state.
    expect(panel()).toContain('data-state="waiting"');
  });

  describe("who started the Session", () => {
    it("carries the bolt and the Automation's name on a Run's row", () => {
      const html = panel();

      expect(html).toContain('aria-label="Started by the Automation Nightly sweep"');
      expect(html).toContain('title="Automation · Nightly sweep"');
    });

    it("names the parent in a tooltip, and mints no glyph for it", () => {
      expect(panel()).toContain('title="Started by Previous implementation"');
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

  it("draws History as a sibling section, never the old rail's drawer", () => {
    // The Calm Stack has no drawer, no collapsible and no full-bleed seam
    // anywhere in the rail (per the retired ticket-right-sidebar lab scratch). History is
    // the same block as Sessions, one heading lower.
    const html = panel();

    expect(html).toContain("History");
    expect(html).toContain(fixture.ended.title);
    expect(html).not.toContain("collapsible");
    expect(html).not.toContain("border-t border-sidebar-border");
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

  it("insets History with the column instead of a hardcoded edge", () => {
    // The drawer's own `px-4` ignored the rail's narrow step, so at ≤270px
    // History alone stayed at 16px and stepped the column's edge. Both sections
    // now carry the one inset token, so the rail's edge is a straight line.
    const html = panel();
    const marker = html.indexOf('data-testid="session-history"');
    const openingTag = html.slice(html.lastIndexOf("<section", marker), marker);

    expect(openingTag).toContain("group-data-[narrow=true]/rail:px-3");
    expect(html.match(/group-data-\[narrow=true\]\/rail:px-3/g)?.length).toBe(2);
  });
});
