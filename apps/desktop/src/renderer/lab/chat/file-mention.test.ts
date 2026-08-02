import { describe, expect, it } from "vite-plus/test";

import { looksLikeFilePath } from "../../../components/ai-elements/chat-markdown";

describe("looksLikeFilePath", () => {
  it("accepts common project paths and rejects urls / prose", () => {
    expect(looksLikeFilePath("src/greeting.ts")).toBe(true);
    expect(looksLikeFilePath("apps/desktop/package.json")).toBe(true);
    expect(looksLikeFilePath("README.md")).toBe(true);
    expect(looksLikeFilePath("https://example.com/a.ts")).toBe(false);
    expect(looksLikeFilePath("hello world")).toBe(false);
    expect(looksLikeFilePath("npm")).toBe(false);
  });
});
