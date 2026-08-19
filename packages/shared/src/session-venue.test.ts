import { describe, expect, it } from "vite-plus/test";

import {
  VENUE_FILE_STATES,
  venueFileTotal,
  venueLooseCount,
  venueSegments,
  type VenueFileCounts,
} from "./session-venue";

function counts(over: Partial<VenueFileCounts> = {}): VenueFileCounts {
  return { committed: 0, modified: 0, added: 0, untracked: 0, ...over };
}

describe("venueFileTotal", () => {
  it("sums the four disjoint states", () => {
    expect(venueFileTotal(counts({ committed: 4, modified: 2, added: 1, untracked: 3 }))).toBe(10);
  });

  it("is zero for a clean venue", () => {
    expect(venueFileTotal(counts())).toBe(0);
  });
});

describe("venueLooseCount", () => {
  it("counts only what is dirty right now", () => {
    expect(venueLooseCount(counts({ committed: 7, modified: 2, added: 1, untracked: 3 }))).toBe(6);
  });
});

describe("venueSegments", () => {
  it("draws committed first, then the loose states in order", () => {
    expect(venueSegments(counts({ committed: 4, modified: 2, added: 1, untracked: 3 }))).toEqual([
      { state: "committed", count: 4 },
      { state: "modified", count: 2 },
      { state: "added", count: 1 },
      { state: "untracked", count: 3 },
    ]);
  });

  it("omits empty states so a one-state venue is a solid bar", () => {
    expect(venueSegments(counts({ untracked: 2 }))).toEqual([{ state: "untracked", count: 2 }]);
  });

  it("draws nothing for a clean venue", () => {
    expect(venueSegments(counts())).toEqual([]);
  });

  it("sums to the stated total — the claim a segmented bar makes", () => {
    const files = counts({ committed: 9, modified: 4, added: 2, untracked: 6 });
    const drawn = venueSegments(files).reduce((sum, segment) => sum + segment.count, 0);
    expect(drawn).toBe(venueFileTotal(files));
  });

  it("covers every state the vocabulary declares", () => {
    const files = counts({ committed: 1, modified: 1, added: 1, untracked: 1 });
    expect(venueSegments(files).map((segment) => segment.state)).toEqual(VENUE_FILE_STATES);
  });
});
