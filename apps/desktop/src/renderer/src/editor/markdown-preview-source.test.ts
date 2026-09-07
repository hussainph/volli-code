import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { documentViewRefusal } from "./document-view-policy";
import {
  OMITTED_HTML_NOTICE,
  previewSegments,
  renderableHtmlBlock,
  type PreviewSegment,
} from "./markdown-preview-source";

/** The markdown a preview would actually hand its renderer, in order. */
function markdownOf(segments: readonly PreviewSegment[]): string {
  return segments
    .filter((segment) => segment.kind === "markdown")
    .map((segment) => segment.text)
    .join("");
}

function omissionLines(segments: readonly PreviewSegment[]): number[] {
  return segments
    .filter((segment) => segment.kind === "omitted-html")
    .map((segment) => segment.line);
}

const README_HEAD = `<p align="center">
  <img src="apps/desktop/build/icon-source.svg" width="96" alt="Volli Code icon" />
</p>

<h1 align="center">Volli Code</h1>

## Install

Download the current build.
`;

describe("previewSegments — ordinary markdown", () => {
  it("hands an unremarkable file straight through, byte for byte", () => {
    const text = "# Notes\n\nSome prose with `code` and a [link](https://example.com).\n";
    expect(previewSegments(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("never touches the caller's string — Preview reads and nothing else", () => {
    const text = "---\ntitle: x\n---\n\n<script>alert(1)</script>\n\nBody.\n";
    const before = text;
    previewSegments(text);
    expect(text).toBe(before);
  });

  it("keeps the README's own centred HTML wrappers as one renderable document", () => {
    const segments = previewSegments(README_HEAD);
    expect(segments).toEqual([{ kind: "markdown", text: README_HEAD }]);
  });

  it("keeps a <details>/<summary> disclosure", () => {
    const text = "<details>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n";
    expect(previewSegments(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("keeps a file that alternates HTML blocks and markdown", () => {
    const text = '# Title\n\n<div align="center">\n\n**bold**\n\n</div>\n\nAfter.\n';
    expect(markdownOf(previewSegments(text))).toBe(text);
    expect(omissionLines(previewSegments(text))).toEqual([]);
  });
});

describe("previewSegments — frontmatter", () => {
  it("hides a leading YAML block without parsing or rewriting it", () => {
    const text = "---\ntitle: Notes\ntags: [a, b]\n---\n\n# Real\n\nBody.\n";
    const segments = previewSegments(text);
    expect(segments).toEqual([{ kind: "markdown", text: "\n# Real\n\nBody.\n" }]);
    expect(markdownOf(segments)).not.toContain("title: Notes");
  });

  it("hides the `...` close, and a CRLF file's block, the same way", () => {
    expect(markdownOf(previewSegments("---\r\ntitle: x\r\n...\r\n# Real\r\n"))).toBe("# Real\r\n");
  });

  it("leaves a mid-document thematic break alone — that is a rule, not metadata", () => {
    const text = "Text.\n\n---\n\nMore text.\n";
    expect(markdownOf(previewSegments(text))).toBe(text);
  });

  it("counts an omitted block's line in the FILE's coordinates, frontmatter included", () => {
    const text = "---\ntitle: x\n---\n\n<script>alert(1)</script>\n\nAfter.\n";
    expect(omissionLines(previewSegments(text))).toEqual([5]);
  });

  it("says nothing about markup INSIDE the frontmatter it hid", () => {
    // The reader was never shown that region, so a marker there would announce
    // an omission from a page that does not exist.
    const segments = previewSegments("---\n<script>alert(1)</script>\n---\n\nBody.\n");
    expect(segments).toEqual([{ kind: "markdown", text: "\nBody.\n" }]);
  });
});

describe("previewSegments — HTML that cannot be rendered safely", () => {
  it("replaces a script block with a visible marker and keeps the prose around it", () => {
    const text = "# Title\n\nBefore.\n\n<script>alert(1)</script>\n\nAfter.\n";
    const segments = previewSegments(text);
    expect(segments).toEqual([
      { kind: "markdown", text: "# Title\n\nBefore.\n\n" },
      { kind: "omitted-html", line: 5 },
      { kind: "markdown", text: "\n\nAfter.\n" },
    ]);
    expect(markdownOf(segments)).not.toContain("alert(1)");
  });

  it("marks every unsafe block, never just the first", () => {
    const text = '<script>a()</script>\n\nMiddle.\n\n<iframe src="https://evil"></iframe>\n';
    expect(omissionLines(previewSegments(text))).toEqual([1, 5]);
  });

  it("names the marker's words once, so the surface and the tests cannot drift", () => {
    expect(OMITTED_HTML_NOTICE).toBe("HTML block not rendered");
  });
});

describe("renderableHtmlBlock", () => {
  it("renders the wrappers repository READMEs are actually built from", () => {
    expect(renderableHtmlBlock('<p align="center">\n  <b>hi</b>\n</p>')).toBe(true);
    expect(renderableHtmlBlock('<h1 align="center">Volli Code</h1>')).toBe(true);
    expect(renderableHtmlBlock('<img src="docs/shot.png" width="1200" alt="Board" />')).toBe(true);
    expect(renderableHtmlBlock("<details><summary>More</summary>Body</details>")).toBe(true);
    expect(renderableHtmlBlock('<a href="https://volli.app">Download</a>')).toBe(true);
    expect(renderableHtmlBlock("<table><tr><td>1</td></tr></table>")).toBe(true);
  });

  it("refuses active content outright rather than trusting the sanitizer alone", () => {
    expect(renderableHtmlBlock("<script>alert(1)</script>")).toBe(false);
    expect(renderableHtmlBlock('<iframe src="https://evil.example"></iframe>')).toBe(false);
    expect(renderableHtmlBlock('<object data="x.swf"></object>')).toBe(false);
    expect(renderableHtmlBlock('<embed src="x.swf">')).toBe(false);
    expect(
      renderableHtmlBlock('<form action="https://evil.example"><button>Go</button></form>'),
    ).toBe(false);
    expect(renderableHtmlBlock('<svg><use href="#x" /></svg>')).toBe(false);
    expect(renderableHtmlBlock("<style>body{display:none}</style>")).toBe(false);
    expect(renderableHtmlBlock('<link rel="stylesheet" href="https://evil.example/x.css">')).toBe(
      false,
    );
    expect(renderableHtmlBlock('<base href="https://evil.example/">')).toBe(false);
  });

  it("refuses an event handler, however it is spelled", () => {
    expect(renderableHtmlBlock('<div onclick="steal()">hi</div>')).toBe(false);
    expect(renderableHtmlBlock("<img src='x.png' ONERROR=alert(1)>")).toBe(false);
    expect(renderableHtmlBlock('<p\n  onmouseover = "x()"\n>hi</p>')).toBe(false);
  });

  it("refuses a URL scheme that executes or smuggles a document", () => {
    expect(renderableHtmlBlock('<a href="javascript:alert(1)">x</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="vbscript:msgbox">x</a>')).toBe(false);
    expect(renderableHtmlBlock('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toBe(false);
  });

  it("keeps an inert data image, which is the one data: URL a picture may be", () => {
    expect(renderableHtmlBlock('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">')).toBe(
      true,
    );
  });

  it("refuses a doctype, a processing instruction and CDATA", () => {
    expect(renderableHtmlBlock("<!DOCTYPE html>")).toBe(false);
    expect(renderableHtmlBlock("<?php echo 1; ?>")).toBe(false);
    expect(renderableHtmlBlock("<![CDATA[<script>alert(1)</script>]]>")).toBe(false);
  });

  it("reads a comment as a comment: dropped on render, and never scanned as markup", () => {
    // The sanitizer deletes comment nodes, so what is inside one cannot reach
    // the page — and refusing the whole block over the word `script` inside a
    // comment would hide the div a person actually wrote.
    expect(
      renderableHtmlBlock("<div>\n<!-- <script>alert(1)</script> -->\n<b>hi</b>\n</div>"),
    ).toBe(true);
    expect(renderableHtmlBlock("<!-- prettier-ignore -->")).toBe(true);
  });

  it("refuses a tag the sanitizer would not keep, rather than dropping it silently", () => {
    // `<article>` is not dangerous; it is simply not in the renderer's tag
    // allowlist, so it would vanish along with the structure it carried. A
    // marker at least says something was left out.
    expect(renderableHtmlBlock("<article>Reading</article>")).toBe(false);
    expect(renderableHtmlBlock("<marquee>hi</marquee>")).toBe(false);
  });
});

describe("previewSegments — what is not an HTML block", () => {
  it("leaves markup inside a fenced code block alone", () => {
    const text = "```html\n<script>alert(1)</script>\n```\n";
    expect(previewSegments(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("leaves inline HTML in a paragraph alone", () => {
    const text = "Open in <editor> or Finder.\n";
    expect(previewSegments(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("drops a segment that would be nothing but whitespace", () => {
    const text = "<script>alert(1)</script>\n";
    expect(previewSegments(text)).toEqual([{ kind: "omitted-html", line: 1 }]);
  });

  it("has something to say about an empty file", () => {
    expect(previewSegments("")).toEqual([]);
  });
});

describe("this repository's own README", () => {
  // The file the ticket started from: five raw HTML blocks that Document view
  // refuses, and that Preview must nonetheless be able to READ.
  const readme = readFileSync(join(repoRoot(), "README.md"), "utf8");

  it("is still refused by the editable projection", () => {
    expect(documentViewRefusal(readme)?.reason).toBe("raw-html");
  });

  it("previews whole: every one of its HTML blocks is renderable", () => {
    const segments = previewSegments(readme);
    expect(segments).toEqual([{ kind: "markdown", text: readme }]);
  });
});

/** Walk up to the workspace root, so the README is found however the tests are invoked. */
function repoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      statSync(join(directory, "pnpm-workspace.yaml"));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("workspace root not found");
      directory = parent;
    }
  }
}
