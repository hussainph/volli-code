// @vitest-environment jsdom
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { documentViewRefusal } from "./document-view-policy";
import {
  OMITTED_HTML_NOTICE,
  previewSegments,
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

  it("only ever CUTS: every segment is a verbatim slice of the file, in order", () => {
    // The observable form of "Preview reads and nothing else". Comparing the
    // input string with itself afterwards proves nothing — JavaScript strings
    // are immutable (review round 1) — so this walks the output back onto the
    // input and insists each piece is found where it should be, with nothing
    // rewritten, reordered or invented.
    const text = "---\ntitle: x\n---\n\n# Real\n\n<script>alert(1)</script>\n\nAfter *it*.\n";
    let cursor = 0;
    for (const segment of previewSegments(text)) {
      if (segment.kind !== "markdown") continue;
      const at = text.indexOf(segment.text, cursor);
      expect(at, JSON.stringify(segment.text)).toBeGreaterThanOrEqual(cursor);
      cursor = at + segment.text.length;
    }
    // …and what it cut out is exactly the frontmatter and the refused block:
    // neither reaches the renderer, and both are still in the file.
    const rendered = previewSegments(text)
      .filter((segment) => segment.kind === "markdown")
      .map((segment) => segment.text)
      .join("");
    expect(rendered).not.toContain("title: x");
    expect(rendered).not.toContain("alert(1)");
    expect(rendered).toContain("# Real");
    expect(rendered).toContain("After *it*.");
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
