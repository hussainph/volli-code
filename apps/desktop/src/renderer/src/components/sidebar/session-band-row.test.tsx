/**
 * What an Active row's second line SAYS — the one thing about these rows that
 * is a product decision rather than a layout one.
 *
 * The line's first slot holds where the Session lives (its ticket's column),
 * not what launched it. That was a swap, not an addition: the source label the
 * status displaced is still built for every row and still has to be reachable,
 * so every case here pins both halves — what the line reads, and that the
 * harness survived in the row's hover `title`.
 *
 * `renderToStaticMarkup` for the same reason the rail's row tests use it: the
 * suite runs on `environment: "node"` (root `vite.config.ts`) with no DOM. The
 * provider mirrors the real tree — `SidebarProvider` wraps the whole app, and
 * `SidebarMenuButton` reads its context unconditionally.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import type { ActiveSessionRow, PreviousSessionRow } from "./active-session-listing";
import { ActiveBandRow, PreviousBandRow, TicketGroupRow } from "./session-band-row";
import { SidebarProvider } from "@renderer/components/ui/sidebar";

const ticket: Ticket = {
  id: "ticket-7",
  projectId: "project-1",
  ticketNumber: 7,
  title: "Nav sidebar",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: "/worktrees/VC-7-nav-sidebar",
  branch: "volli/VC-7-nav-sidebar",
  baseBranch: "main",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

function row(overrides: Partial<ActiveSessionRow> = {}): ActiveSessionRow {
  return {
    id: "session:s1",
    ticket,
    title: "Session 1",
    source: "Claude Code",
    activity: "working",
    activitySource: "reported",
    attention: null,
    waitingOn: null,
    target: { kind: "terminal", tabId: "s1", paneId: "p1" },
    ...overrides,
  };
}

function render(subject: ActiveSessionRow): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <ActiveBandRow row={subject} ticketPrefix="VC" selected={false} onSelect={() => {}} />
    </SidebarProvider>,
  );
}

/**
 * The meta line's state half — the slot after the ticket id. It is the one span
 * whose class list is exactly `truncate`; the row's own title span carries
 * `session-row-dim truncate …`, so an exact-attribute match tells them apart
 * without a DOM to query.
 */
function stateLine(markup: string): string {
  return /<span class="truncate">([^<]*)<\/span>/.exec(markup)?.[1] ?? "";
}

/**
 * The row button's hover `title` — where the source label lives now.
 *
 * Deliberately NOT anchored on `<button`: `sidebarMenuButtonVariants` bakes in
 * Tailwind arbitrary variants like `[&>span:last-child]:truncate`, so a `>` sits
 * inside the class attribute and no `<button[^>]*` prefix can reach past it. The
 * row draws exactly one `title`, so the first match is the right one.
 */
function hoverTitle(markup: string): string {
  return /title="([^"]*)"/.exec(markup)?.[1] ?? "";
}

describe("ActiveBandRow", () => {
  it("names the ticket's column in the slot the harness name used to hold", () => {
    const markup = render(row());

    expect(stateLine(markup)).toBe("Doing · Working");
    // Displaced, not dropped.
    expect(hoverTitle(markup)).toContain("Claude Code");
  });

  it("says where a chat Session lives instead of saying it is Live", () => {
    // The whole point of the change: `Live` told a reader nothing the Active
    // band was not already telling them by holding the row.
    const markup = render(
      row({ id: "chat:c1", source: "Chat · Live", ticket: { ...ticket, status: "needs_review" } }),
    );

    expect(stateLine(markup)).toBe("Needs Review · Working");
    expect(stateLine(markup)).not.toContain("Live");
    expect(hoverTitle(markup)).toContain("Chat · Live");
  });

  it("keeps the source on a ticketless row, which has no column to name", () => {
    const markup = render(row({ ticket: null, source: "Shell", activity: "idle" }));

    expect(stateLine(markup)).toBe("Shell · Idle");
  });

  it("still reports a silent harness, against the column rather than the source", () => {
    const markup = render(row({ activitySource: "silent" }));

    expect(stateLine(markup)).toBe("Doing · Not reporting");
  });

  it("leaves an errand row saying the errand, which never held a source", () => {
    const blocked = render(row({ attention: { signal: "blocked", reason: "Needs a decision" } }));
    expect(stateLine(blocked)).toBe("Blocked · Needs a decision");

    const waiting = render(
      row({ activity: "waiting", attention: { signal: "waiting", reason: null } }),
    );
    expect(stateLine(waiting)).toBe("Waiting for you");
  });
});

/**
 * The ticket entry the Previous band collapses onto, and the one thing a child
 * row gives up to sit under it (VC-69).
 */
describe("TicketGroupRow", () => {
  function renderGroup(count: number, open: boolean): string {
    return renderToStaticMarkup(
      <SidebarProvider>
        <TicketGroupRow
          ticket={ticket}
          ticketPrefix="VC"
          count={count}
          newestAt={0}
          now={60_000}
          open={open}
          onToggle={() => {}}
        />
      </SidebarProvider>,
    );
  }

  it("names the ticket and how many sessions are behind it", () => {
    const markup = renderGroup(5, false);

    expect(markup).toContain("VC-7");
    expect(markup).toContain("Nav sidebar");
    expect(markup).toContain(">5<");
  });

  it("draws the count even at one, so a stack is never invisible", () => {
    // Every ticket gets one of these rows, so the count is the only mark that
    // separates a ticket hiding six sessions from one hiding a single session.
    expect(renderGroup(1, false)).toContain(">1<");
  });

  it("carries no status dot in either state — attention never reaches this band", () => {
    // A Session needing a human is pinned to Active for as long as it is
    // asking, so nothing behind a collapsed ticket here can be waiting.
    expect(renderGroup(3, false)).not.toContain('data-slot="status-dot"');
    expect(renderGroup(3, true)).not.toContain('data-slot="status-dot"');
  });

  it("announces its disclosure state and turns only the caret", () => {
    expect(renderGroup(2, false)).toContain('aria-expanded="false"');

    const open = renderGroup(2, true);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rotate-90");
  });
});

describe("PreviousBandRow identity", () => {
  const previous: PreviousSessionRow = {
    id: "session:s1",
    ticket,
    title: "Review fixes",
    kind: "chat",
    endedOrQuietAt: 0,
    target: null,
    cleaned: false,
  };

  function renderPrevious(showIdentity?: boolean): string {
    return renderToStaticMarkup(
      <SidebarProvider>
        <PreviousBandRow
          row={previous}
          ticketPrefix="VC"
          now={60_000}
          selected={false}
          onSelect={() => {}}
          showIdentity={showIdentity}
        />
      </SidebarProvider>,
    );
  }

  it("draws its ticket id when standing on its own", () => {
    expect(renderPrevious()).toContain("VC-7");
  });

  it("drops the id under a ticket entry, which already said it", () => {
    const markup = renderPrevious(false);

    expect(markup).not.toContain("VC-7");
    // Only the identity goes: the row keeps its title and its kind glyph.
    expect(markup).toContain("Review fixes");
    expect(markup).toContain('aria-label="Chat"');
  });
});
