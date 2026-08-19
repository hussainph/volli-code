import { describe, expect, it } from "vite-plus/test";

import {
  COMPACTION_RESERVE_CHOICES,
  DEFAULT_COMPACTION_POLICY,
  compactionReserveChoices,
  isUsableCompactionReserve,
  modelCompactionReserve,
  withModelCompactionReserve,
  type ModelCompactionLimit,
} from "./compaction-policy";

const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-4-5" };
const HAIKU = { providerId: "anthropic", modelId: "claude-haiku-4-5" };
/** Same model id, different provider — the pair is the identity, not the id. */
const RESOLD_SONNET = { providerId: "openrouter", modelId: "claude-sonnet-4-5" };

const LIMITED: readonly ModelCompactionLimit[] = [{ ...SONNET, reserveTokens: 32_768 }];

describe("the configured policy", () => {
  it("compacts automatically and limits nothing until told otherwise", () => {
    expect(DEFAULT_COMPACTION_POLICY).toEqual({ autoCompaction: true, modelLimits: [] });
  });
});

describe("a usable reserve", () => {
  it("refuses a reserve the window cannot hold", () => {
    // At the window the threshold is `used > 0`, which compacts after every
    // reply; above it, worse. Both are refusals, not clamps.
    expect(isUsableCompactionReserve(200_000, 200_000)).toBe(false);
    expect(isUsableCompactionReserve(200_001, 200_000)).toBe(false);
    expect(isUsableCompactionReserve(199_999, 200_000)).toBe(true);
  });

  it("refuses anything that is not a whole positive count of tokens", () => {
    expect(isUsableCompactionReserve(0, 200_000)).toBe(false);
    expect(isUsableCompactionReserve(-16_384, 200_000)).toBe(false);
    expect(isUsableCompactionReserve(16_384.5, 200_000)).toBe(false);
    expect(isUsableCompactionReserve(Number.NaN, 200_000)).toBe(false);
    expect(isUsableCompactionReserve(Number.POSITIVE_INFINITY, 200_000)).toBe(false);
  });
});

describe("one model's reserve", () => {
  it("answers nothing for a model the profile has not limited", () => {
    expect(modelCompactionReserve(LIMITED, SONNET)).toBe(32_768);
    expect(modelCompactionReserve(LIMITED, HAIKU)).toBeUndefined();
    expect(modelCompactionReserve([], SONNET)).toBeUndefined();
  });

  it("tells the same model id apart across providers", () => {
    expect(modelCompactionReserve(LIMITED, RESOLD_SONNET)).toBeUndefined();
  });
});

describe("setting one model's reserve", () => {
  it("replaces rather than appends, so a model is never listed twice", () => {
    const once = withModelCompactionReserve(LIMITED, SONNET, 65_536);
    expect(once).toEqual([{ ...SONNET, reserveTokens: 65_536 }]);
    expect(withModelCompactionReserve(once, HAIKU, 8_192)).toEqual([
      { ...SONNET, reserveTokens: 65_536 },
      { ...HAIKU, reserveTokens: 8_192 },
    ]);
  });

  it("clears an explicit reserve back to the executor's own", () => {
    expect(withModelCompactionReserve(LIMITED, SONNET, null)).toEqual([]);
  });

  it("leaves the other models alone when clearing one that was never set", () => {
    expect(withModelCompactionReserve(LIMITED, HAIKU, null)).toEqual(LIMITED);
  });
});

describe("what a reserve picker may offer", () => {
  it("offers only the ladder steps this window can hold", () => {
    expect(compactionReserveChoices(200_000, undefined)).toEqual([...COMPACTION_RESERVE_CHOICES]);
    expect(compactionReserveChoices(32_768, undefined)).toEqual([8_192, 16_384]);
  });

  it("offers nothing for a model with no known window", () => {
    expect(compactionReserveChoices(undefined, 16_384)).toEqual([]);
  });

  it("offers nothing when even the smallest step would not fit", () => {
    expect(compactionReserveChoices(4_096, undefined)).toEqual([]);
  });

  it("lists a configured reserve that is not on the ladder, in its place", () => {
    expect(compactionReserveChoices(200_000, 20_000)).toEqual([
      8_192, 16_384, 20_000, 32_768, 65_536, 131_072,
    ]);
  });

  it("never lists the same reserve twice when the configured one is a ladder step", () => {
    expect(compactionReserveChoices(200_000, 16_384)).toEqual([...COMPACTION_RESERVE_CHOICES]);
  });

  it("withholds a configured reserve this window cannot hold", () => {
    // The stale row a shrunken catalog window leaves behind: the picker shows
    // what the Session will actually run under, not what is stored.
    expect(compactionReserveChoices(32_768, 65_536)).toEqual([8_192, 16_384]);
  });
});
