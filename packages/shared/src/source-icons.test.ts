import { describe, expect, it } from "vite-plus/test";
import { isCanonicalSourceOrigin, SOURCE_ICON_ORIGIN_LIMIT } from "./source-icons";

describe("source icon subscription origins", () => {
  it("bounds the receiving set at 32", () => expect(SOURCE_ICON_ORIGIN_LIMIT).toBe(32));
  it.each([
    "https://example.com",
    "http://example.com",
    "https://project.github.io",
    "https://[::1]",
  ])("accepts a canonical origin, not a network grant: %s", (origin) => {
    expect(isCanonicalSourceOrigin(origin)).toBe(true);
  });
  it.each([
    "",
    "not a URL",
    "file:///example.com",
    "https://example.com/",
    "https://example.com/page",
    "https://user:secret@example.com",
    "https://example.com?secret",
    "https://example.com#fragment",
    "https://EXAMPLE.com",
    "https://example.com:443",
    `https://${"a".repeat(2048)}.com`,
  ])("rejects noncanonical input (%#)", (origin) => {
    expect(isCanonicalSourceOrigin(origin)).toBe(false);
  });
});
