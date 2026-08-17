import { describe, expect, it } from "vite-plus/test";

import {
  LINE_BOX_CLASS,
  NEVER_GROWS_WHEN_TYPING_AT_EDGES,
  renderProjection,
} from "./document-decorations";
import type { ProjectionOp } from "./markdown-projection";

/** Render one op over `text` and return the decorations it produced. */
function decorationsFor(text: string, ops: readonly ProjectionOp[]) {
  return renderProjection({ text, ops }).decorations;
}

describe("renderProjection — line-class ops", () => {
  it("covers the whole line and reaches its glyphs", () => {
    const [deco] = decorationsFor("# Title", [
      { kind: "line-class", line: 1, className: "volli-md-h1" },
    ]);
    expect(deco.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 8,
    });
    expect(deco.options.inlineClassName).toBe("volli-md-h1");
    // The text span changes glyph widths, so Monaco must measure the DOM rather
    // than assume the monospace grid.
    expect(deco.options.inlineClassNameAffectsLetterSpacing).toBe(true);
  });

  it("asks for a whole-line box only where there is a box to paint", () => {
    // A blockquote's rule and a fence's ground are drawn across the line; a
    // heading has no box at all, so a whole-line element carrying it would
    // paint nothing on every heading line in the document.
    const quote = decorationsFor("> quoted", [
      { kind: "line-class", line: 1, className: "volli-md-blockquote" },
    ]);
    expect(quote[0].options.className).toBe(`${LINE_BOX_CLASS} volli-md-blockquote`);
    expect(quote[0].options.isWholeLine).toBe(true);

    const heading = decorationsFor("# Title", [
      { kind: "line-class", line: 1, className: "volli-md-h1" },
    ]);
    expect(heading[0].options.className).toBeUndefined();
    expect(heading[0].options.isWholeLine).toBeUndefined();
  });

  it("marks the box layer so its paint cannot repeat on every span in the line", () => {
    // Both layers carry the same class — the box needs it to find its ground,
    // the spans to find their face. Only the box carries the marker the
    // stylesheet hangs `background`/`border` off, which is what keeps a fence's
    // ground one band rather than one per run of text.
    const [deco] = decorationsFor("```", [
      { kind: "line-class", line: 1, className: "volli-md-fence" },
    ]);
    expect(deco.options.className).toBe(`${LINE_BOX_CLASS} volli-md-fence`);
    expect(deco.options.inlineClassName).toBe("volli-md-fence");
    expect(deco.options.inlineClassName).not.toContain(LINE_BOX_CLASS);
  });

  it("grows the line box for heading levels whose text outgrows it", () => {
    const h1 = decorationsFor("# a", [{ kind: "line-class", line: 1, className: "volli-md-h1" }]);
    const h3 = decorationsFor("### a", [{ kind: "line-class", line: 1, className: "volli-md-h3" }]);
    const h4 = decorationsFor("#### a", [
      { kind: "line-class", line: 1, className: "volli-md-h4" },
    ]);
    expect(h1[0].options.lineHeight).toBeGreaterThan(1);
    // h3 renders AT the body step and h4–h6 below it — the default line box
    // already fits them, so only h1 and h2 ask Monaco for more room.
    expect(h3[0].options.lineHeight).toBeUndefined();
    expect(h4[0].options.lineHeight).toBeUndefined();
  });

  it("keeps a compound class list intact and reads its line height from it", () => {
    const [deco] = decorationsFor("```\nx\n```", [
      { kind: "line-class", line: 1, className: "volli-md-fence volli-md-fence-open" },
    ]);
    // The `-open` companion rounds the top of the same box, so it rides the box
    // layer with it rather than being listed as a box of its own.
    expect(deco.options.className).toBe(`${LINE_BOX_CLASS} volli-md-fence volli-md-fence-open`);
    expect(deco.options.lineHeight).toBeUndefined();
  });

  it("clamps a line number past the end of the document", () => {
    const [deco] = decorationsFor("one", [{ kind: "line-class", line: 9, className: "x" }]);
    expect(deco.range.startLineNumber).toBe(1);
    // An unknown class paints nothing, so it gets no box either.
    expect(deco.options.className).toBeUndefined();
  });
});

describe("renderProjection — inline-class ops", () => {
  it("styles the span in place and leaves its text visible", () => {
    const [deco] = decorationsFor("a **b** c", [
      { kind: "inline-class", from: 2, to: 7, className: "volli-md-strong" },
    ]);
    expect(deco.range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 8,
    });
    expect(deco.options.inlineClassName).toBe("volli-md-strong");
    expect(deco.options.className).toBeUndefined();
    expect(deco.options.isWholeLine).toBeUndefined();
  });

  it("drops an empty span, which would decorate nothing", () => {
    expect(
      decorationsFor("ab", [{ kind: "inline-class", from: 1, to: 1, className: "volli-md-em" }]),
    ).toEqual([]);
  });

  it("never grows when typing at its edges", () => {
    const [deco] = decorationsFor("a **b** c", [
      { kind: "inline-class", from: 2, to: 7, className: "volli-md-strong" },
    ]);
    expect(deco.options.stickiness).toBe(NEVER_GROWS_WHEN_TYPING_AT_EDGES);
  });
});

describe("renderProjection — hide ops", () => {
  it("collapses the span with the zero-width inline class", () => {
    const [deco] = decorationsFor("# Title", [{ kind: "hide", from: 0, to: 2 }]);
    expect(deco.options.inlineClassName).toBe("volli-md-hidden");
    expect(deco.options.inlineClassNameAffectsLetterSpacing).toBe(true);
    expect(deco.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 3,
    });
  });

  it("drops an empty hide span, which would decorate nothing", () => {
    expect(decorationsFor("abc", [{ kind: "hide", from: 1, to: 1 }])).toEqual([]);
  });
});

describe("renderProjection — link ops", () => {
  it("marks a followable label and reports its target", () => {
    const text = "[label](https://x.test)";
    const render = renderProjection({
      text,
      ops: [
        { kind: "link", from: 1, to: 6, className: "volli-md-link", href: "https://x.test" },
        { kind: "hide", from: 0, to: 1 },
        { kind: "hide", from: 6, to: text.length },
      ],
    });
    expect(render.decorations[0].options.inlineClassName).toBe("volli-md-link volli-md-link-open");
    expect(render.links).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 7 },
        href: "https://x.test",
      },
    ]);
  });

  it("styles a revealed link but offers no click target", () => {
    const render = renderProjection({
      text: "[label](u)",
      ops: [{ kind: "link", from: 1, to: 6, className: "volli-md-link", href: null }],
    });
    expect(render.decorations[0].options.inlineClassName).toBe("volli-md-link");
    expect(render.links).toEqual([]);
  });

  it("drops a link label with no characters in it", () => {
    const render = renderProjection({
      text: "[](u)",
      ops: [{ kind: "link", from: 1, to: 1, className: "volli-md-link", href: "u" }],
    });
    expect(render.decorations).toEqual([]);
    expect(render.links).toEqual([]);
  });
});

describe("renderProjection — widget ops", () => {
  it("collapses a list marker and injects a bullet glyph in its place", () => {
    const [deco] = decorationsFor("- item", [
      { kind: "widget", from: 0, to: 1, widget: { type: "bullet" } },
    ]);
    expect(deco.options.inlineClassName).toBe("volli-md-hidden");
    expect(deco.options.before).toEqual({
      content: "•",
      inlineClassName: "volli-md-bullet",
      inlineClassNameAffectsLetterSpacing: true,
    });
  });

  it("drops a zero-width bullet, which has no marker to collapse", () => {
    expect(
      decorationsFor("- item", [{ kind: "widget", from: 0, to: 0, widget: { type: "bullet" } }]),
    ).toEqual([]);
  });

  it("renders a task marker as a box and carries the edit a click implies", () => {
    const render = renderProjection({
      text: "- [ ] todo",
      ops: [{ kind: "widget", from: 2, to: 5, widget: { type: "checkbox", checked: false } }],
    });
    expect(render.decorations[0].options.inlineClassName).toBe(
      "volli-md-checkbox volli-md-checkbox-off",
    );
    expect(render.checkboxes).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 },
        checked: false,
        toggledText: "[x]",
      },
    ]);
  });

  it("writes the unchecked marker back when a checked box is clicked", () => {
    const render = renderProjection({
      text: "- [x] todo",
      ops: [{ kind: "widget", from: 2, to: 5, widget: { type: "checkbox", checked: true } }],
    });
    expect(render.decorations[0].options.inlineClassName).toBe(
      "volli-md-checkbox volli-md-checkbox-on",
    );
    expect(render.checkboxes[0].toggledText).toBe("[ ]");
  });

  it("drops a zero-width task marker", () => {
    const render = renderProjection({
      text: "x",
      ops: [{ kind: "widget", from: 1, to: 1, widget: { type: "checkbox", checked: true } }],
    });
    expect(render.decorations).toEqual([]);
    expect(render.checkboxes).toEqual([]);
  });

  it("hides a thematic break's characters and rules the line it sat on", () => {
    const render = renderProjection({
      text: "a\n---\nb",
      ops: [{ kind: "widget", from: 2, to: 5, widget: { type: "rule" } }],
    });
    expect(render.decorations[0].options.inlineClassName).toBe("volli-md-hidden");
    expect(render.decorations[1].options).toMatchObject({
      className: `${LINE_BOX_CLASS} volli-md-hr`,
      isWholeLine: true,
    });
    expect(render.decorations[1].range.startLineNumber).toBe(2);
  });

  it("hides image syntax and asks for a view zone under its line", () => {
    const render = renderProjection({
      text: "intro\n![alt](pic.png)",
      ops: [
        { kind: "widget", from: 6, to: 21, widget: { type: "image", src: "pic.png", alt: "alt" } },
      ],
    });
    expect(render.decorations[0].options.inlineClassName).toBe("volli-md-hidden");
    expect(render.images).toEqual([{ afterLineNumber: 2, src: "pic.png", alt: "alt" }]);
  });
});
