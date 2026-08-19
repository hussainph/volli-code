/**
 * Extraction, tested against real HTML rather than doubles.
 *
 * jsdom and Readability are the production path, so they are the test path
 * too: what these fixtures assert is what a page actually gets when it is
 * parsed, sanitised and converted. The fixtures are written to be unambiguous
 * about which part of the page each assertion is about — nav words that appear
 * nowhere else, script bodies that would fail every test if they leaked — so a
 * failure names the rule that broke rather than the paragraph that was short.
 */

import { describe, expect, it } from "vite-plus/test";

import { extractReadableMarkdown, WEB_EXTRACT_LIMITS } from "./extract";

/** A page whose article is unambiguous: prose in `main`, chrome everywhere else. */
function page(): string {
  return `<!doctype html>
<html>
  <head>
    <title>The Deployment Guide</title>
    <style>.nav-item { color: red }</style>
    <script>window.tracker = "tracking-pixel-config";</script>
  </head>
  <body>
    <nav><a href="/reference">referencenavword</a><a href="/about">aboutnavword</a></nav>
    <main>
      <article>
        <h1>The Deployment Guide</h1>
        <p>
          Run the migration before the deploy, and run it exactly once. The
          migration renames the settings table, and a deploy that starts while
          the rename is in flight will read a table that no longer exists and
          fail every request it serves.
        </p>
      </article>
    </main>
    <footer>footerword</footer>
  </body>
</html>`;
}

describe("extractReadableMarkdown", () => {
  it("extracts the article, not the chrome around it", () => {
    const result = extractReadableMarkdown(page(), "https://docs.example.com/guide");

    expect(result.extracted).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("# The Deployment Guide");
    expect(result.text).toContain("Run the migration before the deploy");
    // The three places chrome lives in the fixture, each with a word that
    // appears nowhere else in it.
    expect(result.text).not.toContain("navword");
    expect(result.text).not.toContain("footerword");
    expect(result.text).not.toContain("tracking-pixel-config");
    expect(result.text).not.toContain(".nav-item");
  });

  it("converts the whole body when Readability finds no article at all", () => {
    // A page that is nothing but a script and an image: after sanitising there
    // is no text node for Readability to score, so `parse()` declines and the
    // fallback runs over an empty body. The answer is an empty document, not
    // an error — "nothing to read" is a result, not a refusal.
    const bare = `<html><body><script>tracker()</script><img src='/pixel.png'></body></html>`;

    const result = extractReadableMarkdown(bare, "https://example.com/empty");

    expect(result.extracted).toBe(false);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("makes the heading from the page's own h1 when there is no title", () => {
    const untitled = page().replace("<title>The Deployment Guide</title>", "");

    const result = extractReadableMarkdown(untitled, "https://docs.example.com/guide");

    // Readability synthesizes the article title from the h1 when <title> is
    // absent, so the heading is still Volli's first line — from the page's own
    // structure, not from anything this module invents.
    expect(result.extracted).toBe(true);
    expect(result.text).toContain("# The Deployment Guide");
    expect(result.text).toContain("Run the migration before the deploy");
  });

  it("omits the heading when the page has neither a title nor a heading", () => {
    const anonymous = page()
      .replace("<title>The Deployment Guide</title>", "")
      .replace("<h1>The Deployment Guide</h1>", "");

    const result = extractReadableMarkdown(anonymous, "https://docs.example.com/guide");

    expect(result.extracted).toBe(true);
    expect(result.text.startsWith("#")).toBe(false);
    expect(result.text).toContain("Run the migration before the deploy");
  });

  it("strips what a page must not be able to hand a model", () => {
    const hostile = `<!doctype html>
<html>
  <head><title>Hostile</title></head>
  <body>
    <main>
      <article>
        <h1>Hostile</h1>
        <p onclick="steal()">An ordinary paragraph, with a listener attached.</p>
        <p>Try the <a href="javascript:void(0)">javascript link</a> or the
        <a href="java\tscript:void(0)">tab-obfuscated one</a> or the
        <a href="https://example.com/real">real reference</a>.</p>
        <p hidden>hidden-prompt-word</p>
        <p aria-hidden="true">aria-hidden-word</p>
        <iframe src="https://evil.example/frame"></iframe>
        <img src="https://evil.example/pixel.png" alt="tracking" />
        <svg><text>svgword</text></svg>
        <form action="https://evil.example/collect">
          <p>Text that lives inside a form, as whole frameworks arrange.</p>
          <input value="inputword" />
          <button>buttonword</button>
        </form>
      </article>
    </main>
  </body>
</html>`;

    const result = extractReadableMarkdown(hostile, "https://example.com/hostile");

    // What survives is the readable text.
    expect(result.text).toContain("An ordinary paragraph");
    expect(result.text).toContain("Text that lives inside a form");
    expect(result.text).toContain("real reference");
    // What does not: handlers, unsafe schemes, frames, images, hidden text,
    // and form controls — each with its own word. The anchor *text* "javascript
    // link" survives on purpose: the word is page copy, and what was stripped
    // is the scheme that made the link do something.
    expect(result.text).not.toContain("onclick");
    expect(result.text).not.toContain("javascript:");
    expect(result.text).not.toContain("void");
    expect(result.text).not.toContain("hidden-prompt-word");
    expect(result.text).not.toContain("aria-hidden-word");
    expect(result.text).not.toContain("evil.example");
    expect(result.text).not.toContain("![");
    expect(result.text).not.toContain("svgword");
    expect(result.text).not.toContain("inputword");
    expect(result.text).not.toContain("buttonword");
  });

  it("reads only up to the parse bound, and says that it did", () => {
    const prose = "word ".repeat(200);
    const result = extractReadableMarkdown(
      page().replace("</article>", `<p>${prose}</p></article>`),
      "https://docs.example.com/guide",
      { ...WEB_EXTRACT_LIMITS, htmlChars: 300 },
    );

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).not.toContain("Run the migration before the deploy");
  });

  it("holds the bounds the threat model set, so widening one is a visible change", () => {
    expect(WEB_EXTRACT_LIMITS).toEqual({
      htmlChars: 512 * 1024,
      maxDepth: 64,
      maxElements: 3_000,
    });
  });
});

/**
 * The structural bounds, which are the ones that decide whether a page can cost
 * this process its responsiveness.
 *
 * Every bound here is spent *before* jsdom parses, because that is the only
 * place it can be spent: measured against the unbounded version, a 43 KiB page
 * of `<div>`s nested 400 deep held the thread for 34 seconds, 256 KiB of the
 * same shape for over 90, and a page nested 5,000 deep crashed the process with
 * a stack overflow raised inside jsdom's own recursive descendant walk. The
 * assertions below are about legibility; the reason they exist is arithmetic.
 */
/** `depth` levels of `<div>`, with one readable paragraph at the bottom. */
function nested(depth: number, leaf = "<p>the buried paragraph</p>"): string {
  return `<!doctype html><html><head><title>Deep</title></head><body>${"<div>".repeat(
    depth,
  )}${leaf}${"</div>".repeat(depth)}</body></html>`;
}

/** One page whose body is exactly the given markup, plus readable prose. */
function withHidden(hidden: string): string {
  return `<!doctype html><html><head><title>Hidden</title></head><body><article><p>The ordinary visible paragraph, long enough that Readability scores this element as the content of the page.</p>${hidden}</article></body></html>`;
}

describe("the bounds on a document's shape", () => {
  it("reads an ordinary page whole, and says nothing was cut", () => {
    const result = extractReadableMarkdown(nested(10), "https://docs.example.com/ok");

    expect(result.text).toContain("the buried paragraph");
    expect(result.truncated).toBe(false);
  });

  it("stops reading a document that nests past the depth bound, and says so", () => {
    const result = extractReadableMarkdown(nested(200), "https://docs.example.com/deep", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 16,
    });

    // The scan cuts the markup where it became pathological, so the paragraph
    // buried under 200 levels never reaches the parser.
    expect(result.text).not.toContain("the buried paragraph");
    expect(result.truncated).toBe(true);
  });

  it("finishes a document nested far past anything a parser survives", () => {
    // 5,000 levels: unbounded, this overflowed the stack inside jsdom rather
    // than merely taking a long time. The bound has to be spent on the string,
    // because a crash cannot be caught by a bound applied to the tree.
    const result = extractReadableMarkdown(nested(5_000), "https://docs.example.com/abyss");

    expect(result.truncated).toBe(true);
    expect(typeof result.text).toBe("string");
  });

  it("stops reading a document with more elements than the bound allows", () => {
    const wide = `<!doctype html><html><head><title>Wide</title></head><body>${"<p>one</p>".repeat(
      400,
    )}<p>the last paragraph</p></body></html>`;

    const result = extractReadableMarkdown(wide, "https://docs.example.com/wide", {
      ...WEB_EXTRACT_LIMITS,
      maxElements: 50,
    });

    expect(result.text).not.toContain("the last paragraph");
    expect(result.truncated).toBe(true);
  });

  it("counts a run of void and self-closing tags as the flat document it is", () => {
    // 300 `<br>` and `<img/>` in a row are 300 elements at one level, not a
    // tree 300 deep; a scanner that counted them as nesting would cut an
    // ordinary page.
    const flat = `<!doctype html><html><head><title>Flat</title></head><body><article>${'<br><img src="/a.png"/>'.repeat(
      100,
    )}<p>the paragraph after all those breaks, long enough to be scored as content by Readability.</p></article></body></html>`;

    const result = extractReadableMarkdown(flat, "https://docs.example.com/flat", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 12,
    });

    expect(result.text).toContain("the paragraph after all those breaks");
  });

  it("does not read a comment, a doctype or a bare angle bracket as nesting", () => {
    const awkward = `<!doctype html><html><head><title>Awkward</title></head><body><article>${"<!-- a comment -->".repeat(
      50,
    )}<p>5 &lt; 6 and 7 < 8, which is a bare angle bracket in ordinary prose that must not be counted as a tag at all.</p></article></body></html>`;

    const result = extractReadableMarkdown(awkward, "https://docs.example.com/awkward", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 10,
    });

    expect(result.text).toContain("bare angle bracket");
  });

  it("does not read a script's own source as document structure", () => {
    // `<div>` inside a script is text, not a tag. Counting it would let a page
    // decide where Volli stops reading by writing markup in a string.
    const markup = "<div>".repeat(200);
    const scripted =
      `<!doctype html><html><head><title>Scripted</title></head><body><article>` +
      `<script>const s = "${markup}";</script>` +
      `<p>the paragraph after the script, long enough for Readability to score it as the content of this page.</p>` +
      `</article></body></html>`;

    const result = extractReadableMarkdown(scripted, "https://docs.example.com/scripted", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 12,
    });

    expect(result.text).toContain("the paragraph after the script");
    expect(result.text).not.toContain("const s");
  });

  it("survives markup that simply stops in the middle of a tag", () => {
    const cut = `<!doctype html><html><head><title>Cut</title></head><body><article><p>a paragraph that is long enough to be read as the content of this page by Readability.</p><div class="unfinished`;

    const result = extractReadableMarkdown(cut, "https://docs.example.com/cut");

    expect(result.text).toContain("a paragraph that is long enough");
  });

  it("survives a doctype and a processing instruction that are never closed", () => {
    const openDoctype = `<html><head><title>Open</title></head><body><article><p>the readable paragraph, which is long enough for Readability to treat it as this page's content.</p></article></body></html><!doctype html`;
    const instruction = `<?xml version="1.0"?><!doctype html><html><head><title>PI</title></head><body><article><p>the readable paragraph, which is long enough for Readability to treat it as this page's content.</p></article></body></html>`;
    const openInstruction = `<html><head><title>Open</title></head><body><article><p>the readable paragraph, which is long enough for Readability to treat it as this page's content.</p></article></body></html><?never closed`;

    expect(() => extractReadableMarkdown(openDoctype, "https://docs.example.com/dt")).not.toThrow();
    expect(extractReadableMarkdown(instruction, "https://docs.example.com/pi").text).toContain(
      "the readable paragraph",
    );
    expect(() =>
      extractReadableMarkdown(openInstruction, "https://docs.example.com/pi"),
    ).not.toThrow();
  });

  it("survives a comment and a script that are never closed", () => {
    const unterminated = `<!doctype html><html><head><title>Open</title></head><body><article><p>the readable paragraph, which is long enough for Readability to treat it as this page's content.</p><!-- and then a comment that never ends`;
    const openScript = `<!doctype html><html><head><title>Open</title></head><body><article><p>the readable paragraph, which is long enough for Readability to treat it as this page's content.</p><script>never closed`;

    expect(() =>
      extractReadableMarkdown(unterminated, "https://docs.example.com/open"),
    ).not.toThrow();
    expect(() =>
      extractReadableMarkdown(openScript, "https://docs.example.com/open"),
    ).not.toThrow();
  });
});

/**
 * The second bound, on the parsed tree, and why one bound is not enough.
 *
 * The scan reads the string a page sent. The parser builds the tree a browser
 * would, and those are not the same document: `<table><tr>` is two tags and
 * three elements, because the parser inserts the `<tbody>` the author left out.
 * So a page of nested tables is measurably deeper and wider once parsed than
 * anything the scan could have counted, and the walk over the real tree is what
 * catches it. Six nested tables spell 23 tags and become 25 elements 25 levels
 * deep — the numbers these tests are built on.
 */
/** `count` nested tables, with one readable paragraph at the bottom. */
function nestedTables(count: number): string {
  return (
    `<!doctype html><html><head><title>Tables</title></head><body>` +
    "<table><tr><td>".repeat(count) +
    "<p>the buried paragraph, which the parser put deeper than the markup said.</p>" +
    "</td></tr></table>".repeat(count) +
    `</body></html>`
  );
}

describe("the bound on the tree the parser actually built", () => {
  it("flattens a subtree the parser nested deeper than the markup spelled", () => {
    // 22 is above the 20 levels the string spells and below the 25 the parser
    // builds, so the scan passes this document through and the walk is the only
    // thing that bounds it.
    const result = extractReadableMarkdown(nestedTables(6), "https://docs.example.com/tables", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 22,
    });

    // Flattened rather than dropped: what the scaffolding held is still there.
    expect(result.text).toContain("the buried paragraph");
    expect(result.truncated).toBe(true);
  });

  it("leaves a leaf sitting exactly on the depth bound alone", () => {
    // The paragraph is the deepest thing in the document, at exactly 25. It has
    // no structure under it, so there is nothing to flatten and nothing to
    // report — reaching the bound is not the same as being cut by it.
    const result = extractReadableMarkdown(nestedTables(6), "https://docs.example.com/tables", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 25,
    });

    expect(result.text).toContain("the buried paragraph");
    expect(result.truncated).toBe(false);
  });

  it("drops the tail when the parser built more elements than the markup spelled", () => {
    // 23 is above the 21 elements the string spells and below the 25 the parser
    // builds, for the same reason.
    const result = extractReadableMarkdown(nestedTables(6), "https://docs.example.com/tables", {
      ...WEB_EXTRACT_LIMITS,
      maxElements: 23,
    });

    expect(result.truncated).toBe(true);
  });
});

describe("content a page has hidden from the person who looked at it", () => {
  it.each([
    ["display:none", 'style="display:none"'],
    ["display: none, spaced", 'style="display: none"'],
    ["display : none, spaced around the colon", 'style="display : none"'],
    ["DISPLAY:NONE, shouted", 'style="DISPLAY:NONE"'],
    ["display:none !important", 'style="display:none !important"'],
    ["visibility:hidden", 'style="visibility:hidden"'],
    ["visibility:collapse", 'style="visibility:collapse"'],
    ["opacity:0", 'style="opacity:0"'],
    ["font-size:0", 'style="font-size:0px"'],
    ["an off-screen offset", 'style="position:absolute;left:-9999px"'],
    ["an off-screen indent", 'style="text-indent:-4000px"'],
    ["the hidden attribute", "hidden"],
    ["aria-hidden", 'aria-hidden="true"'],
  ])("drops a paragraph hidden by %s", (_label, attribute) => {
    const result = extractReadableMarkdown(
      withHidden(`<p ${attribute}>the-hidden-instruction</p>`),
      "https://docs.example.com/hidden",
    );

    expect(result.text).toContain("The ordinary visible paragraph");
    expect(result.text).not.toContain("the-hidden-instruction");
  });

  it.each([
    ["a small negative offset, which is ordinary layout", 'style="left:-2px"'],
    ["a partial opacity", 'style="opacity:0.9"'],
    ["an ordinary declaration", 'style="color:red"'],
    ["a value that is not a length", 'style="left:auto"'],
    ["a style attribute with no colon in it at all", 'style="nonsense"'],
  ])("keeps a paragraph carrying %s", (_label, attribute) => {
    const result = extractReadableMarkdown(
      withHidden(`<p ${attribute}>the-visible-sentence, which is ordinary page copy.</p>`),
      "https://docs.example.com/visible",
    );

    expect(result.text).toContain("the-visible-sentence");
  });
});
