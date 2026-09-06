import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MARKDOWN_FILE_VIEW,
  documentViewRefusal,
  offersMarkdownViewToggle,
  resolveMarkdownFileView,
} from "./document-view-policy";
import { projectMarkdown, type ProjectionOp } from "./markdown-projection";

describe("offersMarkdownViewToggle", () => {
  it("offers the choice on editable repository markdown", () => {
    expect(offersMarkdownViewToggle({ relPath: "docs/DESIGN.md", editable: true })).toBe(true);
  });

  it("never offers it on a file that is not markdown", () => {
    expect(offersMarkdownViewToggle({ relPath: "src/index.ts", editable: true })).toBe(false);
  });

  it("never offers it on a read-only view — a capped read is a prefix, not a document", () => {
    expect(offersMarkdownViewToggle({ relPath: "docs/DESIGN.md", editable: false })).toBe(false);
  });
});

describe("resolveMarkdownFileView", () => {
  it("defaults to source: a file tab is a view into a code checkout", () => {
    expect(DEFAULT_MARKDOWN_FILE_VIEW).toBe("source");
    expect(resolveMarkdownFileView({ preferred: "source", refusal: null })).toBe("source");
  });

  it("honours a remembered Document choice when the bytes allow it", () => {
    expect(resolveMarkdownFileView({ preferred: "document", refusal: null })).toBe("document");
  });

  it("lets the bytes outvote the preference — a file can grow frontmatter", () => {
    const refusal = documentViewRefusal("---\ntitle: x\n---\n\nBody.\n");
    expect(refusal).not.toBeNull();
    expect(resolveMarkdownFileView({ preferred: "document", refusal })).toBe("source");
  });
});

describe("documentViewRefusal — frontmatter", () => {
  it("refuses a file whose first line opens YAML frontmatter", () => {
    expect(documentViewRefusal("---\ntitle: Hello\ntags: [a, b]\n---\n\n# Real\n")).toEqual({
      reason: "frontmatter",
      line: 1,
      message:
        "Document view can't show this file: YAML frontmatter (line 1) renders as a heading.",
    });
  });

  it("refuses the `...` close YAML also allows, and tolerates CRLF", () => {
    expect(documentViewRefusal("---\r\ntitle: x\r\n...\r\n\r\ntext\r\n")?.reason).toBe(
      "frontmatter",
    );
  });

  it("names what the projection would actually do with it", () => {
    // The refusal is not a taste call: this is the picture Document Mode draws
    // for frontmatter. The opening `---` is REPLACED by a rendered rule, the
    // closing one is HIDDEN as a Setext heading mark, and the `[`/`]` of a YAML
    // list are hidden as link marks — metadata on screen as a heading, with
    // pieces of itself missing.
    const text = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Real\n";
    const ops = projectMarkdown({ text, selection: [], focused: false });
    expect(ops).toContainEqual({ kind: "widget", from: 0, to: 3, widget: { type: "rule" } });
    const hidden = ops
      .filter((op) => op.kind === "hide")
      .map((op) => text.slice(op.from, op.to))
      .toSorted();
    expect(hidden).toContain("---"); // the closing fence, gone
    expect(hidden).toContain("["); // the YAML list's own brackets, gone
  });

  it("allows a thematic break that merely looks like one", () => {
    // A `---` mid-document is a horizontal rule and renders as exactly that.
    expect(documentViewRefusal("Text.\n\n---\n\nMore text.\n")).toBeNull();
    // An opening `---` with nothing to close it is a rule at the top of a file.
    expect(documentViewRefusal("---\n\nJust a rule above this.\n")).toBeNull();
  });
});

describe("documentViewRefusal — raw HTML", () => {
  it("refuses a raw HTML block and names its line", () => {
    const text = '# Title\n\nText.\n\n<p align="center">\n  <img src="x.png">\n</p>\n\nMore.\n';
    expect(documentViewRefusal(text)).toEqual({
      reason: "raw-html",
      line: 5,
      message: "Document view can't show this file: raw HTML (line 5) has no rendering here.",
    });
  });

  it("allows INLINE html — one token in a paragraph that still renders", () => {
    // `Open in <editor>` is this repo's own prose, four times across two plans.
    // It conceals nothing and stays visible as its own bytes.
    expect(documentViewRefusal("Open in <editor> or Finder.\n")).toBeNull();
  });

  it("allows an HTML comment: not structure, and never hidden", () => {
    expect(documentViewRefusal("<!-- prettier-ignore -->\n\nText.\n")).toBeNull();
  });

  it("is not fooled by markup inside a fenced code block", () => {
    // The whole reason the gate asks the projection's parser rather than a
    // regular expression: this is `CodeText`, not markup.
    expect(documentViewRefusal("```html\n<div>hi</div>\n```\n")).toBeNull();
  });

  it("allows an autolink, which is angle brackets and not HTML", () => {
    expect(documentViewRefusal("See <https://example.com> for more.\n")).toBeNull();
  });
});

/**
 * "Verify the projection against repo-typical markdown before enabling
 * broadly" (plan §4.6), done against the corpus the plan names: this repo's own
 * `docs/` plus its root-level markdown.
 *
 * The property under test is the honest form of "round-trips byte-identical".
 * Document Mode edits the file's own bytes — the Monaco model IS the markdown,
 * and Source and Document share one registry document — so the risk is never
 * that a byte changes on the way through. It is that a byte is on screen as
 * something else, or not on screen at all with no way to bring it back. So for
 * every file the gate agrees to open, every span the projection hides or
 * replaces must reappear when the caret is put inside it.
 */
describe("the repository's own markdown", () => {
  const root = repoRoot();
  const files = [
    ...markdownUnder(join(root, "docs")),
    ...readdirSync(root)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(root, entry)),
  ];

  it("is a corpus worth calling one", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("opens in Document view except where a named construct refuses it", () => {
    const refused = files
      .map((file) => ({
        file: file.slice(root.length + 1),
        refusal: documentViewRefusal(read(file)),
      }))
      .filter((entry) => entry.refusal !== null);

    // The README opens with five centred HTML blocks; nothing else in the
    // corpus is refused. If this list grows, the gate has started refusing
    // ordinary repository prose and the rule needs re-reading — not the test.
    expect(refused.map((entry) => `${entry.file}: ${entry.refusal?.reason}`)).toEqual([
      "README.md: raw-html",
    ]);
  });

  // The same corpus projection as the sweep below, and likewise slower when
  // coverage instrumentation shares the machine with the full renderer suite.
  it("conceals 13k spans across the corpus, and that is what is sampled below", () => {
    const spans = files
      .map(read)
      .filter((text) => documentViewRefusal(text) === null)
      .reduce(
        (total, text) =>
          total + concealedSpans(projectMarkdown({ text, selection: [], focused: false })).length,
        0,
      );
    expect(spans).toBeGreaterThan(10_000);
  }, 30_000);

  it("hides nothing in an accepted file that the caret cannot bring back", () => {
    // SAMPLED, deliberately: the property is per-span and the corpus holds
    // ~13,500 of them, which is 40 seconds of re-projection — too slow to sit
    // in the suite. The exhaustive run was made once while writing this (all
    // 13,505 spans in all 36 accepted files, green); what stays is an even
    // spread through every file, which is what would catch a projection change
    // that started swallowing something.
    for (const file of files) {
      const text = read(file);
      if (documentViewRefusal(text) !== null) continue;
      const spans = concealedSpans(projectMarkdown({ text, selection: [], focused: false }));
      const stride = Math.max(1, Math.ceil(spans.length / SPANS_SAMPLED_PER_FILE));
      for (let index = 0; index < spans.length; index += stride) {
        const span = spans[index];
        const caret = Math.floor((span.from + span.to) / 2);
        const revealed = projectMarkdown({
          text,
          selection: [{ from: caret, to: caret }],
          focused: true,
        });
        const stillConcealed = concealedSpans(revealed).some(
          (other) => other.from <= span.from && other.to >= span.to,
        );
        expect(
          stillConcealed,
          `${file.slice(root.length + 1)}: ${JSON.stringify(text.slice(span.from, span.to))} at ${String(span.from)} stays concealed with the caret in it`,
        ).toBe(false);
      }
    }
    // Its own budget, and generous on purpose: the sweep is ~1.5s bare, ~6s
    // under coverage alone, and ~20s under coverage inside the full renderer
    // suite, where 8 workers are competing for the machine. CI runs the
    // coverage gate, so a budget sized to this machine's number would be a
    // flake waiting for a slower runner.
  }, 60_000);
});

/** How many concealed spans each corpus file contributes to the reveal sweep. */
const SPANS_SAMPLED_PER_FILE = 12;

/** Every span the live preview takes off screen: collapsed syntax and rendered stand-ins. */
function concealedSpans(ops: readonly ProjectionOp[]): { from: number; to: number }[] {
  return ops
    .filter((op) => op.kind === "hide" || op.kind === "widget")
    .map((op) => ({ from: op.from, to: op.to }))
    .filter((span) => span.to > span.from);
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function markdownUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/** Walk up to the workspace root, so the corpus is found however the tests are invoked. */
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
