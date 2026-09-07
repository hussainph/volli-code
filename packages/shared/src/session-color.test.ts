import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_COLOR_COUNT,
  SESSION_COLORS,
  pickSessionColor,
  sessionColor,
  sessionColorInk,
  sessionColorSlot,
} from "./session-color";
import { apcaLc, hexToOklch } from "./theme/color";

describe("SESSION_COLORS", () => {
  it("has one hue per slot, all distinct", () => {
    expect(SESSION_COLORS).toHaveLength(SESSION_COLOR_COUNT);
    expect(new Set(SESSION_COLORS).size).toBe(SESSION_COLOR_COUNT);
  });

  it("is one family: every member at one lightness", () => {
    // Lightness, not chroma: the fan asks for the anchor's chroma at every
    // hue, but sRGB cannot hold ember's chroma at teal or olive at this
    // lightness, so those two are gamut-mapped down. Equal weight is what
    // keeps eight cursors from ranking themselves, and weight is lightness.
    const [first, ...rest] = SESSION_COLORS.map((hex) => hexToOklch(hex));
    for (const member of rest) {
      expect(member.L).toBeCloseTo(first!.L, 2);
    }
  });

  it("never lands on the ember accent itself", () => {
    expect(SESSION_COLORS.map((hex) => hex.toLowerCase())).not.toContain("#e8652a");
  });
});

describe("sessionColor", () => {
  it("is deterministic for one id", () => {
    expect(sessionColor("ses-alpha")).toBe(sessionColor("ses-alpha"));
  });

  it("is the hue at the id's hashed slot", () => {
    const id = "ses-4d1f";
    expect(sessionColor(id)).toBe(SESSION_COLORS[sessionColorSlot(id)]);
    expect(sessionColorSlot(id)).toBeGreaterThanOrEqual(0);
    expect(sessionColorSlot(id)).toBeLessThan(SESSION_COLOR_COUNT);
  });

  it("survives an empty or non-ASCII id", () => {
    expect(SESSION_COLORS).toContain(sessionColor(""));
    expect(SESSION_COLORS).toContain(sessionColor("セッション"));
  });
});

describe("sessionColorInk", () => {
  it("picks the more legible of black and white for every palette member", () => {
    for (const hex of SESSION_COLORS) {
      const ink = sessionColorInk(hex);
      const other = ink === "#000000" ? "#ffffff" : "#000000";
      expect(apcaLc(ink, hex)).toBeGreaterThanOrEqual(apcaLc(other, hex));
    }
  });

  it("answers black on white and white on black", () => {
    expect(sessionColorInk("#ffffff")).toBe("#000000");
    expect(sessionColorInk("#000000")).toBe("#ffffff");
  });
});

/** Two ids that hash to the same slot, found by search so the test says what it means. */
function collidingPair(): [string, string] {
  const seen = new Map<number, string>();
  for (let n = 0; ; n += 1) {
    const id = `ses-${n}`;
    const slot = sessionColorSlot(id);
    const earlier = seen.get(slot);
    if (earlier !== undefined) return [earlier, id];
    seen.set(slot, id);
  }
}

/** The host's fold: each Session against the colours handed out before it. */
const arriving = (ids: readonly string[]): Map<string, string> =>
  ids.reduce((taken, id) => {
    taken.set(id, pickSessionColor(id, taken.values()));
    return taken;
  }, new Map<string, string>());

describe("pickSessionColor", () => {
  it("is the hashed colour when nothing is taken", () => {
    expect(pickSessionColor("ses-alpha", [])).toBe(sessionColor("ses-alpha"));
  });

  it("steps to the next free slot round the wheel when its own is taken", () => {
    const [first, second] = collidingPair();
    const firstColor = pickSessionColor(first, []);
    expect(firstColor).toBe(sessionColor(first));
    expect(pickSessionColor(second, [firstColor])).toBe(
      SESSION_COLORS[(sessionColorSlot(second) + 1) % SESSION_COLOR_COUNT],
    );
  });

  it("gives the hashed colour to whichever of a colliding pair arrives first", () => {
    const [first, second] = collidingPair();
    const secondFirst = pickSessionColor(second, []);
    expect(secondFirst).toBe(sessionColor(second));
    expect(pickSessionColor(first, [secondFirst])).not.toBe(sessionColor(first));
  });

  it("falls back to its own colour once every slot is taken", () => {
    expect(pickSessionColor("ses-alpha", SESSION_COLORS)).toBe(sessionColor("ses-alpha"));
  });

  it("never moves a colour already handed out: the incremental answer is stable as earlier Sessions leave", () => {
    const [first, second] = collidingPair();
    const firstColor = pickSessionColor(first, []);
    const secondColor = pickSessionColor(second, [firstColor]);
    // `first` leaves; `second` is not re-asked and keeps what it has, while a
    // newcomer sees only the colours still live.
    expect(pickSessionColor(second, [secondColor])).not.toBe(secondColor);
    expect(secondColor).not.toBe(firstColor);
  });

  it("gives eight concurrent Sessions eight distinct colours, arriving one at a time", () => {
    const ids = Array.from({ length: SESSION_COLOR_COUNT }, (_, n) => `ses-${n}`);
    expect(new Set(arriving(ids).values()).size).toBe(SESSION_COLOR_COUNT);
  });

  it("wraps a ninth Session to its hashed slot once the wheel is full", () => {
    const ids = Array.from({ length: SESSION_COLOR_COUNT + 1 }, (_, n) => `ses-${n}`);
    const ninth = ids[SESSION_COLOR_COUNT]!;
    expect(arriving(ids).get(ninth)).toBe(sessionColor(ninth));
  });
});
