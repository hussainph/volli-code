import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { DiffControlBand } from "./diff-presentation-toggle";

const noop = (): void => {};

function draw(
  presentation: "inline" | "side-by-side",
  wordWrap: boolean,
  inlineFallback = false,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <DiffControlBand
        presentation={presentation}
        onPresentationChange={noop}
        wordWrap={wordWrap}
        onToggleWordWrap={noop}
        inlineFallback={inlineFallback}
      />
    </TooltipProvider>,
  );
}

describe("DiffControlBand", () => {
  it("draws every diff control on ONE band — the rule this slice ships under", () => {
    const html = draw("inline", true);
    // Exactly one bottom rule in the whole strip: the controls share the band
    // the presentation toggle already drew, and nothing here adds a second.
    expect(html.match(/class="[^"]*\bborder-b\b[^"]*"/g) ?? []).toHaveLength(1);
    expect(html).toContain('data-testid="ticket-diff-control-band"');
  });

  it("keeps each presentation's words as its accessible name once it is an icon", () => {
    const html = draw("inline", true);
    // `iconOnly` moves the label into the accessible name rather than dropping
    // it: "Inline" and "Side by side" are still what a screen reader hears.
    expect(html).toContain("Inline");
    expect(html).toContain("Side by side");
    expect(html).toContain('aria-label="Diff presentation"');
    expect(html).toContain("<svg");
  });

  it("marks the chosen presentation pressed", () => {
    expect(draw("side-by-side", true)).toContain('aria-pressed="true" data-choice="side-by-side"');
    expect(draw("side-by-side", true)).toContain('aria-pressed="false" data-choice="inline"');
    expect(draw("inline", true)).toContain('aria-pressed="true" data-choice="inline"');
  });

  it("states word wrap as a pressed state rather than two buttons", () => {
    const wrapping = draw("inline", true);
    const notWrapping = draw("inline", false);

    expect(wrapping).toContain('aria-pressed="true" aria-label="Word wrap"');
    expect(notWrapping).toContain('aria-pressed="false" aria-label="Word wrap"');
    expect(notWrapping).toContain('data-testid="ticket-diff-word-wrap"');
  });
});

/**
 * What the band says when the pane is drawing something other than what was
 * asked for (VC-288). The fit rule itself is `diff-fit.ts`'s and is tested
 * there; what is here is the control that would otherwise quietly stop meaning
 * anything — a Side by side left pressed over a diff with one column.
 */
describe("DiffControlBand in a pane too narrow for two columns", () => {
  it("keeps both presentations pressable at every width", () => {
    // The control IS the recovery: widen the pane and the choice already
    // standing in it takes effect with nothing to press. A disabled or hidden
    // segment would leave a reader who widened the pane with nothing on screen
    // saying the diff can split at all.
    const narrow = draw("side-by-side", false, true);
    for (const label of ["Inline", "Side by side"]) expect(narrow).toContain(`>${label}</span>`);
    // The ATTRIBUTE, not the word: every button carries `disabled:` variants in
    // its class list, which is styling for a state none of these are in.
    expect(narrow).not.toContain('disabled=""');
    expect(narrow).toContain('aria-pressed="true" data-choice="side-by-side"');
  });

  it("says the pane is why, in the pane, and not only on hover", () => {
    // A `title` would be the pointer's alone. This is text, in the band, in a
    // live region — read when it appears and readable while it stands.
    const narrow = draw("side-by-side", false, true);
    expect(narrow).toContain("Narrow pane");
    expect(narrow).toContain('role="status"');
  });

  it("stays quiet whenever the diff is drawing what was chosen", () => {
    expect(draw("side-by-side", false)).not.toContain("Narrow pane");
    // Inline is never a fallback: it is what was asked for.
    expect(draw("inline", false)).not.toContain("Narrow pane");
  });
});
