import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ModelAccessSettings, PURPOSE_ROWS } from "./model-access-settings";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";

/**
 * The provider needs a client only for the pane's load effect, which
 * `renderToStaticMarkup` never runs — the rows and their hints render from
 * initial state. The fake exists so the context is non-null.
 */
function renderPane(): string {
  const client = {
    inspect: vi.fn(),
    defaults: vi.fn(),
    setDefault: vi.fn(),
    hiddenModels: vi.fn(),
    setHiddenModels: vi.fn(),
    compactionPolicy: vi.fn(),
    setCompactionPolicy: vi.fn(),
    beginSignIn: vi.fn(),
    signOut: vi.fn(),
  };
  return renderToStaticMarkup(
    <ModelAccessProvider client={client}>
      <TooltipProvider>
        <ModelAccessSettings />
      </TooltipProvider>
    </ModelAccessProvider>,
  );
}

describe("ModelAccessSettings", () => {
  /**
   * VC-111 moved this from a Tooltip whose `aria-label` carried the whole
   * sentence to an `InfoHint` — a `(i)` that opens a disclosure. So the copy
   * is no longer in the static markup: it is in a popover panel that mounts
   * when opened, which is what a disclosure is.
   *
   * What is still assertable, and still the thing that matters, is that the
   * hint EXISTS on the row that needs one, is a real focusable control, and
   * carries a name that says what it explains.
   */
  it("carries the utility purpose as a hint, not as prose", () => {
    const html = renderPane();
    const utilityRow = html.slice(html.indexOf('data-testid="default-model-utility"'));

    expect(html).toContain('data-testid="default-model-utility"');
    expect(utilityRow).toContain('aria-label="About Utility"');
    // That it is not PROSE is enforced structurally rather than asserted here:
    // `PrefSection` has no `description` prop at all, so the shape this
    // replaced cannot be expressed. See kit/pref-section.tsx.
  });

  it("gives the hint a real focusable control to hang its name on", () => {
    const html = renderPane();
    const trigger = html.indexOf('aria-label="About Utility"');
    const before = html.slice(0, trigger);

    // A <span tabIndex={0} aria-label> takes the tab stop but has no role to
    // be named by; a button is reachable AND announced.
    expect(before.lastIndexOf("<button")).toBeGreaterThan(before.lastIndexOf("<span"));
  });

  it("leaves the other purpose rows without a hint", () => {
    const html = renderPane();
    const globalRow = html.slice(
      html.indexOf('data-testid="default-model-global"'),
      html.indexOf('data-testid="default-model-ticket"'),
    );

    expect(globalRow).not.toContain('aria-label="About');
  });

  it("keeps the utility fallback inside the hint copy", () => {
    // CONTEXT.md's Model Access rule is that Volli never falls back to another
    // model SILENTLY. Leaving this slot empty does not switch background work
    // off — it runs on the chat's own model — so the hint has to say so, and
    // shortening it to the twelve-word budget must not drop that half.
    //
    // Read off the real constant, not restated here: an expectation that
    // recomputes the value the way the code does passes by construction.
    // The panel is a disclosure and does not render until opened, so the
    // markup cannot be the source.
    const hint = PURPOSE_ROWS.find((row) => row.purpose === "utility")?.hint ?? "";

    expect(hint).toContain("Unset");
    expect(hint).toContain("chat's own model");
    // The hint budget from kit/index.ts. A hint that grows back into a
    // paragraph is the rule this redesign removed, re-broken.
    expect(hint.split(/\s+/).length).toBeLessThanOrEqual(12);
  });
});
