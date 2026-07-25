import { describe, expect, it } from "vite-plus/test";

import { GRAIN_MAX_OPACITY, grainOpacity } from "./grain";

describe("grainOpacity", () => {
  it("clamps a hand-edited grain into the usable window", () => {
    // The storage guard (`isThemeDefinition`) only asserts a finite number, so
    // a theme file edited by hand can legitimately arrive carrying 12 — which
    // unclamped is a 25% noise sheet over the whole app.
    expect(grainOpacity(12)).toBe(GRAIN_MAX_OPACITY);
    expect(grainOpacity(1)).toBe(GRAIN_MAX_OPACITY);
    expect(grainOpacity(-3)).toBe(0);
  });
});
