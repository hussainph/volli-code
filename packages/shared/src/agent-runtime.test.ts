import { describe, expect, it } from "vite-plus/test";

import { REASONING_LEVELS } from "./agent-runtime";

describe("REASONING_LEVELS", () => {
  it("keeps the product reasoning policy ordered from disabled through maximum", () => {
    expect(REASONING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
