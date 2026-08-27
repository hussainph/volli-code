import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { documentViewRefusal } from "@renderer/editor/document-view-policy";
import { MarkdownViewToggle } from "./markdown-view-toggle";

const noop = (): void => {};

function draw(view: "source" | "document", text: string): string {
  return renderToStaticMarkup(
    <MarkdownViewToggle view={view} refusal={documentViewRefusal(text)} onChange={noop} />,
  );
}

const PLAIN = "# Notes\n\nSome prose.\n";
const FRONTMATTER = "---\ntitle: Notes\n---\n\n# Notes\n";

describe("MarkdownViewToggle", () => {
  it("draws one slim band, not a second one", () => {
    // The rule VC-187 shipped under and this slice inherits: a control joins the
    // one band or a context menu. A segmented control cannot live in a menu, so
    // markdown borrows the band — and adds exactly one rule to the pane.
    const html = draw("source", PLAIN);
    expect(html.match(/class="[^"]*\bborder-b\b[^"]*"/g) ?? []).toHaveLength(1);
    expect(html).toContain('data-testid="file-view-control-band"');
  });

  it("keeps each view's word as its accessible name once it is an icon", () => {
    const html = draw("source", PLAIN);
    expect(html).toContain('aria-label="Markdown view"');
    expect(html).toContain("Source");
    expect(html).toContain("Document");
    expect(html).toContain("<svg");
  });

  it("marks the view in front as pressed", () => {
    expect(draw("source", PLAIN)).toContain('aria-pressed="true" data-choice="source"');
    expect(draw("document", PLAIN)).toContain('aria-pressed="true" data-choice="document"');
  });

  it("says why when a file refuses Document view, instead of hiding the choice", () => {
    const html = draw("source", FRONTMATTER);
    expect(html).toContain("YAML frontmatter (line 1) renders as a heading");
    // Disabled rather than absent: a control that vanished would leave the
    // person believing markdown has no document view at all. (`disabled=""` is
    // the ATTRIBUTE — the word also appears in the button's class list.)
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
    expect(html).toContain('aria-pressed="true" data-choice="source"');
  });

  it("leaves the toggle live for a file it can honestly render", () => {
    expect(draw("source", PLAIN)).not.toContain('disabled=""');
  });
});
