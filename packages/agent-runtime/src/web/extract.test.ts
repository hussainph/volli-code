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

  it("converts the whole body when the page's only text is chrome Readability discards", () => {
    // Readability scores an article and finds none here, because everything on
    // the page is the sort of thing it is built to throw away. But "no article"
    // is not "no content": the words are still there, and returning them beats
    // returning nothing.
    const chrome =
      `<!doctype html><html><head><title>Notice</title></head><body>` +
      `<footer>This service was retired in March. Write to support instead.</footer>` +
      `</body></html>`;

    const result = extractReadableMarkdown(chrome, "https://example.com/notice");

    expect(result.extracted).toBe(false);
    expect(result.text).toContain("This service was retired in March");
  });

  it("falls back to what a client-rendered shell says about itself", () => {
    // The shape a single-page application serves: an empty mounting point, and
    // everything a reader wanted arriving later from scripts this never runs.
    // The head is the only thing the server actually sent, and the page's own
    // word for itself beats handing back nothing at all.
    const shell =
      `<!doctype html><html><head><title>Linear Docs</title>` +
      `<meta name="description" content="How to use Linear, from issues to cycles.">` +
      `</head><body><div id="root"></div><script>mount()</script></body></html>`;

    const result = extractReadableMarkdown(shell, "https://linear.app/docs");

    expect(result.extracted).toBe(false);
    expect(result.text).toBe("# Linear Docs\n\nHow to use Linear, from issues to cycles.");
  });

  it("takes a shell's description from OpenGraph when there is no meta description", () => {
    const shell =
      `<!doctype html><html><head><title>GPT-4</title>` +
      `<meta property="og:description" content="A large multimodal model.">` +
      `</head><body><div id="root"></div></body></html>`;

    const result = extractReadableMarkdown(shell, "https://openai.com/index/gpt-4/");

    expect(result.text).toBe("# GPT-4\n\nA large multimodal model.");
  });

  it("returns the title alone when a shell describes itself no further", () => {
    const shell = `<!doctype html><html><head><title>Only A Title</title></head><body><div id="root"></div></body></html>`;

    expect(extractReadableMarkdown(shell, "https://example.com/shell").text).toBe("# Only A Title");
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
      htmlChars: 2 * 1024 * 1024,
      maxDepth: 64,
      maxElements: 8_000,
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

  it(
    "reaches the article behind a documentation sidebar of 2,500 links",
    { timeout: 30_000 },
    () => {
      // The case that sets `maxElements`, pinned rather than asserted in prose.
      // Chrome comes *before* the article, so the element budget is spent on
      // the nav first and a tighter bound was measured dropping this page's
      // article on the floor. 2,500 links against a 3,000 bound is the margin
      // that decision left, so this is the fixture that would notice the bound
      // being tightened.
      //
      // Deliberately the expensive shape it describes, which makes it the
      // slowest test in the file: ~1s idle, and 3-5x that on a machine running
      // the rest of the suite beside it. The explicit timeout is what stops a
      // loaded CI box reading honest parse work as a hang (VC-142).
      const nav = Array.from(
        { length: 2500 },
        (_, index) => `<a href="/section/${index}">section ${index}</a>`,
      ).join(" ");
      const sidebar =
        `<!doctype html><html><head><title>Notes</title></head><body><nav>${nav}</nav>` +
        `<main><article><h1>Notes</h1><p>Run the migration before the deploy, and run it exactly once.</p></article></main></body></html>`;

      const result = extractReadableMarkdown(sidebar, "https://docs.example.com/sidebar");

      expect(result.text).toContain("Run the migration before the deploy");
      expect(result.truncated).toBe(false);
      // The nav is what the budget had to survive, not what it returns.
      expect(result.text).not.toContain("section 2499");
    },
  );

  it("reads a list whose items are never closed as flat, not as nesting", () => {
    // The shape that sent this ticket. HTML makes `</li>` optional and every
    // minifier omits it, so a sidebar is served as one `<ul>` holding a run of
    // unclosed `<li>`. Read as nesting, sixty-five links look like sixty-five
    // levels: measured against the real electronjs.org page, that cut the
    // document at 5.2% of its length and returned 1,165 characters of a
    // possible 84,489. The links are siblings, and the depth bound must see
    // them that way.
    const items = Array.from(
      { length: 400 },
      (_, index) => `<li><a href="/section/${index}">section ${index}</a>`,
    ).join("");
    const sidebar =
      `<!doctype html><html><head><title>Sidebar</title></head><body><nav><ul>${items}</ul></nav>` +
      `<main><article><h1>Sidebar</h1><p>Run the migration before the deploy, and run it exactly once.</p></article></main></body></html>`;

    const result = extractReadableMarkdown(sidebar, "https://docs.example.com/sidebar");

    expect(result.text).toContain("Run the migration before the deploy");
    expect(result.truncated).toBe(false);
  });

  it("reads a table that omits every optional end tag as the shallow table it is", () => {
    // `<thead><tr><th>Version<th>Changes<tbody><tr><td>...` is valid HTML and is
    // what nodejs.org serves. Counting each omitted end tag as another level
    // cut that page at 31.2% of its length.
    const rows = Array.from(
      { length: 200 },
      (_, index) => `<tr><td>v${index}.0.0<td>changed something in release ${index}`,
    ).join("");
    const table =
      `<!doctype html><html><head><title>History</title></head><body><article>` +
      `<h1>History</h1><table><thead><tr><th>Version<th>Changes<tbody>${rows}</table>` +
      `</article></body></html>`;

    const result = extractReadableMarkdown(table, "https://docs.example.com/history");

    // The last row is the assertion: under the old scan the depth bound was
    // reached partway down the table and everything after it was discarded.
    expect(result.text).toContain("changed something in release 199");
    expect(result.truncated).toBe(false);
  });

  it("reads a run of unclosed paragraphs as siblings", () => {
    // `</p>` is the most commonly omitted end tag there is.
    const paragraphs = Array.from(
      { length: 300 },
      (_, index) => `<p>Paragraph number ${index}, with enough words in it to be ordinary prose.`,
    ).join("");
    const article = `<!doctype html><html><head><title>Prose</title></head><body><article><h1>Prose</h1>${paragraphs}<p>Run the migration before the deploy, and run it exactly once.</p></article></body></html>`;

    const result = extractReadableMarkdown(article, "https://docs.example.com/prose");

    expect(result.text).toContain("Run the migration before the deploy");
    expect(result.truncated).toBe(false);
  });

  it("still cuts a document that is genuinely nested past the depth bound", () => {
    // The counterweight to the three above: teaching the scan about optional
    // end tags must not teach it to ignore real nesting. These `<div>`s are
    // closed properly and go far past the bound.
    const result = extractReadableMarkdown(nested(200), "https://docs.example.com/deep", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 16,
    });

    expect(result.text).not.toContain("the buried paragraph");
    expect(result.truncated).toBe(true);
  });

  it("does not let a stray end tag pop its way out of the document", () => {
    // `</div>` with no `<div>` open is markup a browser discards. A scan that
    // let it decrement anyway could be walked back to zero by a page that
    // simply emitted end tags it never opened, and would then never notice the
    // nesting that followed.
    const strays = "</div></section></main>".repeat(200);
    const markup = `<!doctype html><html><head><title>Stray</title></head><body>${strays}${"<div>".repeat(
      200,
    )}<p>the buried paragraph</p></body></html>`;

    const result = extractReadableMarkdown(markup, "https://docs.example.com/stray", {
      ...WEB_EXTRACT_LIMITS,
      maxDepth: 16,
    });

    expect(result.text).not.toContain("the buried paragraph");
    expect(result.truncated).toBe(true);
  });

  it("does not spend the element budget on diagrams it is going to discard", () => {
    // sqlite.org draws its syntax as inline SVG: `lang_select.html` carries
    // 7,668 `<path>` and 4,000 `<polygon>` elements, more than the whole budget,
    // in front of the prose. Every one of them is deleted by the sanitiser the
    // moment there is a tree, so counting them is spending the budget to
    // measure something and then throw it away.
    const diagram = `<svg viewBox="0 0 10 10">${'<path d="M0 0 L1 1"/><polygon points="0,0 1,1"/>'.repeat(
      3000,
    )}</svg>`;
    const withDiagram =
      `<!doctype html><html><head><title>SELECT</title></head><body><article><h1>SELECT</h1>` +
      `${diagram}<p>Run the migration before the deploy, and run it exactly once.</p>` +
      `</article></body></html>`;

    const result = extractReadableMarkdown(withDiagram, "https://sqlite.org/lang_select.html");

    expect(result.text).toContain("Run the migration before the deploy");
    expect(result.truncated).toBe(false);
  });

  it("steps over a nested diagram without resuming inside it", () => {
    // SVG may contain SVG, so stopping at the first `</svg>` would put the scan
    // back to work in the middle of a subtree that is still open.
    const nestedSvg = `<svg><svg>${'<path d="M0 0"/>'.repeat(2000)}</svg>${'<circle r="1"/>'.repeat(
      2000,
    )}</svg>`;
    const markup =
      `<!doctype html><html><head><title>Nested</title></head><body><article><h1>Nested</h1>` +
      `${nestedSvg}<p>Run the migration before the deploy, and run it exactly once.</p>` +
      `</article></body></html>`;

    const result = extractReadableMarkdown(markup, "https://example.com/nested");

    expect(result.text).toContain("Run the migration before the deploy");
  });

  it("reads a diagram that is never closed as running to the end of the document", () => {
    // An unclosed `<svg>` has no end to skip to. The parser will reach the same
    // conclusion — everything after it is inside it — so the scan stops there
    // rather than guessing at a boundary the markup never drew.
    const markup = `<!doctype html><html><head><title>Open</title></head><body><article><p>Run the migration before the deploy, and run it exactly once.</p><svg><path d="M0 0"/><p>swallowed by the diagram</p></article></body></html>`;

    const result = extractReadableMarkdown(markup, "https://example.com/open");

    expect(result.text).toContain("Run the migration before the deploy");
  });

  it("does not mistake an element whose name merely starts with svg for a diagram", () => {
    // `<svgfoo>` is a different element, and reading it as a nested `<svg>`
    // would leave the skip waiting for a close tag that never comes — taking
    // the rest of the page with it.
    const markup =
      `<!doctype html><html><head><title>Lookalike</title></head><body><article>` +
      `<svg><svgfoo></svgfoo><path d="M0 0"/></svg>` +
      `<p>Run the migration before the deploy, and run it exactly once.</p>` +
      `</article></body></html>`;

    const result = extractReadableMarkdown(markup, "https://example.com/lookalike");

    expect(result.text).toContain("Run the migration before the deploy");
  });

  it("still bounds a page built from very many separate diagrams", () => {
    // The skip counts each subtree as one element, so breadth is bounded
    // exactly as it was: ten thousand empty diagrams are ten thousand elements.
    const many = "<svg></svg>".repeat(10_000);
    const markup = `<!doctype html><html><head><title>Many</title></head><body>${many}<p>the last paragraph</p></body></html>`;

    const result = extractReadableMarkdown(markup, "https://example.com/many");

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
