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
