/**
 * What the diff band says when the pane is drawing something other than what
 * was asked for (VC-288).
 *
 * The band is markup with no state of its own, so a static render is the whole
 * of it — and the mistake worth catching is not a class, it is a control that
 * quietly stops meaning anything: a Side by side that stays pressed while the
 * diff under it has one column, with nothing on screen to say why. The fit rule
 * itself is `diff-fit.ts`'s and is tested there.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { DiffControlBand } from "./diff-presentation-toggle";

/** The word-wrap control is a tooltip trigger, and Radix wants its provider. */
function band(presentation: "inline" | "side-by-side", inlineFallback: boolean): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <DiffControlBand
        presentation={presentation}
        onPresentationChange={() => undefined}
        wordWrap={false}
        onToggleWordWrap={() => undefined}
        inlineFallback={inlineFallback}
      />
    </TooltipProvider>,
  );
}

describe("the diff control band in a narrow pane", () => {
  it("keeps both presentations pressable at every width", () => {
    // The control is the recovery: widen the pane and the choice already
    // standing in it takes effect. A disabled or hidden segment would leave a
    // reader who widened the pane with nothing that says the diff can split.
    const narrow = band("side-by-side", true);
    // Icon controls, so the label lives in the `sr-only` span `Segmented`'s
    // `iconOnly` keeps as the accessible name.
    for (const label of ["Inline", "Side by side"]) expect(narrow).toContain(`>${label}</span>`);
    // The ATTRIBUTE, not the word: every button carries `disabled:` variants in
    // its class list, which is the styling for a state none of these are in.
    expect(narrow).not.toContain('disabled=""');
    expect(narrow).toContain('aria-pressed="true"');
  });

  it("says the pane is why, in the pane, and not only on hover", () => {
    // A `title` would be the pointer's alone. This is text, in the band, in a
    // live region — so it is read when it appears and readable while it stands.
    const narrow = band("side-by-side", true);
    expect(narrow).toContain("Narrow pane");
    expect(narrow).toContain('role="status"');
  });

  it("stays quiet whenever the diff is drawing what was chosen", () => {
    expect(band("side-by-side", false)).not.toContain("Narrow pane");
    // Inline is never a fallback: it is what was asked for.
    expect(band("inline", false)).not.toContain("Narrow pane");
  });
});
