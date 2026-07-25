import { describe, expect, it } from "vite-plus/test";

import { projectMarkdown } from "./markdown-projection";

describe("projectMarkdown — ATX headings", () => {
  it("gives the heading line its scale class and hides the `#` mark", () => {
    const ops = projectMarkdown({ text: "# Title", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "line-class", line: 1, className: "volli-md-h1" },
      { kind: "hide", from: 0, to: 2 },
    ]);
  });

  it("carries the heading level through to the class, up to h6", () => {
    const text = "###### Deep";
    const ops = projectMarkdown({ text, selection: [], focused: false });

    expect(ops[0]).toEqual({ kind: "line-class", line: 1, className: "volli-md-h6" });
  });

  it("numbers the line the heading starts on, not the document", () => {
    const text = "intro\n\n## Second";
    const ops = projectMarkdown({ text, selection: [], focused: false });

    expect(ops[0]).toEqual({ kind: "line-class", line: 3, className: "volli-md-h2" });
  });

  it("reveals the mark while the selection touches the heading's line", () => {
    const text = "# Title";
    const ops = projectMarkdown({ text, selection: [{ from: 4, to: 4 }], focused: true });

    expect(ops).toEqual([{ kind: "line-class", line: 1, className: "volli-md-h1" }]);
  });

  it("keeps the mark hidden when the selection is on a different line", () => {
    const text = "# Title\nbody";
    const ops = projectMarkdown({ text, selection: [{ from: 10, to: 10 }], focused: true });

    expect(ops).toContainEqual({ kind: "hide", from: 0, to: 2 });
  });

  it("reveals nothing while the editor is blurred, whatever the selection says", () => {
    // Same caret as the reveal case above — a blurred editor has no visible
    // selection, so leaving raw `#` on screen would read as a glitch.
    const text = "# Title";
    const ops = projectMarkdown({ text, selection: [{ from: 4, to: 4 }], focused: false });

    expect(ops).toContainEqual({ kind: "hide", from: 0, to: 2 });
  });

  it("hides a closing `#` run too, with no content whitespace to absorb", () => {
    const text = "## Title ##";
    const ops = projectMarkdown({ text, selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "line-class", line: 1, className: "volli-md-h2" },
      { kind: "hide", from: 0, to: 3 },
      { kind: "hide", from: 9, to: 11 },
    ]);
  });

  it("absorbs every space between the mark and the heading text", () => {
    const text = "#   Padded";
    const ops = projectMarkdown({ text, selection: [], focused: false });

    expect(ops).toContainEqual({ kind: "hide", from: 0, to: 4 });
  });

  it("gives a setext heading its scale class and hides the underline", () => {
    const text = "Title\n=====";
    const ops = projectMarkdown({ text, selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "line-class", line: 1, className: "volli-md-h1" },
      { kind: "hide", from: 6, to: 11 },
    ]);
  });

  it("maps a setext `---` underline to h2", () => {
    const text = "Title\n-----";
    const ops = projectMarkdown({ text, selection: [], focused: false });

    expect(ops[0]).toEqual({ kind: "line-class", line: 1, className: "volli-md-h2" });
  });
});

describe("projectMarkdown — inline emphasis", () => {
  it("styles a strong span and hides its `**` delimiters", () => {
    const ops = projectMarkdown({ text: "hello **bold** world", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "inline-class", from: 6, to: 14, className: "volli-md-strong" },
      { kind: "hide", from: 6, to: 8 },
      { kind: "hide", from: 12, to: 14 },
    ]);
  });

  it("styles emphasis, strikethrough and inline code the same way", () => {
    expect(projectMarkdown({ text: "*em*", selection: [], focused: false })).toEqual([
      { kind: "inline-class", from: 0, to: 4, className: "volli-md-em" },
      { kind: "hide", from: 0, to: 1 },
      { kind: "hide", from: 3, to: 4 },
    ]);
    expect(projectMarkdown({ text: "~~gone~~", selection: [], focused: false })).toEqual([
      { kind: "inline-class", from: 0, to: 8, className: "volli-md-strike" },
      { kind: "hide", from: 0, to: 2 },
      { kind: "hide", from: 6, to: 8 },
    ]);
    expect(projectMarkdown({ text: "`code`", selection: [], focused: false })).toEqual([
      { kind: "inline-class", from: 0, to: 6, className: "volli-md-code" },
      { kind: "hide", from: 0, to: 1 },
      { kind: "hide", from: 5, to: 6 },
    ]);
  });

  it("reveals the delimiters when the caret touches the span, not merely the line", () => {
    const text = "a **b** c";
    // Caret on the same line but outside the span: still collapsed.
    expect(projectMarkdown({ text, selection: [{ from: 8, to: 8 }], focused: true })).toEqual([
      { kind: "inline-class", from: 2, to: 7, className: "volli-md-strong" },
      { kind: "hide", from: 2, to: 4 },
      { kind: "hide", from: 5, to: 7 },
    ]);
    // Caret inside the span: the delimiters come back, the styling stays.
    expect(projectMarkdown({ text, selection: [{ from: 5, to: 5 }], focused: true })).toEqual([
      { kind: "inline-class", from: 2, to: 7, className: "volli-md-strong" },
    ]);
  });

  it("reveals a nested span independently of its container", () => {
    const text = "**bold *and italic***";
    // Caret inside the inner emphasis touches BOTH spans, so both reveal.
    const inner = projectMarkdown({ text, selection: [{ from: 12, to: 12 }], focused: true });
    expect(inner).toEqual([
      { kind: "inline-class", from: 0, to: 21, className: "volli-md-strong" },
      { kind: "inline-class", from: 7, to: 19, className: "volli-md-em" },
    ]);
    // With the caret away, both containers collapse their own marks.
    const away = projectMarkdown({ text, selection: [], focused: false });
    expect(away).toEqual([
      { kind: "inline-class", from: 0, to: 21, className: "volli-md-strong" },
      { kind: "hide", from: 0, to: 2 },
      { kind: "hide", from: 19, to: 21 },
      { kind: "inline-class", from: 7, to: 19, className: "volli-md-em" },
      { kind: "hide", from: 7, to: 8 },
      { kind: "hide", from: 18, to: 19 },
    ]);
  });
});

describe("projectMarkdown — links", () => {
  it("styles the label, hides the syntax and carries the href", () => {
    const ops = projectMarkdown({ text: "[label](http://x)", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "link", from: 1, to: 6, className: "volli-md-link", href: "http://x" },
      { kind: "hide", from: 0, to: 1 },
      { kind: "hide", from: 6, to: 17 },
    ]);
  });

  it("drops the href and restores the syntax while the caret is in the link", () => {
    const text = "[label](http://x)";
    const ops = projectMarkdown({ text, selection: [{ from: 3, to: 3 }], focused: true });

    // A revealed link is being edited, not followed — an href here would make a
    // click navigate away mid-edit.
    expect(ops).toEqual([{ kind: "link", from: 1, to: 6, className: "volli-md-link", href: null }]);
  });

  it("styles a reference link with no inline URL but carries no href", () => {
    const ops = projectMarkdown({ text: "[label]", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "link", from: 1, to: 6, className: "volli-md-link", href: null },
      { kind: "hide", from: 0, to: 1 },
      { kind: "hide", from: 6, to: 7 },
    ]);
  });

  it("emits no label op for an empty label, and collapses the whole link", () => {
    const ops = projectMarkdown({ text: "[](http://x)", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "hide", from: 0, to: 1 },
      { kind: "hide", from: 1, to: 12 },
    ]);
  });

  it("does not re-decorate markup inside a link label", () => {
    // The label is replaced wholesale by one styled span, so inline emphasis
    // inside it must not also be collapsed — that would eat the link's text.
    const ops = projectMarkdown({ text: "[**bold**](u)", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "link", from: 1, to: 9, className: "volli-md-link", href: "u" },
      { kind: "hide", from: 0, to: 1 },
      { kind: "hide", from: 9, to: 13 },
    ]);
  });

  it("leaves an autolink alone", () => {
    // `<http://x>` parses as an Autolink, which the CodeMirror layer never
    // decorated either — the raw text already reads as the URL.
    expect(projectMarkdown({ text: "<http://x.com>", selection: [], focused: false })).toEqual([]);
  });
});

describe("projectMarkdown — images", () => {
  it("replaces the whole node with an image widget", () => {
    const ops = projectMarkdown({ text: "![alt](img.png)", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "widget", from: 0, to: 15, widget: { type: "image", src: "img.png", alt: "alt" } },
    ]);
  });

  it("renders an image with no alt text", () => {
    const ops = projectMarkdown({ text: "![](img.png)", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "widget", from: 0, to: 12, widget: { type: "image", src: "img.png", alt: "" } },
    ]);
  });

  it("shows the raw syntax instead while the caret is inside the image", () => {
    const text = "![alt](img.png)";
    expect(projectMarkdown({ text, selection: [{ from: 4, to: 4 }], focused: true })).toEqual([]);
  });

  it("renders nothing for a reference image with no source to load", () => {
    expect(projectMarkdown({ text: "![alt]", selection: [], focused: false })).toEqual([]);
  });
});

describe("projectMarkdown — fenced code", () => {
  it("classes every line of the block and hides the fence lines", () => {
    const ops = projectMarkdown({ text: "```js\ncode\n```", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "line-class", line: 1, className: "volli-md-fence volli-md-fence-open" },
      { kind: "line-class", line: 2, className: "volli-md-fence" },
      { kind: "line-class", line: 3, className: "volli-md-fence volli-md-fence-close" },
      { kind: "hide", from: 0, to: 5 },
      { kind: "hide", from: 11, to: 14 },
    ]);
  });

  it("shows the fence lines again while the caret is anywhere in the block", () => {
    const text = "```js\ncode\n```";
    const ops = projectMarkdown({ text, selection: [{ from: 8, to: 8 }], focused: true });

    expect(ops).toEqual([
      { kind: "line-class", line: 1, className: "volli-md-fence volli-md-fence-open" },
      { kind: "line-class", line: 2, className: "volli-md-fence" },
      { kind: "line-class", line: 3, className: "volli-md-fence volli-md-fence-close" },
    ]);
  });

  it("never hides a one-line block, which would erase the block entirely", () => {
    const ops = projectMarkdown({ text: "```", selection: [], focused: false });

    expect(ops).toEqual([
      {
        kind: "line-class",
        line: 1,
        className: "volli-md-fence volli-md-fence-open volli-md-fence-close",
      },
    ]);
  });

  it("skips the closing hide when an unterminated block ends on a blank line", () => {
    const ops = projectMarkdown({ text: "```js\ncode\n\n", selection: [], focused: false });

    expect(ops).toEqual([
      { kind: "line-class", line: 1, className: "volli-md-fence volli-md-fence-open" },
      { kind: "line-class", line: 2, className: "volli-md-fence" },
      { kind: "line-class", line: 3, className: "volli-md-fence volli-md-fence-close" },
      { kind: "hide", from: 0, to: 5 },
    ]);
  });
});

describe("projectMarkdown — horizontal rules", () => {
  it("replaces the break with a rule widget", () => {
    const ops = projectMarkdown({ text: "a\n\n***\n\nb", selection: [], focused: false });

    expect(ops).toEqual([{ kind: "widget", from: 3, to: 6, widget: { type: "rule" } }]);
  });

  it("shows the raw break, marked as revealed, when the caret is on its line", () => {
    const text = "a\n\n***\n\nb";
    const ops = projectMarkdown({ text, selection: [{ from: 5, to: 5 }], focused: true });

    // The line still needs a class: an un-styled `***` would jump in size the
    // moment the caret arrives.
    expect(ops).toEqual([{ kind: "line-class", line: 3, className: "volli-md-hr-reveal" }]);
  });
});
