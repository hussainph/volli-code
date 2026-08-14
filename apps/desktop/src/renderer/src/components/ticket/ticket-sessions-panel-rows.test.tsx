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
import type { ChatSessionRecord, SessionListingRow } from "@volli/shared";

const fixture = vi.hoisted(() => {
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
    lastActivityAt: 2,
    bornTicketless: false,
  };
  // `live: false` is what puts a chat Session in History (session-history.ts).
  const ended: ChatSessionRecord = {
    ...record,
    sessionId: "chat-0",
    title: "Previous implementation",
    live: false,
    activity: "idle",
    waitingOn: null,
  };
  const rows: SessionListingRow[] = [
    { kind: "chat", record },
    { kind: "chat", record: ended },
  ];
  return { record, ended, rows };
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

  it("draws History as a sibling section, never the old rail's drawer", () => {
    // The Calm Stack has no drawer, no collapsible and no full-bleed seam
    // anywhere in the rail (lab/scratches/ticket-right-sidebar.tsx). History is
    // the same block as Sessions, one heading lower.
    const html = panel();

    expect(html).toContain("History");
    expect(html).toContain(fixture.ended.title);
    expect(html).not.toContain("collapsible");
    expect(html).not.toContain("border-t border-sidebar-border");
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
