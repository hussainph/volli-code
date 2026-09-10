import { describe, expect, it } from "vite-plus/test";

import { labelRowSplit } from "./label-overflow";

/**
 * Widths are given in px and chosen to make the arithmetic checkable by hand:
 * three 40px chips with an 8px gap occupy 40, 88, 136.
 */
const CHIP = 40;
const GAP = 8;
const OVERFLOW = 30;

describe("labelRowSplit", () => {
  it("shows every chip when the row has room for all of them", () => {
    expect(
      labelRowSplit({ widths: [CHIP, CHIP, CHIP], available: 200, gap: GAP, overflow: OVERFLOW }),
    ).toEqual({ visible: 3, hidden: 0 });
  });

  it("does not truncate a row that fits to exactly the last pixel", () => {
    // 40 + 8 + 40 + 8 + 40 = 136. Reserving for a `+n` that would stand for
    // nothing is the bug this case exists to catch.
    expect(
      labelRowSplit({ widths: [CHIP, CHIP, CHIP], available: 136, gap: GAP, overflow: OVERFLOW }),
    ).toEqual({ visible: 3, hidden: 0 });
  });

  it("drops the chip that no longer fits once the +n chip takes its place", () => {
    // One pixel short of the whole row. Two chips plus the overflow chip are
    // 40 + 8 + 40 + 8 + 30 = 126, which fits in 135.
    expect(
      labelRowSplit({ widths: [CHIP, CHIP, CHIP], available: 135, gap: GAP, overflow: OVERFLOW }),
    ).toEqual({ visible: 2, hidden: 1 });
  });

  it("keeps shrinking the visible run until the +n chip fits beside it", () => {
    // Two chips plus overflow (126) exceed 100; one plus overflow is 78.
    expect(
      labelRowSplit({ widths: [CHIP, CHIP, CHIP], available: 100, gap: GAP, overflow: OVERFLOW }),
    ).toEqual({ visible: 1, hidden: 2 });
  });

  it("shows the +n chip alone when not even the first label fits beside it", () => {
    // 40 + 8 + 30 = 78 does not fit in 50, so the count says what the row
    // cannot show rather than the row showing a clipped chip.
    expect(
      labelRowSplit({ widths: [CHIP, CHIP, CHIP], available: 50, gap: GAP, overflow: OVERFLOW }),
    ).toEqual({ visible: 0, hidden: 3 });
  });

  it("has nothing to split when the ticket wears no labels", () => {
    expect(labelRowSplit({ widths: [], available: 200, gap: GAP, overflow: OVERFLOW })).toEqual({
      visible: 0,
      hidden: 0,
    });
  });

  it("packs chips of differing widths by their own measured sizes", () => {
    // 20 + 8 + 90 = 118 > 110, so the wide second chip goes: 20 + 8 + 30 = 58.
    expect(
      labelRowSplit({ widths: [20, 90, 30], available: 110, gap: GAP, overflow: OVERFLOW }),
    ).toEqual({ visible: 1, hidden: 2 });
  });
});
