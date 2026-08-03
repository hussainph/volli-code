import { describe, expect, it } from "vite-plus/test";

import { MAX_RUNTIME_PREFERENCE_MODELS } from "./runtime-catalog";

describe("MAX_RUNTIME_PREFERENCE_MODELS", () => {
  it("caps the curated model list at a size a picker can render", () => {
    expect(MAX_RUNTIME_PREFERENCE_MODELS).toBe(50);
  });
});
