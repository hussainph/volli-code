import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * `source-mode.css` is asserted against the stylesheet itself, the same way
 * `document-mode.test.ts` asserts its twin — because both of this file's
 * failure modes are invisible in review and in every other test.
 *
 * A colour written as a literal stops following the canvas, silently, and only
 * on the appearance nobody had open. And a selector written with one class
 * ties with `standaloneThemeService`'s own rule, so whether the app or the
 * theme wins comes down to stylesheet order at runtime.
 */
describe("source-mode.css surface", () => {
  const css = readFileSync(new URL("./source-mode.css", import.meta.url), "utf8");
  const surface = css.slice(css.indexOf("/* --- the surface"), css.indexOf("/* --- the diff"));
  /**
   * Comments explain what the rules deliberately do NOT do, so they name the
   * very things the assertions below ban. Parse the rules, not the prose.
   */
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("paints the editor's furniture from app tokens, never literals", () => {
    // Aliases, not derivations: the app rewrites these onto the root element on
    // every canvas/appearance change, so the editor follows without a rebuild.
    expect(surface).toContain("--vscode-editor-background: var(--background);");
    expect(surface).toContain("--vscode-editorGutter-background: var(--background);");
    expect(surface).toContain("--vscode-editorLineNumber-foreground: var(--muted-foreground);");
    expect(surface).toMatch(/--vscode-editor-selectionBackground:[^;]*var\(--foreground\)/);
    expect(surface).toContain("--vscode-editorWidget-background: var(--popover);");
    expect(surface).toMatch(/--vscode-editor-findMatchBackground:[^;]*var\(--primary\)/);
    expect(surface).toMatch(/--vscode-scrollbarSlider-background:\s*var\(--border\);/);
    // A shiki theme's `#ffffff` / `#121212` enter as hex; nothing on this
    // surface may be one (`#` also catches a stray id selector in the block).
    expect(surface).not.toContain("#");
  });

  it("covers the four surfaces the ticket names", () => {
    // VC-123's cheap-alignment list, so a later edit cannot quietly drop one.
    for (const surfaceToken of [
      "--vscode-editor-background",
      "--vscode-editorGutter-background",
      "--vscode-editor-selectionBackground",
      "--vscode-editorWidget-background",
    ]) {
      expect(surface).toContain(surfaceToken);
    }
  });

  it("beats Monaco's own one-class rule on specificity, not on source order", () => {
    // `standaloneThemeService` writes the theme's variables onto `.monaco-editor`
    // itself and injects that stylesheet when a theme is applied — after this
    // file. A bare `.monaco-editor` block here would tie and lose.
    for (const rule of rules.split("}")) {
      const [selector = ""] = rule.split("{");
      if (!selector.includes(".monaco-editor") && !selector.includes(".monaco-diff-editor")) {
        continue;
      }
      for (const part of selector.split(",")) {
        if (part.trim().length === 0) continue;
        expect(part).toContain(".volli-source-mode");
      }
    }
  });

  it("uses Monaco's actual diff-gutter variables", () => {
    // Monaco reads `diffEditorGutter.insertedLineBackground` and
    // `removedLineBackground`; the former editorGutter add/delete aliases were
    // inert because those color ids do not exist.
    expect(rules).toMatch(
      /--vscode-diffEditorGutter-insertedLineBackground:[^;]*var\(--positive\)/,
    );
    expect(rules).toMatch(
      /--vscode-diffEditorGutter-removedLineBackground:[^;]*var\(--destructive\)/,
    );
    expect(rules).not.toContain("--vscode-editorGutter-addedBackground:");
    expect(rules).not.toContain("--vscode-editorGutter-deletedBackground:");
  });

  it("never selects a Document Mode editor", () => {
    // The two stylesheets describe mutually exclusive hosts. If this file could
    // reach a ticket body it would paint a ground under prose that is supposed
    // to sit transparent on its column.
    expect(rules).not.toContain(".volli-document-mode");
  });

  it("leaves the code itself to the shiki theme", () => {
    // The furniture is the app's; the syntax colours are the theme's. A rule
    // here touching `mtk*` would be this file overreaching into the one job the
    // editor theme still has.
    expect(rules).not.toContain("mtk");
  });
});
