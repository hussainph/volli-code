import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  // VC-406 follow-up. The rail's scroll containers draw no scrollbar, so a fold
  // opening cannot take 10px out of every row's width and hand it back on the
  // way out. The rule is in globals.css and keyed to this marker, so the marker
  // is what a test can hold: dropped from the column, the stylesheet still
  // parses and every rail page silently gets its reflow back.
  it("marks its column as the scope globals.css hides rail scrollbars in", () => {
    const html = render();

    expect(html).toContain('data-volli-rail="ticket"');
    // On the ROOT, not on one scroller: the Diffs, Files and Search pages are
    // handed in by the host and scroll in elements this file never sees.
    const root = html.indexOf('data-volli-rail="ticket"');
    expect(root).toBeGreaterThan(-1);
    expect(root).toBeLessThan(html.indexOf('role="tablist"'));
    expect(root).toBeLessThan(html.indexOf("overflow-y-auto"));
    expect([...html.matchAll(/data-volli-rail=/g)]).toHaveLength(1);
    // The page still scrolls — only the bar is gone, so the overflow the
    // scroller declares is untouched by the marker beside it.
    expect(html).toContain("overflow-y-auto");
  });

  // The stylesheet half of the same contract, read off the file rather than
  // rendered: jsdom draws no scrollbar and Chromium is not in this suite, so
  // what is provable here is that the RULE exists, that it is keyed to the
  // marker above, and — the part that matters most — that it is still SCOPED.
  // Widening it to `*` would take the app's overlay scrollbars off the editor,
  // the sidebar and every portalled menu, which is the one way this cosmetic
  // fix could do real damage.
  it("hides the scrollbar in globals.css for that scope alone", () => {
    const css = readFileSync(
      path.join(fileURLToPath(new URL(".", import.meta.url)), "../../globals.css"),
      "utf8",
    );

    expect(css).toContain("[data-volli-rail] *::-webkit-scrollbar");
    expect(css).toMatch(/\[data-volli-rail\][\s\S]{0,120}scrollbar-width: none/);
    // The global treatment the rest of the app keeps: a 10px bar with a token
    // thumb. If this ever stops matching, the rail's rule stopped being an
    // exception and became the policy.
    expect(css).toMatch(/\*::-webkit-scrollbar \{\s*width: 10px/);
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

  // The worktree is the rail's FOOTER (VC-406, second pass): one pinned row
  // under every page, outside the tabpanel, with the card's body folded above
  // it. Asserted on position because putting the card back inside a page is a
  // one-line change that would leave the resting page with no git signal
  // again, or two worktree surfaces one tab apart — the two states this ticket
  // exists to end.
  it("pins the worktree row under the page, outside the tabpanel", () => {
    const html = render();
    const page = html.indexOf('id="ticket-rail-page-now"');
    const pageEnd = html.indexOf("</section>", html.lastIndexOf("overflow-y-auto"));
    const footer = html.indexOf('data-testid="ticket-repository-summary"');

    expect(footer).toBeGreaterThan(pageEnd);
    expect(page).toBeGreaterThan(-1);
    // The row alone: the body (state strip, publish row) is folded by default.
    expect(html).toContain('data-testid="ticket-repository-branch"');
    expect(html).not.toContain('data-testid="ticket-changes-git-state"');
    expect(html).toContain("volli/VC-6-calm-stack");
  });

  // The order IS the design (VC-406, second pass), and it is by frequency of
  // attention rather than by kind: the facts, then the roster a person reads
  // every few minutes, then the list they press now and again. Asserted on the
  // markup's own sequence because a reorder in the composition is a one-line
  // change that no other test would notice.
  it("opens with the facts, then the roster, then the acts", () => {
    const html = render();
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };

    const properties = at('data-testid="ticket-rail-properties"');
    const sessions = at('aria-label="New chat"');
    const automations = at('data-testid="ticket-rail-automations"');

    expect(properties).toBeLessThan(sessions);
    expect(sessions).toBeLessThan(automations);
  });

  it("draws every block on Now as a section — an eyebrow over rows, no card, no act button", () => {
    const html = render();
    const page = html.slice(
      html.indexOf('id="ticket-rail-page-now"'),
      html.indexOf('data-testid="ticket-repository-summary"'),
    );

    // Three eyebrows, in order.
    const eyebrows = [
      ...page.matchAll(/<h2[^>]*>(?:<button[^>]*>)?(Properties|Sessions|Automations)/g),
    ].map((match) => match[1]);
    expect(eyebrows).toEqual(["Properties", "Sessions", "Automations"]);
    // No framed card, and no ACT the page offers: `Run once` is gone. The
    // `RAIL_CONTROL` recipe survives on Now in exactly one place — the two
    // Properties dropdowns, which are a row's VALUE rather than something the
    // page does, and are the app's own pickers rather than a rail-local
    // control. Counted, so a third raised button cannot appear unnoticed.
    expect(page).not.toContain("rounded-xl border border-sidebar-border/70");
    expect(page).not.toContain("Run once");
    expect([...page.matchAll(/shadow-raised/g)]).toHaveLength(2);
    for (const field of ["status", "priority"]) {
      expect(page).toContain(`data-testid="ticket-rail-property-${field}"`);
    }
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

  it("keeps the ticket's repository facts out of the properties section", () => {
    const html = render();
    const properties = html.slice(
      html.indexOf('data-testid="ticket-rail-properties"'),
      html.indexOf('data-testid="ticket-sessions"'),
    );

    expect(properties).not.toContain("volli/VC-6-calm-stack");
    expect(properties).not.toContain("/worktrees/");
  });
});

// The worktree footer itself, rendered as the rail mounts it.
// `renderToStaticMarkup` runs no effects, so it is frozen in the state it holds
// on the very first frame — before `worktree.status` or the Change Set has
// answered — and reads the UI store's INITIAL state, in which every fold is
// closed.
const renderCard = (subject: Ticket = ticket) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <TicketRepositorySummary projectId="project-1" ticket={subject} />
    </TooltipProvider>,
  );

describe("the worktree footer", () => {
  it("is one row: the branch, and the fold's trigger beside it", () => {
    const html = renderCard();

    // The row wears the footer's rule, not the card frame, and draws no
    // changes row of its own — the Diffs page IS the change list.
    expect(html).toContain("border-t border-sidebar-border/70");
    expect(html).not.toContain("rounded-xl");
    expect(html).not.toContain('data-testid="ticket-repository-changes"');
    expect(html).toContain('data-testid="ticket-repository-branch"');
    expect(html).toContain('aria-label="Branch main to volli/VC-6-calm-stack"');
    // Two targets: the branch opens the identity popover, the caret the fold.
    expect(html).toContain('data-testid="ticket-repository-fold"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("says nothing at its right edge until a status read has landed", () => {
    // The glance is one fact about the branch, in the body's own words; before
    // the status is read there is no honest fact to print, so the row shows
    // the branch alone rather than a placeholder (`worktree-glance-model.ts`).
    const html = renderCard();

    expect(html).not.toContain('data-testid="ticket-repository-glance"');
    expect(html).not.toContain('data-testid="ticket-changes-git-state"');
  });

  it("keeps its body folded by default, and the body is where the controls are", () => {
    const html = renderCard();

    expect(html).not.toContain('aria-label="More repository actions"');
    expect(html).not.toContain('aria-label="Publish repository changes"');
  });

  it("still names the worktree identity before one exists, and offers no fold", () => {
    // VC-16: the scoping chosen in the composer stays readable — and
    // changeable — until the worktree is a fact on disk, and this row's
    // identity popover is where that control lives. A ticket with no
    // worktree has nothing to unfold, so the row is the branch alone.
    const html = renderCard(ticketWithoutWorktree);

    expect(html).toContain('data-testid="ticket-repository-branch"');
    expect(html).toContain('aria-label="Worktree identity"');
    expect(html).not.toContain('data-testid="ticket-repository-fold"');
    expect(html).not.toContain('aria-label="More repository actions"');
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
