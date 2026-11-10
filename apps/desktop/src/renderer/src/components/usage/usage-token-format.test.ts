import { describe, expect, it } from "vite-plus/test";
import { formatUsageTokens, tokenCountLabel } from "./usage-token-format";

describe("usage token notation", () => {
  it.each([
    [0, "0"],
    [417, "417"],
    [1234, "1.2K"],
    [9000, "9K"],
    [41_200, "41K"],
    [412_000, "412K"],
    [1_200_000, "1.2M"],
    [999, "999"],
    [999_500, "1M"],
    [999_500_000, "1B"],
    [3_200_000_000, "3.2B"],
    [3_200_000_000_000, "3.2T"],
    [42_400_000_000_000, "42T"],
    [-5, "0"],
    [NaN, "0"],
    [Infinity, "0"],
  ])("formats %s as %s", (count, expected) => expect(formatUsageTokens(count)).toBe(expected));
  it("keeps exact grouped values for titles and accessible readings", () => {
    expect(tokenCountLabel(3_200_000_000_000)).toBe("3,200,000,000,000 tokens");
    expect(tokenCountLabel(0)).toBe("0 tokens");
    expect(tokenCountLabel(NaN)).toBe("0 tokens");
    expect(tokenCountLabel(-1)).toBe("0 tokens");
  });
});
