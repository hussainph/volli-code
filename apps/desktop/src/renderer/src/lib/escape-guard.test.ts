import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { isEscapeExempt } from "./escape-guard";

// The renderer test project runs under vitest's default `node` environment (no
// jsdom), so neither `Element` nor `.closest` exist globally. Provide a minimal
// stand-in that satisfies `instanceof Element` and the `.closest(selector)`
// contract the guard relies on — enough to exercise every branch of the pure
// selector match, and to prove the union actually contains each exempt token,
// without pulling in a full DOM.
class FakeElement {
  constructor(private readonly ownSelectors: readonly string[]) {}

  /** Matches when this element (its own selectors) carries one of the requested tokens. */
  closest(selector: string): FakeElement | null {
    const wanted = new Set(selector.split(",").map((token) => token.trim()));
    return this.ownSelectors.some((own) => wanted.has(own)) ? this : null;
  }
}

const asTarget = (element: FakeElement): EventTarget => element as unknown as EventTarget;

let originalElement: unknown;
beforeAll(() => {
  originalElement = (globalThis as { Element?: unknown }).Element;
  (globalThis as { Element?: unknown }).Element = FakeElement;
});
afterAll(() => {
  (globalThis as { Element?: unknown }).Element = originalElement;
});

describe("isEscapeExempt", () => {
  it("is not exempt for a null target", () => {
    expect(isEscapeExempt(null)).toBe(false);
  });

  it("is not exempt for a plain element in no owning control", () => {
    expect(isEscapeExempt(asTarget(new FakeElement(["div", "section"])))).toBe(false);
  });

  it.each([
    "input",
    "textarea",
    "[contenteditable]",
    "[role=menu]",
    "[role=dialog]",
    "[role=alertdialog]",
  ])("exempts a target inside %s (the selector is the union of both call sites)", (selector) => {
    expect(isEscapeExempt(asTarget(new FakeElement([selector])))).toBe(true);
  });
});

/**
 * Real `Element#closest` matches when ANY comma-separated compound in the
 * selector hits the element OR one of its ancestors, so naming an anchor here
 * models a caret sitting deep inside a Monaco editor — in the
 * `div.native-edit-context` input surface, which matches none of the generic
 * text-entry tokens above. This is the regression guard for the bug where
 * pressing Escape in a file tab closed the whole ticket detail.
 */
describe("isEscapeExempt over the Monaco anchors", () => {
  it("exempts a target inside Monaco's own editor root", () => {
    expect(isEscapeExempt(asTarget(new FakeElement([".monaco-editor"])))).toBe(true);
  });

  it("exempts a target inside our Monaco host, even without Monaco's own root", () => {
    expect(isEscapeExempt(asTarget(new FakeElement(["[data-monaco-status]"])))).toBe(true);
  });

  it("does not anchor on Monaco's input surface class", () => {
    // `.native-edit-context` is deliberately NOT an anchor: that class is the
    // thing that already changed once (`textarea.inputarea` before it), so
    // matching it would re-encode the assumption that broke. In the app it is
    // always nested inside both anchors above, which is what carries the
    // exemption.
    expect(isEscapeExempt(asTarget(new FakeElement([".native-edit-context"])))).toBe(false);
  });
});
