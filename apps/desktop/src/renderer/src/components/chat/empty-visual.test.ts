import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_EMPTY_VISUAL,
  EMPTY_VISUAL_LABELS,
  resolveEmptyVisual,
  sanitizeEmptyVisual,
  visualsForScope,
} from "./empty-visual";

describe("visualsForScope", () => {
  it("offers a Project Session the whole field", () => {
    expect(visualsForScope("project")).toEqual(["streak", "board", "venue"]);
  });

  it("offers a Ticket Session only what a ticket can fill", () => {
    // The shortness IS the identity signal — see the module doc before adding
    // anything here.
    expect(visualsForScope("ticket")).toEqual(["venue"]);
  });

  it("names every visual it offers", () => {
    for (const visual of [...visualsForScope("project"), ...visualsForScope("ticket")]) {
      expect(EMPTY_VISUAL_LABELS[visual].length).toBeGreaterThan(0);
    }
  });
});

describe("resolveEmptyVisual", () => {
  it("honours a Home choice the scope offers", () => {
    expect(resolveEmptyVisual("project", "board")).toBe("board");
    expect(resolveEmptyVisual("project", "venue")).toBe("venue");
    expect(resolveEmptyVisual("project", "streak")).toBe("streak");
  });

  it("falls to the scope's own head when the choice is not on its menu", () => {
    expect(resolveEmptyVisual("ticket", "streak")).toBe("venue");
    expect(resolveEmptyVisual("ticket", "board")).toBe("venue");
  });

  it("draws a ticket's one visual whatever is stored", () => {
    expect(resolveEmptyVisual("ticket", "venue")).toBe("venue");
  });
});

describe("sanitizeEmptyVisual", () => {
  it("keeps every visual this build draws", () => {
    expect(sanitizeEmptyVisual("streak")).toBe("streak");
    expect(sanitizeEmptyVisual("board")).toBe("board");
    expect(sanitizeEmptyVisual("venue")).toBe("venue");
  });

  it("lands anything else on the default", () => {
    expect(sanitizeEmptyVisual("greeter")).toBe(DEFAULT_EMPTY_VISUAL);
    expect(sanitizeEmptyVisual(undefined)).toBe(DEFAULT_EMPTY_VISUAL);
    expect(sanitizeEmptyVisual(7)).toBe(DEFAULT_EMPTY_VISUAL);
    expect(sanitizeEmptyVisual(null)).toBe(DEFAULT_EMPTY_VISUAL);
  });
});
