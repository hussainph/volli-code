/**
 * The one thing a scratch cannot tell you itself: whether it still renders.
 *
 * A scratch is dev-server-only and never built, so nothing in CI would notice
 * it breaking — you find out the day you open the lab to judge a change, which
 * is the worst possible moment. This asserts the contract the shell needs and
 * that each section still draws what its caption claims, so a refactor of the
 * row takes the scratch with it loudly rather than quietly.
 *
 * It deliberately does NOT re-assert the resolver's rules (that is
 * `pr-checks-model.test.ts`). What it checks is that the fixtures here still
 * REACH those rules — a scratch whose "failing" card silently stopped failing
 * would still pass every test in the model suite.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { isScratchModule } from "../scratch";
import * as scratch from "./pr-checks";

const html = renderToStaticMarkup(<scratch.default />);

describe("pr-checks scratch", () => {
  it("satisfies the contract the lab shell discovers it by", () => {
    expect(isScratchModule(scratch)).toBe(true);
  });

  it("still shows all four verdicts — the fixtures reach the rules they illustrate", () => {
    expect(html).toContain("1 check failing");
    expect(html).toContain("1 check running");
    expect(html).toContain("All checks passed");
    expect(html).toContain("All checks skipped");
  });

  it("draws seven live rows across the two width sections", () => {
    // Four verdicts at rail width, three at the 240px floor. A count, because
    // the failure this catches is a card that quietly stopped rendering.
    expect(html.match(/data-testid="ticket-repository-checks"/g)?.length).toBe(7);
  });

  it("says so, three times, where the row deliberately draws nothing", () => {
    expect(html.match(/renders nothing/g)?.length).toBe(3);
  });

  it("draws the popover contents inline, matrix included", () => {
    expect(html).toContain("All checks on GitHub");
    expect(html).toContain("test (ubuntu, node 24)");
  });
});
