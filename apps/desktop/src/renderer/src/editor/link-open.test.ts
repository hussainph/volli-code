import { describe, expect, it } from "vite-plus/test";

import { shouldOpenLink } from "./link-open";

describe("shouldOpenLink", () => {
  it("opens on a plain left-click", () => {
    expect(shouldOpenLink({ button: 0, ctrlKey: false })).toBe(true);
  });

  it("does not open on middle- or right-click", () => {
    expect(shouldOpenLink({ button: 1, ctrlKey: false })).toBe(false);
    expect(shouldOpenLink({ button: 2, ctrlKey: false })).toBe(false);
  });

  it("does not open on a ctrl-click (macOS context-menu chord)", () => {
    expect(shouldOpenLink({ button: 0, ctrlKey: true })).toBe(false);
  });
});
