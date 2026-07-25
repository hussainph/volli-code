import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, generateThemeTokens } from "@volli/shared";

import { windowBackgroundColor } from "./window-theme";

describe("windowBackgroundColor", () => {
  it("is exactly the generated --background, so the window edge cannot drift from the app", () => {
    expect(windowBackgroundColor(DEFAULT_THEME)).toBe(
      generateThemeTokens(DEFAULT_THEME)["--background"],
    );
  });

  it("follows the authored theme", () => {
    const midnight = { ...DEFAULT_THEME, slug: "midnight", seed: "#4c6ef5" };

    expect(windowBackgroundColor(midnight)).toBe(generateThemeTokens(midnight)["--background"]);
    expect(windowBackgroundColor(midnight)).not.toBe(windowBackgroundColor(DEFAULT_THEME));
  });

  it("falls back to the shipped default when nothing is stored", () => {
    // A window is created before any UI exists to surface a read failure in —
    // an absent or unreadable theme must still paint.
    expect(windowBackgroundColor(null)).toBe(windowBackgroundColor(DEFAULT_THEME));
  });
});
