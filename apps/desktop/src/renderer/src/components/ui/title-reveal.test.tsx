import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { shouldRevealTitle, TitleReveal, titleWordKeys, titleWords } from "./title-reveal";

describe("titleWords", () => {
  it("splits on single spaces, collapsing none", () => {
    expect(titleWords("Fix the parser")).toEqual(["Fix", "the", "parser"]);
    expect(titleWords("Solo")).toEqual(["Solo"]);
  });
});

describe("titleWordKeys", () => {
  it("keys by word content, disambiguating a repeated word", () => {
    expect(titleWordKeys(["Fix", "the", "fix"])).toEqual(["Fix:1", "the:1", "fix:1"]);
    expect(titleWordKeys(["Fix", "Fix", "the"])).toEqual(["Fix:1", "Fix:2", "the:1"]);
  });
});

describe("shouldRevealTitle", () => {
  it("stays still on first paint — a boot is not a title landing", () => {
    expect(shouldRevealTitle(null, "Fix the parser")).toBe(false);
  });

  it("reveals only when the title actually changed", () => {
    expect(shouldRevealTitle("Fix the parser", "Fix the parser")).toBe(false);
    expect(shouldRevealTitle("Fix the parser", "Parser fix")).toBe(true);
  });
});

describe("TitleReveal", () => {
  it("renders the words plainly on first mount, with no animation", () => {
    const html = renderToStaticMarkup(<TitleReveal text="Fix the parser" />);
    expect(html).toContain("Fix");
    expect(html).toContain("parser");
    expect(html).not.toContain("title-reveal-word");
  });

  it("keeps the whole label one accessible string", () => {
    const html = renderToStaticMarkup(<TitleReveal text="Fix the parser" />);
    // Word spans are spliced back together with spaces, so a screen reader or
    // a copy hears the label, not three fragments.
    expect(html.replace(/<[^>]+>/g, "")).toBe("Fix the parser");
  });
});
