import { describe, expect, it } from "vite-plus/test";

import { errorMessage } from "./errors";

describe("errorMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("preserves the message of Error subclasses", () => {
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
