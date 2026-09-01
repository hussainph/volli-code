import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { DiffControlBand } from "./diff-presentation-toggle";

const noop = (): void => {};

function draw(presentation: "inline" | "side-by-side", wordWrap: boolean): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <DiffControlBand
        presentation={presentation}
        onPresentationChange={noop}
        wordWrap={wordWrap}
        onToggleWordWrap={noop}
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
