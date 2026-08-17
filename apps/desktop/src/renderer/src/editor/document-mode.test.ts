import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { targetAt } from "./document-decorations";
import { documentModeOptions } from "./document-mode";

describe("documentModeOptions", () => {
  it("strips every code-editor affordance a document must not show", () => {
    const options = documentModeOptions({});
    expect(options.lineNumbers).toBe("off");
    expect(options.glyphMargin).toBe(false);
    expect(options.folding).toBe(false);
    expect(options.lineDecorationsWidth).toBe(0);
    expect(options.minimap).toEqual({ enabled: false });
    expect(options.overviewRulerLanes).toBe(0);
    expect(options.renderLineHighlight).toBe("none");
    expect(options.contextmenu).toBe(false);
  });

  it("reads as prose: wrapped, sans-serif, and measured from the DOM", () => {
    const options = documentModeOptions({});
    expect(options.wordWrap).toBe("on");
    // Decorations here change glyph widths (headings, collapsed syntax), so the
    // wrapping calculation has to measure rather than assume a monospace grid.
    expect(options.wrappingStrategy).toBe("advanced");
    expect(options.fontFamily).toBe("var(--font-sans)");
  });

  it("offers only the `@` picker, never word-based code suggestions", () => {
    const options = documentModeOptions({});
    expect(options.quickSuggestions).toBe(false);
    expect(options.wordBasedSuggestions).toBe("off");
    expect(options.suggestOnTriggerCharacters).toBe(true);
  });

  it("lets the wheel chain to the scrolling column instead of eating it", () => {
    // The host is auto-height, so this editor never scrolls internally. Monaco's
    // default `alwaysConsumeMouseWheel: true` still cancels every wheel event
    // over it, freezing the outer ticket-body / markdown column under the
    // cursor. VC-32 pins this to `false` so the surface scrolls like prose.
    const options = documentModeOptions({});
    expect(options.scrollbar?.alwaysConsumeMouseWheel).toBe(false);
  });

  it("passes a placeholder through and omits it when there is none", () => {
    expect(documentModeOptions({ placeholder: "Add description…" }).placeholder).toBe(
      "Add description…",
    );
    expect("placeholder" in documentModeOptions({})).toBe(false);
  });
});

/**
 * The document surface is CSS, so the two things that would silently undo it
 * are asserted against the stylesheet itself rather than against a copy of it.
 * Both failure modes are invisible in review and invisible in every other test:
 * a colour written as a literal stops following the canvas, and a token reset
 * that drifts BELOW the decoration rules starts winning ties against them.
 */
describe("document-mode.css surface", () => {
  const css = readFileSync(new URL("./document-mode.css", import.meta.url), "utf8");
  const surface = css.slice(css.indexOf("/* --- the surface"), css.indexOf("/* --- collapsed"));

  it("paints Monaco's own colour variables from app tokens, never literals", () => {
    // Aliases, not derivations: the app rewrites these onto the root element on
    // every canvas/appearance change, so the editor follows without a rebuild.
    expect(surface).toContain("--vscode-editor-background: transparent;");
    expect(surface).toContain("--vscode-editor-foreground: var(--foreground);");
    expect(surface).toContain("--vscode-editor-placeholder-foreground: var(--muted-foreground);");
    expect(surface).toMatch(/--vscode-editor-selectionBackground:[^;]*var\(--foreground\)/);
    expect(surface).toMatch(/--vscode-scrollbarSlider-background:\s*var\(--border\);/);
    // The catalog theme's `#282c34` and friends enter as hex; nothing on this
    // surface may be one (`#` also catches a stray id selector in the block).
    expect(surface).not.toContain("#");
  });

  it("keeps every block's box paint on the whole-line element alone", () => {
    // A line class reaches BOTH the whole-line element and every glyph span in
    // the line (document-decorations.ts). A box property left on the bare class
    // is therefore painted again per span — the blockquote's rule in front of
    // each run of text, the fence's ground over the selection wash. Only the
    // whole-line element carries `volli-md-box`, so that is where they belong.
    // Ends at the image rules: a view zone is the app's own DOM, not a line
    // decoration, so it has no whole-line element to hang a radius off.
    const blocks = css.slice(css.indexOf("/* --- blocks"), css.indexOf("/* Images live in"));
    const boxProperty =
      /\b(background|border(-top|-bottom|-left|-right)?(-left|-right)?-?(radius|width|color)?)\s*:/;
    for (const rule of blocks.split("}")) {
      const [selector, body = ""] = rule.split("{");
      if (!boxProperty.test(body)) continue;
      expect(selector).toContain(".volli-md-box");
    }
  });

  it("resets catalog token colours above the decoration rules that tie with it", () => {
    // Monaco renders a decorated token as `class="mtk1 volli-md-h1"`, so both
    // rules match the same span at the same specificity and source order is the
    // only tie-break: the reset must come first for the decoration to win.
    const reset = css.indexOf('.volli-document-mode [class*="mtk"]');
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(css.indexOf(".volli-document-mode .volli-md-h1"));
  });
});

describe("targetAt", () => {
  const targets = [
    { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 7 }, id: "a" },
    { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 3 }, id: "b" },
  ];

  it("finds the target holding a position", () => {
    expect(targetAt(targets, { lineNumber: 1, column: 4 })?.id).toBe("a");
    expect(targetAt(targets, { lineNumber: 3, column: 9 })?.id).toBe("b");
    expect(targetAt(targets, { lineNumber: 4, column: 1 })?.id).toBe("b");
  });

  it("includes the start column and excludes the end column", () => {
    // The end column is where the character AFTER the span begins, so a click
    // there is a click on the next thing along, not on this one.
    expect(targetAt(targets, { lineNumber: 1, column: 2 })?.id).toBe("a");
    expect(targetAt(targets, { lineNumber: 1, column: 7 })).toBeNull();
  });

  it("is null outside every target", () => {
    expect(targetAt(targets, { lineNumber: 1, column: 1 })).toBeNull();
    expect(targetAt(targets, { lineNumber: 2, column: 1 })).toBeNull();
    expect(targetAt(targets, { lineNumber: 4, column: 3 })).toBeNull();
    expect(targetAt(targets, { lineNumber: 9, column: 1 })).toBeNull();
  });

  it("is null when there is nothing to hit", () => {
    expect(targetAt([], { lineNumber: 1, column: 1 })).toBeNull();
  });
});
