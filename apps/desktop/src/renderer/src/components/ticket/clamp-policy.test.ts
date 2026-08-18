import { describe, expect, it } from "vite-plus/test";

import { BODY_CLAMP_PX, CLAMP_TOLERANCE_PX, COMMENT_CLAMP_PX, planClamp } from "./clamp-policy";

describe("planClamp", () => {
  it("treats an unmeasured surface (null) as fitting: no clamp, no affordance", () => {
    expect(planClamp(null, COMMENT_CLAMP_PX, false)).toEqual({
      overflowing: false,
      clamped: false,
    });
    expect(planClamp(null, BODY_CLAMP_PX, true)).toEqual({
      overflowing: false,
      clamped: false,
    });
  });

  it("does not clamp content at or under the cap", () => {
    expect(planClamp(COMMENT_CLAMP_PX, COMMENT_CLAMP_PX, false).clamped).toBe(false);
    expect(planClamp(0, BODY_CLAMP_PX, false).clamped).toBe(false);
  });

  it("tolerates sub-pixel overshoot: a miss within the tolerance reads as fitting", () => {
    const justWithin = COMMENT_CLAMP_PX + CLAMP_TOLERANCE_PX - 0.5;
    const justOver = COMMENT_CLAMP_PX + CLAMP_TOLERANCE_PX + 0.5;
    expect(planClamp(justWithin, COMMENT_CLAMP_PX, false).overflowing).toBe(false);
    expect(planClamp(justOver, COMMENT_CLAMP_PX, false).overflowing).toBe(true);
  });

  it("clamps overflowing content while collapsed, but keeps the affordance when expanded", () => {
    const collapsed = planClamp(COMMENT_CLAMP_PX + 200, COMMENT_CLAMP_PX, false);
    expect(collapsed).toEqual({ overflowing: true, clamped: true });

    const expanded = planClamp(COMMENT_CLAMP_PX + 200, COMMENT_CLAMP_PX, true);
    expect(expanded).toEqual({ overflowing: true, clamped: false });
  });

  it("shares one cap constant per surface kind", () => {
    // The two surfaces clamp at different caps; pin both so a change to either
    // is a deliberate one that updates the fade/toggle expectations with it.
    expect(COMMENT_CLAMP_PX).toBe(288);
    expect(BODY_CLAMP_PX).toBe(384);
  });
});
