// @vitest-environment jsdom
/**
 * The loud gate over one raw HTML block (VC-307, review round 2).
 *
 * Round 1 scanned the block with regular expressions and round 1's review broke
 * that with valid HTML: `<div title=">" onclick=…>` hid the handler behind a
 * quoted delimiter, and `href="java&#x73;cript:…"` hid the scheme behind an
 * entity. Both are now judged on the PARSED document, which is the only reading
 * of untrusted markup that agrees with the browser's.
 */
import { describe, expect, it } from "vite-plus/test";

import { renderableHtmlBlock } from "./markdown-preview-html";

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
    expect(renderableHtmlBlock("<style>body{display:none}</style>")).toBe(false);
    expect(renderableHtmlBlock('<link rel="stylesheet" href="https://evil.example/x.css">')).toBe(
      false,
    );
    expect(renderableHtmlBlock('<base href="https://evil.example/">')).toBe(false);
  });

  it("refuses foreign content: SVG and MathML are not this renderer's languages", () => {
    expect(renderableHtmlBlock('<svg>\n<use href="#x" />\n</svg>')).toBe(false);
    expect(renderableHtmlBlock('<svg>\n<image href="https://evil.example/x.png"/>\n</svg>')).toBe(
      false,
    );
    // The gap review round 1 found by widening the sanitizer's own schema: a
    // list derived from it would have followed it. This one does not.
    expect(renderableHtmlBlock("<math>\n<mtext>x</mtext>\n</math>")).toBe(false);
  });

  it("refuses an event handler, however it is spelled or hidden", () => {
    expect(renderableHtmlBlock('<div onclick="steal()">hi</div>')).toBe(false);
    expect(renderableHtmlBlock("<img src='x.png' ONERROR=alert(1)>")).toBe(false);
    expect(renderableHtmlBlock('<p\n  onmouseover = "x()"\n>hi</p>')).toBe(false);
    // A `>` inside a quoted value ends no tag. The regex scan this replaced
    // stopped there and never saw the handler (review round 1).
    expect(renderableHtmlBlock('<div title=">" onclick="alert(1)">safe</div>')).toBe(false);
  });

  it("keeps a quoted `>` that is only punctuation", () => {
    expect(renderableHtmlBlock('<div title=">">safe</div>')).toBe(true);
  });

  it("refuses a URL scheme that executes, however it is obfuscated", () => {
    expect(renderableHtmlBlock('<a href="javascript:alert(1)">x</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="vbscript:msgbox">x</a>')).toBe(false);
    expect(renderableHtmlBlock('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toBe(false);
    // Entity- and control-obfuscated schemes, which only a real parser sees.
    expect(renderableHtmlBlock('<a href="java&#x73;cript:alert(1)">run</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="&#106;avascript:alert(1)">run</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="java\tscript:alert(1)">run</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="  javascript:alert(1)">run</a>')).toBe(false);
    expect(renderableHtmlBlock('<a href="file:///etc/passwd">x</a>')).toBe(false);
  });

  it("keeps an inert data image, which is the one data: URL a picture may be", () => {
    expect(renderableHtmlBlock('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">')).toBe(
      true,
    );
  });

  it("lets a remote image through the GATE, because naming one is not loading it", () => {
    // The block is readable; the picture is not drawn. `markdown-preview-image.ts`
    // answers a remote source with a notice, and never a request — so a marker
    // over the whole block would hide prose for a decision made downstream.
    expect(renderableHtmlBlock('<img src="https://img.shields.io/badge.svg" alt="build">')).toBe(
      true,
    );
  });

  it("refuses a source attribute on anything that is not an image", () => {
    expect(renderableHtmlBlock('<span src="x.png">hi</span>')).toBe(false);
  });

  it("judges every URL attribute, not only the ones on links", () => {
    expect(renderableHtmlBlock('<blockquote cite="https://volli.app">quoted</blockquote>')).toBe(
      true,
    );
    expect(renderableHtmlBlock('<blockquote cite="javascript:alert(1)">quoted</blockquote>')).toBe(
      false,
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

  it("refuses markup that would fetch or beacon on render, so a preview stays offline", () => {
    expect(renderableHtmlBlock('<img src="a.png" srcset="https://cdn.example/a.png 2x">')).toBe(
      false,
    );
    expect(
      renderableHtmlBlock('<picture>\n<source srcset="https://cdn.example/a.png">\n</picture>'),
    ).toBe(false);
    expect(
      renderableHtmlBlock('<p style="background:url(https://cdn.example/bg.png)">hi</p>'),
    ).toBe(false);
    expect(
      renderableHtmlBlock('<a href="https://volli.app" ping="https://tracker.example">x</a>'),
    ).toBe(false);
    expect(renderableHtmlBlock('<video src="x.mp4" poster="p.png"></video>')).toBe(false);
    expect(renderableHtmlBlock('<audio src="x.mp3"></audio>')).toBe(false);
    expect(
      renderableHtmlBlock('<meta http-equiv="refresh" content="0;url=https://evil.example/">'),
    ).toBe(false);
    expect(renderableHtmlBlock('<span background="https://cdn.example/bg.png">hi</span>')).toBe(
      false,
    );
  });

  it("keeps a style that only styles", () => {
    // Refusing every `style` would put a marker over half the centred READMEs
    // in the world; the sanitizer drops the attribute and the text still reads.
    expect(renderableHtmlBlock('<p style="text-align:center">hi</p>')).toBe(true);
  });

  it("refuses a form control typed into a document", () => {
    // The sanitizer keeps `input` for markdown task lists; a checkbox written
    // as raw HTML is chrome a read-only page has no use for.
    expect(renderableHtmlBlock('<p><input type="checkbox" checked></p>')).toBe(false);
  });

  it("refuses a tag the renderer would not keep, rather than dropping it silently", () => {
    // `<article>` is not dangerous; it is simply not in the preview's tag
    // allowlist, so it would vanish along with the structure it carried. A
    // marker at least says something was left out.
    expect(renderableHtmlBlock("<article>Reading</article>")).toBe(false);
    expect(renderableHtmlBlock("<marquee>hi</marquee>")).toBe(false);
  });
});
