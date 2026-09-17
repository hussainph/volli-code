import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { TicketRail } from "./ticket-rail";
import { TicketRepositorySummary, WorktreeDestinationControl } from "./ticket-repository-summary";
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
        searchContent={<p>search page</p>}
      />
    </TooltipProvider>,
  );
}

describe("TicketRail header", () => {
  it("draws one centred tablist of the four Calm Stack pages", () => {
    const html = render();

    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-testid="ticket-rail-tab-now"');
    expect(html).toContain('data-testid="ticket-rail-tab-changes"');
    expect(html).toContain('data-testid="ticket-rail-tab-files"');
    expect(html).toContain('data-testid="ticket-rail-tab-search"');
    // One tab is selected, and it is the one holding the roving tab stop.
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
  });

  // The design of record shows exactly one word in the pill; the other pages
  // are bare glyphs until selected. That is what lets four of them fit the
  // rail's narrowest width, so the unselected labels are genuinely absent from
  // the DOM — every tab still carries its name for assistive tech through
  // `aria-label`.
  it("labels only the selected page, and names the others for screen readers", () => {
    const html = render();

    expect(html).toContain(">Now<");
    expect(html).not.toContain(">Diffs<");
    expect(html).not.toContain(">Files<");
    expect(html).not.toContain(">Search<");
    expect(html).toContain('aria-label="Now"');
    expect(html).toContain('aria-label="Diffs"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('aria-label="Search"');
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
  it("is the default page, and folds properties, automations and sessions into it", () => {
    expect(useUiStore.getInitialState().railMode).toBe("now");
    const html = render();

    expect(html).toContain('id="ticket-rail-page-now"');
    expect(html).toContain('aria-labelledby="ticket-rail-tab-now"');
    expect(html).toContain('data-testid="ticket-rail-properties"');
    expect(html).toContain('data-testid="ticket-rail-automations"');
    expect(html).toContain("Sessions");
  });

  // The worktree is a Diffs-page subject now (VC-406) — the act that commits
  // belongs on the page showing what it would commit. Asserted as an ABSENCE
  // here because re-adding the card to Now is a one-line change that would
  // otherwise leave two worktree surfaces one tab apart, which is the state
  // this ticket exists to end.
  it("carries no worktree surface — that moved to the Diffs page", () => {
    const html = render();

    expect(html).not.toContain('data-testid="ticket-repository-summary"');
    expect(html).not.toContain('data-testid="ticket-changes-git-state"');
    expect(html).not.toContain("volli/VC-6-calm-stack");
  });

  // The order IS the design (VC-406), and it is a hierarchy rather than a
  // ranking: what the ticket IS, what can be run on it, what is happening on
  // it. Asserted on the markup's own sequence because a reorder in the
  // composition is a one-line change that no other test would notice.
  it("opens with the facts, then the acts, then the roster", () => {
    const html = render();
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };

    const properties = at('data-testid="ticket-rail-properties"');
    const automations = at('data-testid="ticket-rail-automations"');
    const sessions = at('aria-label="New chat"');

    expect(properties).toBeLessThan(automations);
    expect(automations).toBeLessThan(sessions);
  });

  // Pinned, not stacked: it is a sibling of the scroller rather than a block
  // inside it, which is what keeps one row of cost on screen at any scroll
  // position. `renderToStaticMarkup` runs no effects, so the ledger read never
  // lands and the footer is correctly absent — what can be proved here is that
  // the scroller is not the page's only child.
  it("hangs its usage footer outside the scrolling column", () => {
    const page = render().slice(render().indexOf('id="ticket-rail-page-now"'));
    const scroller = page.indexOf("overflow-y-auto pb-8");

    expect(scroller).toBeGreaterThan(-1);
    expect(page.indexOf("</section>", scroller)).toBeGreaterThan(scroller);
  });

  it("stacks the page with one gap, so no block pays its own top padding", () => {
    const html = render();
    const page = html.slice(html.indexOf('id="ticket-rail-page-now"'));

    expect(page).toContain("gap-4 overflow-y-auto");
    // A block that carried its own `pt-4` would double the rhythm against its
    // neighbours and leave a hole when absent.
    expect(page).not.toContain("pt-4 px-4");
    expect(page).not.toContain("gap-1 pt-4");
  });

  it("renders no other page's navigator beside it", () => {
    const html = render();

    expect(html).not.toContain("diffs navigator");
    expect(html).not.toContain("files navigator");
    expect(html).not.toContain("search page");
    expect(html).not.toContain('id="ticket-rail-page-changes"');
    expect(html).not.toContain('id="ticket-rail-page-files"');
    expect(html).not.toContain('id="ticket-rail-page-search"');
  });

  it("keeps the ticket's repository facts out of the properties fold", () => {
    const html = render();
    const properties = html.slice(html.indexOf('data-testid="ticket-rail-properties"'));

    expect(properties).not.toContain("volli/VC-6-calm-stack");
    expect(properties).not.toContain("/worktrees/");
  });
});

// The card itself, rendered as the Diffs page mounts it. `renderToStaticMarkup`
// runs no effects, so it is frozen in the state it holds on the very first
// frame — before `worktree.status` or the Change Set has answered.
const renderCard = (subject: Ticket = ticket) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <TicketRepositorySummary projectId="project-1" ticket={subject} />
    </TooltipProvider>,
  );

describe("the repository card", () => {
  it("opens on the branch, and draws no changes row of its own", () => {
    const html = renderCard();

    // The page under it IS the change list, and its header two lines up
    // already carries the count and the ± pair (VC-406). A card row saying
    // "12 changes" over that list was the same fact drawn twice, coarser, with
    // a button that routed to the page it was already on.
    expect(html).not.toContain('data-testid="ticket-repository-changes"');
    expect(html).not.toContain("show Diffs");
    expect(html).toContain('data-testid="ticket-repository-branch"');
    expect(html).toContain('aria-label="Branch main to volli/VC-6-calm-stack"');
  });

  it("holds no Git-state block until a status read has landed", () => {
    // The strip is a row of this card now rather than a floating mini-table in
    // the changes header — and a row about counts nobody has read yet would be
    // three dashes pretending to be a measurement.
    expect(renderCard()).not.toContain('data-testid="ticket-changes-git-state"');
  });

  it("still names the worktree identity before one exists", () => {
    // VC-16: the scoping chosen in the composer stays readable — and
    // changeable — until the worktree is a fact on disk, and this card's
    // identity popover is where that control lives. The Diffs page therefore
    // draws the card even with no worktree, instead of replacing the whole
    // page with an empty state that would take the control off screen.
    const html = renderCard(ticketWithoutWorktree);

    expect(html).toContain('data-testid="ticket-repository-branch"');
    expect(html).toContain('aria-label="Worktree identity"');
  });

  it("offers no publish controls until the ticket has a worktree", () => {
    expect(renderCard(ticketWithoutWorktree)).not.toContain('aria-label="More repository actions"');
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
