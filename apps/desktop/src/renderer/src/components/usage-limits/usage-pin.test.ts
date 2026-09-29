import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PINNED_WINDOWS,
  isUsageWindowPinned,
  sanitizeUsagePin,
  toggleUsagePin,
} from "./usage-pin";

describe("toggleUsagePin", () => {
  it("pins a window when nothing is pinned", () => {
    expect(toggleUsagePin(null, "anthropic", "five_hour")).toEqual({
      providerId: "anthropic",
      windowIds: ["five_hour"],
    });
  });

  it("adds a second window of the same account, one per bar", () => {
    const one = toggleUsagePin(null, "anthropic", "five_hour");
    expect(toggleUsagePin(one, "anthropic", "seven_day")).toEqual({
      providerId: "anthropic",
      windowIds: ["five_hour", "seven_day"],
    });
  });

  it("lets go of the oldest when a third window of the account is pinned", () => {
    const two = { providerId: "opencode-go", windowIds: ["session", "weekly"] };
    const three = toggleUsagePin(two, "opencode-go", "monthly");
    expect(three).toEqual({ providerId: "opencode-go", windowIds: ["weekly", "monthly"] });
    expect(three?.windowIds).toHaveLength(MAX_PINNED_WINDOWS);
  });

  it("moves the pin to another account rather than mixing two under one mark", () => {
    const two = { providerId: "anthropic", windowIds: ["five_hour", "seven_day"] };
    expect(toggleUsagePin(two, "github-copilot", "premium")).toEqual({
      providerId: "github-copilot",
      windowIds: ["premium"],
    });
  });

  it("unpins a pinned window, and clears the pin with its last one", () => {
    const two = { providerId: "anthropic", windowIds: ["five_hour", "seven_day"] };
    const one = toggleUsagePin(two, "anthropic", "five_hour");
    expect(one).toEqual({ providerId: "anthropic", windowIds: ["seven_day"] });
    expect(toggleUsagePin(one, "anthropic", "seven_day")).toBeNull();
  });
});

describe("isUsageWindowPinned", () => {
  const pin = { providerId: "anthropic", windowIds: ["five_hour"] };

  it("is true only for the account and window the pin names", () => {
    expect(isUsageWindowPinned(pin, "anthropic", "five_hour")).toBe(true);
    expect(isUsageWindowPinned(pin, "anthropic", "seven_day")).toBe(false);
    // Window ids are only unique within an account.
    expect(isUsageWindowPinned(pin, "openai-codex", "five_hour")).toBe(false);
    expect(isUsageWindowPinned(null, "anthropic", "five_hour")).toBe(false);
  });
});

describe("sanitizeUsagePin", () => {
  it("keeps a well-formed pin", () => {
    const pin = { providerId: "anthropic", windowIds: ["five_hour", "seven_day"] };
    expect(sanitizeUsagePin(pin)).toEqual(pin);
  });

  it("is no pin for anything that is not one", () => {
    for (const value of [
      undefined,
      null,
      "anthropic",
      {},
      { providerId: "", windowIds: ["five_hour"] },
      { providerId: 7, windowIds: ["five_hour"] },
      { providerId: "anthropic" },
      { providerId: "anthropic", windowIds: "five_hour" },
      { providerId: "anthropic", windowIds: [] },
      { providerId: "anthropic", windowIds: ["", 3, null] },
    ]) {
      expect(sanitizeUsagePin(value)).toBeNull();
    }
  });

  it("drops junk and duplicates, and keeps only the newest two", () => {
    expect(
      sanitizeUsagePin({
        providerId: "opencode-go",
        windowIds: ["session", 4, "session", "weekly", "", "monthly"],
      }),
    ).toEqual({ providerId: "opencode-go", windowIds: ["weekly", "monthly"] });
  });
});
