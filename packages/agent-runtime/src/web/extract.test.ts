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
      { htmlChars: 300 },
    );

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).not.toContain("Run the migration before the deploy");
  });

  it("applies the production parse bound as a number, not a string of units", () => {
    expect(WEB_EXTRACT_LIMITS.htmlChars).toBe(2 * 1024 * 1024);
  });
});
