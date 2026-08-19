import { describe, expect, it } from "vite-plus/test";

import { AUTO_TITLE_SYSTEM_PROMPT, AUTO_TITLE_MAX_WORDS, sanitizeAutoTitle } from "./auto-title";

describe("AUTO_TITLE_SYSTEM_PROMPT", () => {
  it("demands the six-word ceiling and forbids everything but the title", () => {
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("six words");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("only");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("no quotes");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("no punctuation");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("no explanation");
  });
});

describe("sanitizeAutoTitle", () => {
  it("keeps a clean short title", () => {
    expect(sanitizeAutoTitle("Fix the login flow")).toBe("Fix the login flow");
  });

  it("collapses whitespace and reads only the first line", () => {
    expect(sanitizeAutoTitle("  Fix   the\tlogin flow\nSome explanation below.")).toBe(
      "Fix the login flow",
    );
  });

  it("strips surrounding quotes", () => {
    expect(sanitizeAutoTitle('"Fix the login flow"')).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("'Fix the login flow'")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("`Fix the login flow`")).toBe("Fix the login flow");
  });

  it("strips a trailing period and other trailing punctuation", () => {
    expect(sanitizeAutoTitle("Fix the login flow.")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Fix the login flow!")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Fix the login flow,")).toBe("Fix the login flow");
  });

  it("strips a `Title:` prefix the model answered with anyway", () => {
    expect(sanitizeAutoTitle("Title: Fix the login flow")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Title - Fix the login flow")).toBe("Fix the login flow");
  });

  it("keeps a legitimate title that begins with the word Title", () => {
    expect(sanitizeAutoTitle("Title Case conventions")).toBe("Title Case conventions");
  });

  it(`cuts answers longer than ${AUTO_TITLE_MAX_WORDS} words down to that many`, () => {
    expect(sanitizeAutoTitle("The quick brown fox jumps over the lazy dog")).toBe(
      "The quick brown fox jumps over",
    );
  });

  it("caps length at the session-title budget on a word boundary", () => {
    expect(
      sanitizeAutoTitle(
        "Internationalization infrastructure investigation compatibility documentation rationalization",
      ),
    ).toBe("Internationalization infrastructure…");
  });

  it("returns null when nothing survives", () => {
    expect(sanitizeAutoTitle("")).toBeNull();
    expect(sanitizeAutoTitle("   \n\t ")).toBeNull();
    expect(sanitizeAutoTitle(".")).toBeNull();
    expect(sanitizeAutoTitle('""')).toBeNull();
    expect(sanitizeAutoTitle("Title:")).toBeNull();
  });
});
