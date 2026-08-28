import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { PrCheck, TicketRetentionState } from "../../../../ipc/contract";

import { resolvePrChecks } from "./pr-checks-model";
import { ChecksDetail, PrChecksRow } from "./pr-checks-row";

function check(name: string, state: PrCheck["state"], over: Partial<PrCheck> = {}): PrCheck {
  return { name, workflow: null, state, url: null, ...over };
}

function retention(over: Partial<TicketRetentionState> = {}): TicketRetentionState {
  return {
    ticketId: "t1",
    prUrl: "https://github.com/o/r/pull/7",
    prState: "open",
    hasConflicts: false,
    checks: [],
    archiveReady: false,
    reason: null,
    keep: false,
    dismissed: false,
    ...over,
  };
}

function render(state: TicketRetentionState | null) {
  return renderToStaticMarkup(<PrChecksRow retention={state} />);
}

/** The popover's own contents, which portal out of the row's static render. */
function renderDetail(state: TicketRetentionState) {
  return renderToStaticMarkup(<ChecksDetail view={resolvePrChecks(state)!} />);
}

describe("PrChecksRow — absence", () => {
  it("draws nothing at all before the retention state has loaded", () => {
    expect(render(null)).toBe("");
  });

  it("draws nothing for a PR with no checks", () => {
    // A project without a GitHub Actions pipeline. The row is absent because
    // there is nothing to report — not because a preference is off, and not
    // as an empty state explaining the absence.
    expect(render(retention({ checks: [] }))).toBe("");
  });

  it("draws nothing when the ticket has no PR yet", () => {
    expect(render(retention({ prUrl: null, checks: [check("build", "passing")] }))).toBe("");
  });
});

describe("PrChecksRow — the row", () => {
  it("states the verdict and stays a peer of the card's other rows", () => {
    const html = render(
      retention({ checks: [check("lint", "failing"), check("test", "passing")] }),
    );
    expect(html).toContain('data-testid="ticket-repository-checks"');
    expect(html).toContain("1 check failing");
    // The card's shared row recipe, not a list row: the seam and the focus ring
    // are what make it read as the same object as Changes and Branch.
    expect(html).toContain("border-t");
    expect(html).toContain("focus-visible:ring-2");
  });

  it("gives the breakdown to a pointer and a screen reader alike", () => {
    const html = render(
      retention({ checks: [check("lint", "failing"), check("test", "passing")] }),
    );
    // `aria-label` overrides the accessible name, so a breakdown living only in
    // `title` would reach a hover and nothing else. Both carry it.
    expect(html).toContain('title="1 failing · 1 passed"');
    expect(html).toContain('aria-label="1 check failing, 1 failing · 1 passed. Show checks"');
  });

  it("drops the breakdown from the name when one state accounts for everything", () => {
    const html = render(retention({ checks: [check("test", "passing")] }));
    expect(html).toContain('aria-label="All checks passed. Show checks"');
  });
});

describe("PrChecksRow — the popover", () => {
  it("holds no check rows until it is opened", () => {
    const html = render(retention({ checks: [check("lint", "failing")] }));
    expect(html).not.toContain("Open the run on GitHub");
    expect(html).not.toContain("All checks on GitHub");
  });

  it("lists every check in the model's reading order, failing first", () => {
    const html = renderDetail(
      retention({
        checks: [
          check("Desktop smoke", "skipped", { workflow: "CI" }),
          check("Check + Test", "failing", { workflow: "CI", url: "https://gh/run/1" }),
          check("e2e", "pending", { workflow: "CI" }),
        ],
      }),
    );
    const order = ["Check + Test", "e2e", "Desktop smoke"].map((name) => html.indexOf(name));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it("prefixes a job with its workflow, in GitHub's own shape", () => {
    const html = renderDetail(
      retention({ checks: [check("Check + Test", "passing", { workflow: "CI" })] }),
    );
    // A matrix repeats job names across workflows; the workflow is what tells
    // two identically-named rows apart.
    expect(html).toContain("CI / ");
    expect(html).toContain("Check + Test");
  });

  it("makes a check with a log a button, and one without a plain row", () => {
    const linked = renderDetail(
      retention({ checks: [check("linked", "failing", { url: "https://gh/run/1" })] }),
    );
    expect(linked).toContain("<button");
    expect(linked).toContain("Open the run on GitHub");

    // A legacy status context often publishes no target. A control that looks
    // pressable and goes nowhere is worse than a line of text.
    const bare = renderDetail(retention({ checks: [check("ci/legacy", "failing")] }));
    expect(bare).not.toContain("Open the run on GitHub");
  });

  it("names each check's state where a pointer and a screen reader can both reach it", () => {
    const html = renderDetail(
      retention({ checks: [check("e2e", "pending", { workflow: "CI", url: "https://gh/2" })] }),
    );
    expect(html).toContain("CI / e2e, running. Open the run on GitHub");
  });

  it("always offers the way out to the PR's own Checks tab", () => {
    const html = renderDetail(retention({ checks: [check("a", "passing")] }));
    expect(html).toContain("All checks on GitHub");
  });

  it("names the list, which the popover's `p` heading cannot do", () => {
    const html = renderDetail(retention({ checks: [check("a", "passing")] }));
    expect(html).toContain('aria-label="Checks on this pull request"');
  });

  it("heads the list with the breakdown when more than one state is in play", () => {
    const mixed = renderDetail(
      retention({ checks: [check("a", "failing"), check("b", "passing")] }),
    );
    expect(mixed).toContain("1 failing · 1 passed");

    // The row's own label already said "All checks passed"; a header counting
    // to the same total in different words is noise, not detail. (The word
    // still appears per check, in each row's `title`.)
    const uniform = renderDetail(retention({ checks: [check("a", "passing")] }));
    expect(uniform).not.toContain("1 passed");
  });
});
