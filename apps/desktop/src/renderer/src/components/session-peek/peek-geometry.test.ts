/**
 * Where the card lands, in the cases a window can actually be in.
 *
 * Ported from the lab's `geometry.test.ts` and extended with the production
 * departure it exists for (plan §1.3): the clamp is the real scroll container's
 * span and the real window, not the lab shell's two hard-coded insets.
 */
import { describe, expect, it } from "vite-plus/test";

import { clamp, PEEK_CARD_WIDTH, positionPeek } from "./peek-geometry";

const VIEWPORT = { width: 1280, height: 800 };
/** A sidebar's scroll container: below a header, above the window's edge. */
const CONTAINER = { top: 48, bottom: 744 };

describe("clamp", () => {
  it("bounds a value, and survives a range with no room in it", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    // An inverted range (a container shorter than the card) resolves to its min
    // rather than to a max below it, which is what keeps a top from going up.
    expect(clamp(5, 10, 0)).toBe(10);
  });
});

describe("which way the card opens", () => {
  it("opens right from the nav and left from the rail", () => {
    const nav = positionPeek({
      row: { left: 0, right: 280, top: 90 },
      container: CONTAINER,
      viewport: VIEWPORT,
      surface: "nav",
      cardHeight: 360,
      cardWidth: PEEK_CARD_WIDTH,
    });
    expect(nav.left).toBe(288);
    const rail = positionPeek({
      row: { left: 1000, right: 1280, top: 90 },
      container: CONTAINER,
      viewport: VIEWPORT,
      surface: "rail",
      cardHeight: 360,
      cardWidth: PEEK_CARD_WIDTH,
    });
    expect(rail.left).toBe(1000 - PEEK_CARD_WIDTH - 8);
  });

  it("lifts the card 6px above its row, inside the container", () => {
    const position = positionPeek({
      row: { left: 0, right: 280, top: 300 },
      container: CONTAINER,
      viewport: VIEWPORT,
      surface: "nav",
      cardHeight: 200,
      cardWidth: PEEK_CARD_WIDTH,
    });
    expect(position.top).toBe(294);
  });

  for (const surface of ["nav", "rail"] as const) {
    it(`bounds wide and tall content from the ${surface} side`, () => {
      const position = positionPeek({
        row: { left: 8, right: 312, top: 1000 },
        container: { top: 0, bottom: 480 },
        viewport: { width: 320, height: 480 },
        surface,
        cardHeight: 2000,
        cardWidth: 420,
      });
      // Wider than the window: the card takes the window minus both insets.
      expect(position.left).toBe(8);
      expect(position.top).toBe(8);
      expect(position.top + position.maxHeight).toBe(472);
    });
  }
});

describe("the height budget", () => {
  it("does not constrain a bottom-row card to its unmeasured height", () => {
    const row = { left: 8, right: 300, top: 700 };
    const input = {
      row,
      container: CONTAINER,
      viewport: VIEWPORT,
      surface: "nav" as const,
      cardWidth: PEEK_CARD_WIDTH,
    };
    const initial = positionPeek({ ...input, cardHeight: 0 });
    const measured = positionPeek({ ...input, cardHeight: 410 });
    // The container's whole span, both times — so the first measure of the card
    // is never the clipped height a `top`-derived budget would have given it.
    expect(initial.maxHeight).toBe(696);
    expect(measured.maxHeight).toBe(initial.maxHeight);
    expect(initial.top).toBe(48);
    expect(measured.top).toBe(744 - 410);
  });

  it("clamps the container to the window it is in", () => {
    const position = positionPeek({
      row: { left: 8, right: 300, top: 120 },
      // A container taller than the window (a long list in a short window).
      container: { top: -200, bottom: 2000 },
      viewport: VIEWPORT,
      surface: "nav",
      cardHeight: 300,
      cardWidth: PEEK_CARD_WIDTH,
    });
    expect(position.top).toBe(114);
    expect(position.maxHeight).toBe(800 - 16);
  });

  it("never hands a collapsed container less than a readable card", () => {
    const position = positionPeek({
      row: { left: 8, right: 300, top: 300 },
      // A fold collapsed to nothing still has to draw a card somewhere.
      container: { top: 300, bottom: 300 },
      viewport: VIEWPORT,
      surface: "rail",
      cardHeight: 0,
      cardWidth: PEEK_CARD_WIDTH,
    });
    expect(position.maxHeight).toBe(120);
    expect(position.top).toBe(300);
  });
});
