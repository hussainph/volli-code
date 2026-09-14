import { describe, expect, it } from "vitest";

import { parseArgs, summarize } from "./run.mjs";

describe("performance benchmark statistics", () => {
  it("reports nearest-rank tails and population variance", () => {
    expect(summarize(Array.from({ length: 20 }, (_value, index) => index + 1))).toEqual({
      n: 20,
      min: 1,
      p50: 10,
      p95: 19,
      max: 20,
      mean: 10.5,
      variance: 33.25,
    });
  });

  it("ignores unavailable measurements and refuses an empty summary", () => {
    expect(summarize([null, Number.NaN, 4, 8])).toMatchObject({ n: 2, p50: 4, p95: 8 });
    expect(summarize([null, Number.NaN])).toBeNull();
  });
});

describe("interaction selection", () => {
  it("measures everything when nothing is named", () => {
    expect(parseArgs([]).interactions).toBeUndefined();
  });

  it("takes a comma-separated subset, so a narrow change need not fork this harness", () => {
    // VC-358 only moves "+ Chat to usable composer". It ran as a copy of this
    // file with the list edited down, which is how ~1,000 duplicated lines
    // nearly landed. One flag is the whole difference.
    expect(parseArgs(["--interactions", "new_chat"]).interactions).toEqual(["new_chat"]);
    expect(parseArgs(["--interactions", "new_chat,cold_launch"]).interactions).toEqual([
      "new_chat",
      "cold_launch",
    ]);
  });

  it("refuses an interaction it cannot measure rather than reporting an empty arm", () => {
    expect(() => parseArgs(["--interactions", "new_chat,typo"])).toThrow(/typo/);
  });
});
