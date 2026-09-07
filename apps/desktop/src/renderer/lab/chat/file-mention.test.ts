import { describe, expect, it } from "vite-plus/test";

import { looksLikeFilePath } from "@renderer/components/ui/ai-elements/chat-markdown";

describe("looksLikeFilePath", () => {
  it("accepts common project paths and rejects urls / prose", () => {
    expect(looksLikeFilePath("src/greeting.ts")).toBe(true);
    expect(looksLikeFilePath("apps/desktop/package.json")).toBe(true);
    expect(looksLikeFilePath("README.md")).toBe(true);
    expect(looksLikeFilePath("https://example.com/a.ts")).toBe(false);
    expect(looksLikeFilePath("hello world")).toBe(false);
    expect(looksLikeFilePath("npm")).toBe(false);
  });

  /*
   * A false positive is not cosmetic: it puts a dotted underline and a dead
   * click target on a word in the middle of a sentence, which is the "weird
   * syntax highlighting" VC-273 names. The old `\.[A-Za-z0-9]{1,12}$` rule
   * matched all of these.
   */
  it("leaves numbers, versions and abbreviations as ordinary code", () => {
    expect(looksLikeFilePath("3.14")).toBe(false);
    expect(looksLikeFilePath("1.2.3")).toBe(false);
    expect(looksLikeFilePath("e.g")).toBe(false);
    expect(looksLikeFilePath("U.S")).toBe(false);
    expect(looksLikeFilePath("foo.bar")).toBe(false);
    expect(looksLikeFilePath("self.value")).toBe(false);
  });

  it("still accepts slash-less names with a real file extension", () => {
    expect(looksLikeFilePath("vite.config.ts")).toBe(true);
    expect(looksLikeFilePath("globals.css")).toBe(true);
    expect(looksLikeFilePath("pnpm-lock.yaml")).toBe(true);
  });

  /*
   * The picture formats a person actually attaches, all of them. The list
   * shipped with `png` and `svg` but not `jpg`, so `shot.png` underlined as a
   * file mention and `shot.jpg` beside it did not — on a ticket whose whole
   * subject is images.
   */
  it.each(["shot.png", "shot.jpg", "shot.jpeg", "shot.gif", "shot.webp", "shot.svg"])(
    "accepts every image format a screenshot arrives as: %s",
    (name: string) => {
      expect(looksLikeFilePath(name)).toBe(true);
    },
  );

  it("treats anything with a separator as a path, absolute excepted", () => {
    expect(looksLikeFilePath("packages/shared/src")).toBe(true);
    expect(looksLikeFilePath("./local")).toBe(true);
    // An absolute path is not a project-relative mention this app can open.
    expect(looksLikeFilePath("/etc/passwd")).toBe(false);
  });

  it("rejects a bare or trailing dot", () => {
    expect(looksLikeFilePath(".")).toBe(false);
    expect(looksLikeFilePath("trailing.")).toBe(false);
    expect(looksLikeFilePath(".env")).toBe(false); // leading dot, no stem
  });
});
