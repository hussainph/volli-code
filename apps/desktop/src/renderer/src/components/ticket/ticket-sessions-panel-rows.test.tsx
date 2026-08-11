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
  const rows: SessionListingRow[] = [{ kind: "chat", record }];
  return { record, rows };
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
  it("leaves session creation to the tab strip once there is a roster to read", () => {
    // The strip's cluster (ticket-tabs.tsx) is labelled, carries both kinds and
    // never scrolls away, so a control here would be the same act twice in one
    // column. The empty roster is the exception, and its own test file covers it.
    expect(panel()).not.toContain('aria-label="New chat"');
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
    // status column serves both kinds — amber for an agent that is blocked on
    // you, the same tone the sidebar's Active band paints.
    expect(panel()).toContain("bg-amber-500");
  });
});
