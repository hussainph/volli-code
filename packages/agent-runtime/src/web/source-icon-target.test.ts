import { describe, expect, it, vi } from "vite-plus/test";
import { JSDOM } from "jsdom";
import { sameOriginIconUrl } from "./source-icon-target";
import { extractReadableMarkdown } from "./extract";

const PAGE = "https://docs.example.com/guide/start?private=query";
describe("explicit source icon metadata", () => {
  it("reads one explicit icon from the already parsed head, ignoring HTML base", () => {
    const html =
      '<html><head><base href="https://evil.example/"><link rel="icon" href="https://other.example/logo"><link rel="shortcut ICON" href="../logo"></head><body><p>Readable article.</p></body></html>';
    const plain = extractReadableMarkdown("<body><p>Readable article.</p></body>", PAGE);
    const result = extractReadableMarkdown(html, PAGE);
    expect(result.text).toBe(plain.text);
    expect(result.sourceIconUrl).toBe("https://docs.example.com/logo");
    expect(result.text).not.toContain("logo");
  });
  it("does not guess a favicon endpoint or accept body/manifest/image branding", () => {
    for (const html of [
      '<body><p>Text</p><img src="/logo"></body>',
      '<head><link rel="manifest" href="/manifest"></head><body>Text</body>',
      "<body>Text</body>",
    ]) {
      expect(extractReadableMarkdown(html, PAGE).sourceIconUrl).toBeUndefined();
    }
  });
  it.each([
    "",
    "//other.example/icon",
    "http://docs.example.com/icon",
    "https://docs.example.com:444/icon",
    "/icon?token=private",
    "/icon?",
    "/icon#x",
    "/icon#",
    "https://user:secret@docs.example.com/icon",
    "data:image/png,abc",
    "file:///tmp/icon",
    "\\\\docs.example.com\\icon",
    "/i\tcon",
  ])("rejects an ambiguous or unauthorized target (%#)", (href) => {
    expect(sameOriginIconUrl(href, PAGE)).toBeNull();
  });
  it("bounds head metadata scanning", () => {
    const head = '<link rel="other" href="/other">'.repeat(32) + '<link rel="icon" href="/late">';
    expect(
      extractReadableMarkdown(`<head>${head}</head><body>Text</body>`, PAGE).sourceIconUrl,
    ).toBeUndefined();
  });
});

it("refuses malformed final-page URLs and policy-forbidden same-origin links", () => {
  expect(sameOriginIconUrl("/icon", "not a URL")).toBeNull();
  expect(sameOriginIconUrl("/icon", "http://127.0.0.1/page")).toBeNull();
});

it.each(["rel", "href"])(
  "handles a DOM adapter losing %s after selecting link attributes",
  (missing) => {
    // querySelectorAll requires both attributes. Inject the defensive DOM-boundary
    // fault explicitly rather than weakening that selector or deleting its guard.
    const windowGetter = Object.getOwnPropertyDescriptor(JSDOM.prototype, "window")!.get!;
    const patched = new WeakSet<object>();
    vi.spyOn(JSDOM.prototype, "window", "get").mockImplementation(function (this: JSDOM) {
      const window: JSDOM["window"] = windowGetter.call(this);
      if (!patched.has(window)) {
        patched.add(window);
        const original = window.Element.prototype.getAttribute;
        vi.spyOn(window.Element.prototype, "getAttribute").mockImplementation(function (
          this: Element,
          name: string,
        ) {
          return this.tagName === "LINK" && name === missing ? null : original.call(this, name);
        });
      }
      return window;
    });
    try {
      const result = extractReadableMarkdown(
        '<head><link rel="icon" href="/icon"></head><body>Readable text.</body>',
        PAGE,
      );
      expect(result.sourceIconUrl).toBeUndefined();
      expect(result.text).toContain("Readable text.");
    } finally {
      vi.restoreAllMocks();
    }
  },
);
