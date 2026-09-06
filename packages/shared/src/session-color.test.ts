import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_COLOR_COUNT,
  SESSION_COLORS,
  assignSessionColors,
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

describe("assignSessionColors", () => {
  it("gives an uncontended Session its own hashed colour", () => {
    const colours = assignSessionColors(["ses-alpha"]);
    expect(colours.get("ses-alpha")).toBe(sessionColor("ses-alpha"));
  });

  it("moves the later of two colliding Sessions to the next slot round the wheel", () => {
    const [first, second] = collidingPair();
    const colours = assignSessionColors([first, second]);
    expect(colours.get(first)).toBe(sessionColor(first));
    expect(colours.get(second)).toBe(
      SESSION_COLORS[(sessionColorSlot(second) + 1) % SESSION_COLOR_COUNT],
    );
    expect(colours.get(first)).not.toBe(colours.get(second));
  });

  it("keeps the earlier Session's colour whichever way the pair is listed", () => {
    const [first, second] = collidingPair();
    expect(assignSessionColors([second, first]).get(second)).toBe(sessionColor(second));
    expect(assignSessionColors([second, first]).get(first)).not.toBe(sessionColor(first));
  });

  it("gives eight concurrent Sessions eight distinct colours", () => {
    const ids = Array.from({ length: SESSION_COLOR_COUNT }, (_, n) => `ses-${n}`);
    const colours = assignSessionColors(ids);
    expect(new Set(colours.values()).size).toBe(SESSION_COLOR_COUNT);
  });

  it("wraps a ninth Session to its hashed slot once the wheel is full", () => {
    const ids = Array.from({ length: SESSION_COLOR_COUNT + 1 }, (_, n) => `ses-${n}`);
    const ninth = ids[SESSION_COLOR_COUNT]!;
    expect(assignSessionColors(ids).get(ninth)).toBe(sessionColor(ninth));
  });

  it("answers a repeated id once, with the colour it already has", () => {
    const colours = assignSessionColors(["ses-alpha", "ses-alpha"]);
    expect(colours.size).toBe(1);
    expect(colours.get("ses-alpha")).toBe(sessionColor("ses-alpha"));
  });
});
