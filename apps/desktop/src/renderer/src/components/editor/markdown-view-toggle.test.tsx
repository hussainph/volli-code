import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { documentViewRefusal, type MarkdownFileView } from "@renderer/editor/document-view-policy";
import { MarkdownViewToggle } from "./markdown-view-toggle";

const noop = (): void => {};

function draw(view: MarkdownFileView, text: string, options: { dirty?: boolean } = {}): string {
  return renderToStaticMarkup(
    <MarkdownViewToggle
      view={view}
      refusal={documentViewRefusal(text)}
      sourceDirty={options.dirty ?? false}
      onChange={noop}
    />,
  );
}

const PLAIN = "# Notes\n\nSome prose.\n";
const FRONTMATTER = "---\ntitle: Notes\n---\n\n# Notes\n";
const RAW_HTML = '<p align="center">\n  <b>Volli Code</b>\n</p>\n';

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

  it("offers only the editable pair for a file Document view can show", () => {
    // Preview is the fallback for a refusal, so an ordinary file must not grow
    // a third, read-only way to look at itself.
    const html = draw("source", PLAIN);
    expect(html).toContain('data-choice="document"');
    expect(html).not.toContain('data-choice="preview"');
    expect(html).not.toContain('disabled=""');
  });

  it("offers read-only Preview beside Source when the bytes refuse Document view", () => {
    for (const text of [FRONTMATTER, RAW_HTML]) {
      const html = draw("source", text);
      expect(html).toContain('data-choice="preview"');
      // Document stays on screen and stays disabled: hiding it would answer a
      // question the person never got to ask.
      expect(html.match(/disabled=""/g) ?? []).toHaveLength(1);
      // (`can't` is escaped in the markup, so the assertion avoids the apostrophe.)
      expect(html).toContain("show this file");
    }
  });

  it("says why Document view is refused, and what Preview is instead", () => {
    const refused = draw("source", FRONTMATTER);
    expect(refused).toContain("YAML frontmatter (line 1) renders as a heading");

    const previewing = draw("preview", RAW_HTML);
    expect(previewing).toContain('aria-pressed="true" data-choice="preview"');
    expect(previewing).toContain("Read-only preview");
    expect(previewing.toLowerCase()).toContain("unsupported html");
    // The refusal it stopped repeating is still one hover away.
    expect(previewing).toContain('title="Document view can');
  });

  it("says that a Source draft is not what Preview is showing", () => {
    // Preview draws the file as last read or saved. With unsaved edits open in
    // Source that is a different string, and saying nothing would read as work
    // lost rather than work not previewed.
    expect(draw("preview", RAW_HTML, { dirty: true })).toContain("Unsaved");
    expect(draw("preview", RAW_HTML, { dirty: false })).not.toContain("Unsaved");
    // Source is where the draft is, so it needs no such sentence.
    expect(draw("source", RAW_HTML, { dirty: true })).not.toContain("Unsaved");
  });
});
