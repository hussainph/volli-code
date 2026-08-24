/**
 * Configure → Authority, the door VC-172 added.
 *
 * WHAT THIS LAYER CAN SEE. These render to static markup, which is the house
 * pattern for a pane — and a Radix `Select` renders its trigger with an EMPTY
 * value span there, while an `InfoHint` keeps its prose in an unopened popover.
 * So neither the selected word nor the hint text is assertable here, and
 * pretending otherwise would be a test that passes on markup nobody sees.
 *
 * What IS assertable is the thing worth pinning: which rows exist, and which of
 * them are marked as having departed from the built-in defaults. Divergence is
 * `OverrideControl`'s revert button, its `aria-label` names the inherited value
 * it would return to, and both render. That is the inheritance model itself —
 * the reason the pane stores departures rather than a resolved document.
 */
import { DEFAULT_AUTHORITY_POLICY, type Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { AuthorityPane } from "./authority-pane";

function project(authorityPolicy: Project["authorityPolicy"] = null): Project {
  return {
    id: "p1",
    name: "Volli Code",
    path: "/repo/volli",
    ticketPrefix: "VC",
    baseBranch: "trunk",
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    authorityPolicy,
  };
}

function render(policy: Project["authorityPolicy"] = null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AuthorityPane project={project(policy)} />
    </TooltipProvider>,
  );
}

describe("Configure → Authority", () => {
  it("gives every settable part of the policy a row", () => {
    // The ticket's list of what was settable in principle and unsettable in
    // practice: enforcement, judgment, both thresholds, and the per-actor
    // policy for each of VC-92's three actor kinds.
    const html = render(null);

    for (const testId of [
      "authority-enforcement",
      "authority-judgment",
      "authority-consecutive-denials",
      "authority-session-denials",
      "authority-peek-user",
      "authority-peek-session",
      "authority-peek-unauthenticated",
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
  });

  it("marks nothing as overridden for a project that has stated nothing", () => {
    // The only state that was reachable before this pane existed: every project
    // resolved to the compiled defaults, permanently.
    expect(render(null)).not.toContain('aria-label="Reset ');
  });

  it("marks the departed row, naming the value its revert returns to", () => {
    const html = render({ enforcement: "enforce" });

    expect(html).toContain("Reset Rule enforcement to the app-wide value, Observe");
    // And ONLY that row. A departure on one field must not mark the rest, or
    // the surface would report departures the stored document does not hold.
    expect(html).not.toContain("Reset Who judges the rest");
    expect(html).not.toContain("Reset An authenticated session can read");
  });

  it("marks one actor without marking the others", () => {
    const html = render({ actors: { session: { peek: "project" } } });

    expect(html).toContain(
      "Reset An authenticated session can read to the app-wide value, Its own only",
    );
    expect(html).not.toContain("Reset An unauthenticated caller can read");
    expect(html).not.toContain("Reset You can read");
  });

  it("shows the inherited thresholds a Session escalates on", () => {
    const html = render(null);

    expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.consecutiveDenials}"`);
    expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.sessionDenials}"`);
  });

  it("shows a departed threshold and leaves the one beside it inheriting", () => {
    const html = render({ fallback: { consecutiveDenials: 7 } });

    expect(html).toContain('value="7"');
    expect(html).toContain("Reset Ask me after to the app-wide value, 3 refusals in a row");
    // The additive half of the design: a partial `fallback` must not pin the
    // field it says nothing about.
    expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.sessionDenials}"`);
    expect(html).not.toContain("Reset Or after, in total");
  });

  it("names the unauthenticated caller as its own kind, not a borrowed one", () => {
    // VC-92 ruled that "no environment variable means the user" is dead, so the
    // pane has to give that caller a row of its own rather than folding it in.
    const html = render(null);

    expect(html).toContain("An unauthenticated caller can read");
    expect(html).toContain("An authenticated session can read");
  });
});
