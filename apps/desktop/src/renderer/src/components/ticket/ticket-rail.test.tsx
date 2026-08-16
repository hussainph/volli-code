import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { TicketRail } from "./ticket-rail";
import { WorktreeDestinationControl } from "./ticket-repository-summary";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";

const ticket: Ticket = {
  id: "ticket-6",
  projectId: "project-1",
  ticketNumber: 6,
  title: "Calm Stack",
  body: "Read @docs/plan.md.",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: "/worktrees/VC-6-calm-stack",
  branch: "volli/VC-6-calm-stack",
  baseBranch: "main",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

/** The same ticket before anything has made it a worktree. */
const ticketWithoutWorktree: Ticket = {
  ...ticket,
  worktreePath: null,
  branch: null,
};

const noop = (): void => {};

// The provider mirrors the real tree: `SidebarProvider` wraps the whole app in
// one (ui/sidebar.tsx), which is what makes the card's disabled-reason tooltips
// legal at runtime. Nothing new is introduced for the rail's sake.
function render(subject: Ticket = ticket) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketRail
        projectId="project-1"
        ticket={subject}
        creating={false}
        onNewSession={noop}
        onNewChat={noop}
        onActivateSession={noop}
        onActivateChat={noop}
        activeTabId="doc"
        changesContent={<p>diffs navigator</p>}
        filesContent={<p>files navigator</p>}
      />
    </TooltipProvider>,
  );
}

describe("TicketRail header", () => {
  it("draws one centred tablist of the three Calm Stack pages", () => {
    const html = render();

    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-testid="ticket-rail-tab-now"');
    expect(html).toContain('data-testid="ticket-rail-tab-changes"');
    expect(html).toContain('data-testid="ticket-rail-tab-files"');
    // One tab is selected, and it is the one holding the roving tab stop.
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
  });

  // The design of record shows exactly one word in the pill; the other two
  // pages are bare glyphs until selected. That is what makes three pages fit
  // 160px, so the unselected labels are genuinely absent from the DOM — every
  // tab still carries its name for assistive tech through `aria-label`.
  it("labels only the selected page, and names the other two for screen readers", () => {
    const html = render();

    expect(html).toContain(">Now<");
    expect(html).not.toContain(">Diffs<");
    expect(html).not.toContain(">Files<");
    expect(html).toContain('aria-label="Now"');
    expect(html).toContain('aria-label="Diffs"');
    expect(html).toContain('aria-label="Files"');
  });

  it("retires the vertical icon-mode strip and its Properties page", () => {
    const html = render();

    expect(html).not.toContain('aria-label="Ticket rail modes"');
    expect(html).not.toContain('data-testid="ticket-rail-mode-sessions"');
    expect(html).not.toContain('data-testid="ticket-rail-mode-properties"');
    expect(html).not.toContain('data-testid="ticket-rail-tab-properties"');
  });

  it("has no control that collapses the rail — that lives outside the panel", () => {
    const html = render();

    expect(html).not.toContain("details rail");
    expect(html).not.toContain("Collapse");
  });
});

// Only the default page can be asserted here: `renderToStaticMarkup` reads a
// zustand store through `getServerSnapshot`, which is `getInitialState` — a
// `setState` before the render is invisible to it. Page SELECTION is covered by
// the pure contract (`ticket-rail-model.test.ts`) and by e2e/ticket-rail-shots,
// which drives the real tabs; what is left to prove here is that Now is that
// default and that it is one page holding all three blocks.
describe("TicketRail's Now page", () => {
  it("is the default page, and folds repository, properties and sessions into it", () => {
    expect(useUiStore.getInitialState().railMode).toBe("now");
    const html = render();

    expect(html).toContain('id="ticket-rail-page-now"');
    expect(html).toContain('aria-labelledby="ticket-rail-tab-now"');
    expect(html).toContain('data-testid="ticket-repository-summary"');
    expect(html).toContain('data-testid="ticket-rail-properties"');
    expect(html).toContain("Sessions");
  });

  it("renders no other page's navigator beside it", () => {
    const html = render();

    expect(html).not.toContain("diffs navigator");
    expect(html).not.toContain("files navigator");
    expect(html).not.toContain('id="ticket-rail-page-changes"');
    expect(html).not.toContain('id="ticket-rail-page-files"');
  });

  it("keeps the ticket's repository facts out of the properties fold", () => {
    const html = render();
    const properties = html.slice(html.indexOf('data-testid="ticket-rail-properties"'));

    expect(properties).not.toContain("volli/VC-6-calm-stack");
    expect(properties).not.toContain("/worktrees/");
  });
});

// `renderToStaticMarkup` runs no effects, so the card is frozen in the state it
// holds on the very first frame — which is exactly the state that used to lie.
describe("TicketRail's repository card before the first read lands", () => {
  it("waits rather than claiming the worktree is clean", () => {
    const html = render();

    // The Change Set has not arrived, so there is no count to state — the row
    // draws the wait. It used to compute `diff?.files.length ?? 0` and announce
    // "No changes" for the whole first fetch, on a worktree with 40 edits in it.
    expect(html).toContain('data-testid="ticket-repository-changes-loading"');
    expect(html).toContain('aria-label="Reading changes, show Diffs"');
    expect(html).not.toContain("No changes");
  });

  it("signals the pending worktree on a worktree-scoped ticket, not a bare 'no worktree yet'", () => {
    // VC-16: before the worktree materializes, a worktree-scoped ticket and a
    // Main-checkout ticket were pixel-identical — the card said "No worktree
    // yet" for both, and the scoping chosen in the composer was unreadable
    // everywhere. The row now states the scoping while it still matters.
    const html = render(ticketWithoutWorktree);

    expect(html).toContain('aria-label="New worktree on first session, show Diffs"');
    expect(html).not.toContain("No worktree yet");
    expect(html).not.toContain("No changes");
    expect(html).not.toContain('data-testid="ticket-repository-changes-loading"');
  });

  it("says a Main-checkout ticket runs in the main checkout, permanently and honestly", () => {
    // Nothing is ever fetched here (`refreshStatusAndDiff` returns early), so
    // "No changes" would not have been a slow frame — it would have been the
    // ticket's whole answer, contradicting the Diffs page beside it.
    const html = render({ ...ticketWithoutWorktree, usesWorktree: false });

    expect(html).toContain('aria-label="Runs in the main checkout, show Diffs"');
    expect(html).not.toContain("No worktree yet");
    expect(html).not.toContain("No changes");
  });

  it("offers no publish controls until the ticket has a worktree", () => {
    expect(render(ticketWithoutWorktree)).not.toContain('aria-label="More repository actions"');
  });
});

const renderControl = (subject: Ticket) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <WorktreeDestinationControl ticket={subject} />
    </TooltipProvider>,
  );

describe("the worktree destination control", () => {
  it("names the ticket's scoping while no worktree has materialized", () => {
    // The same two options the composer's destination chip offers, so the
    // choice made at creation stays readable — and changeable — afterwards.
    expect(renderControl(ticketWithoutWorktree)).toContain("New worktree");
    expect(renderControl({ ...ticketWithoutWorktree, usesWorktree: false })).toContain(
      "Project checkout",
    );
  });

  it("disappears once the worktree is a fact on disk — the flag is frozen with it", () => {
    expect(renderControl(ticket)).toBe("");
  });
});
