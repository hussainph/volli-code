import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_REVEAL_STATE,
  isRevealing,
  nextRevealState,
  TitleReveal,
  titleWordKeys,
} from "./title-reveal";

describe("nextRevealState", () => {
  it("records the first text without revealing it — a boot is not a title landing", () => {
    const state = nextRevealState(INITIAL_REVEAL_STATE, "Fix the parser");
    expect(state).toEqual({ seen: "Fix the parser", revealing: null });
    expect(isRevealing(state, "Fix the parser")).toBe(false);
  });

  it("reveals a replacement of an already-visible label", () => {
    const first = nextRevealState(INITIAL_REVEAL_STATE, "Fix the parser");
    const second = nextRevealState(first, "Parser fix");
    expect(second).toEqual({ seen: "Parser fix", revealing: "Parser fix" });
    expect(isRevealing(second, "Parser fix")).toBe(true);
  });

  it("holds the reveal across re-renders that did not change the text", () => {
    const landed = nextRevealState(nextRevealState(INITIAL_REVEAL_STATE, "Chat"), "Parser fix");
    // The regression this file exists for: a tab strip re-renders constantly
    // while the chat streams. Every one of those must agree the reveal is on,
    // or React strips the animation class off nodes it is reusing.
    let state = landed;
    for (let i = 0; i < 5; i += 1) state = nextRevealState(state, "Parser fix");
    expect(state).toBe(landed);
    expect(isRevealing(state, "Parser fix")).toBe(true);
  });

  it("re-arms for a second landing — heuristic, then the model's title", () => {
    const heuristic = nextRevealState(nextRevealState(INITIAL_REVEAL_STATE, "Chat"), "Fix parser");
    const model = nextRevealState(heuristic, "Parser crash fix");
    expect(isRevealing(model, "Parser crash fix")).toBe(true);
    expect(isRevealing(model, "Fix parser")).toBe(false);
  });
});

describe("titleWordKeys", () => {
  it("keys by word content, disambiguating a repeated word", () => {
    expect(titleWordKeys(["Fix", "the", "fix"])).toEqual(["Fix:1", "the:1", "fix:1"]);
    expect(titleWordKeys(["Fix", "Fix", "the"])).toEqual(["Fix:1", "Fix:2", "the:1"]);
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
