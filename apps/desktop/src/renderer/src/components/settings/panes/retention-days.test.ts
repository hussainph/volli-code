import { describe, expect, it } from "vite-plus/test";

import { parseRetentionDays } from "./retention-days";

describe("parseRetentionDays", () => {
  it.each(["2.5", "1e3", "0", "7.9", "", "-1", "+3", "Infinity", "9".repeat(400)])(
    "rejects %j",
    (text) => {
      expect(parseRetentionDays(text)).toBeNull();
    },
  );

  it.each([
    [" 14 ", 14],
    ["3", 3],
    ["003", 3],
  ])("parses %j as %i days", (text, days) => {
    expect(parseRetentionDays(text)).toBe(days);
  });
});
