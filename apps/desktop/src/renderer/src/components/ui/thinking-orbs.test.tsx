/**
 * The running mark, asserted on the two things a test can actually hold: how
 * many orbs there are, and that the mark says nothing to a screen reader.
 *
 * The motion itself is a class this file only checks is applied — the shape of
 * the wave lives in `globals.css`, and a test asserting keyframe percentages
 * would be a copy of the stylesheet that fails whenever someone tunes it. What
 * must not drift is the count: the stagger is `:nth-child(2)` and
 * `:nth-child(3)`, so a fourth orb would inherit the first one's timing and a
 * second would run the whole wave alone.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThinkingOrbs } from "@renderer/components/ui/thinking-orbs";

function markup(className?: string): string {
  return renderToStaticMarkup(<ThinkingOrbs className={className} />);
}

describe("ThinkingOrbs", () => {
  it("draws exactly the three orbs the stagger is written for", () => {
    expect(markup().match(/thinking-orb\b/g)).toHaveLength(3);
  });

  it("stays out of the a11y tree, so the caller owns the words", () => {
    // The mark is never the only place "this turn is running" is said — the
    // chat plane wraps it in a live region with the word in it — so an
    // announcement here would read the same fact twice.
    expect(markup()).toContain("aria-hidden");
  });

  it("takes its colour from the caller rather than choosing one", () => {
    // `bg-current` is what lets the transcript's tail wear the same ember as
    // every other in-flight glyph while a quieter surface could wear its own.
    expect(markup()).toContain("bg-current");
    expect(markup("text-primary")).toContain("text-primary");
  });
});
