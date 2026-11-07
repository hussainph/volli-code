import { describe, expect, it } from "vite-plus/test";
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
