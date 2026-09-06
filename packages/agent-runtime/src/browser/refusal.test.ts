import { describe, expect, it } from "vite-plus/test";

import { BrowserRefusal, type BrowserRefusalPage } from "./refusal";

const PAGE: BrowserRefusalPage = {
  tabId: "tab-1",
  url: "https://example.com/sign-in",
  title: "Sign in",
  ownerSessionId: "s1",
  error: null,
};

describe("BrowserRefusal", () => {
  it("names the rule that produced it, and knows no page until a port tells it one", () => {
    const refusal = new BrowserRefusal("browser.stale-ref", "Take a fresh snapshot.");

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe("BrowserRefusal");
    expect(refusal.rule).toBe("browser.stale-ref");
    expect(refusal.page).toBeNull();
  });

  it("takes the page it was aimed at, keeping the rule and the words (VC-238 §3)", () => {
    const raised = new BrowserRefusal("browser.stale-ref", "Take a fresh snapshot.");

    const told = raised.onPage(PAGE);

    expect(told).not.toBe(raised);
    expect(told.rule).toBe("browser.stale-ref");
    expect(told.message).toBe("Take a fresh snapshot.");
    expect(told.page).toEqual(PAGE);
    // The original is untouched: a refusal in flight is not rewritten in place.
    expect(raised.page).toBeNull();
  });

  it("keeps the page it already names, because the innermost port knew the tab best", () => {
    const inner = new BrowserRefusal("browser.stale-ref", "Take a fresh snapshot.", PAGE);

    const outer = inner.onPage({ ...PAGE, url: "https://example.com/somewhere-later" });

    expect(outer).toBe(inner);
    expect(outer.page?.url).toBe("https://example.com/sign-in");
  });
});
