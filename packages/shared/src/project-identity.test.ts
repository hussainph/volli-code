import { describe, it, expect } from "vite-plus/test";
import {
  monogram,
  derivePrefix,
  isValidPrefix,
  validateUniquePrefix,
  projectColor,
  PROJECT_COLORS,
} from "./project-identity";

describe("monogram", () => {
  it("takes the first letter of the first two words", () => {
    expect(monogram("volli code")).toBe("VC");
  });

  it("treats hyphens as word separators", () => {
    expect(monogram("volli-code")).toBe("VC");
  });

  it("takes the first two characters of a single word", () => {
    expect(monogram("voltaic")).toBe("VO");
  });

  it("only uses the first two of more than two words", () => {
    expect(monogram("my cool app")).toBe("MC");
  });

  it("falls back to a single character when the word is one letter", () => {
    expect(monogram("a")).toBe("A");
  });

  it("returns '?' for an empty name", () => {
    expect(monogram("")).toBe("?");
  });

  it("returns '?' for an all-punctuation name", () => {
    expect(monogram("!!!")).toBe("?");
  });
});

describe("derivePrefix", () => {
  it("takes the first letter of the first three words", () => {
    expect(derivePrefix("my cool app")).toBe("MCA");
  });

  it("only uses the first three of more than three words", () => {
    expect(derivePrefix("my very cool app")).toBe("MVC");
  });

  it("treats hyphens as word separators", () => {
    expect(derivePrefix("volli-code")).toBe("VC");
  });

  it("takes the first two characters of a single word", () => {
    expect(derivePrefix("voltaic")).toBe("VO");
  });

  it("drops a leading digit after uppercasing", () => {
    expect(derivePrefix("3d assets")).toBe("A");
  });

  it("falls back to PRJ for an empty name", () => {
    expect(derivePrefix("")).toBe("PRJ");
  });

  it("falls back to PRJ when the candidate is all digits", () => {
    expect(derivePrefix("123")).toBe("PRJ");
  });
});

describe("isValidPrefix", () => {
  it("accepts a single uppercase letter", () => {
    expect(isValidPrefix("V")).toBe(true);
  });

  it("accepts five uppercase letters", () => {
    expect(isValidPrefix("VOLLI")).toBe(true);
  });

  it("accepts letters followed by digits", () => {
    expect(isValidPrefix("VC12")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidPrefix("")).toBe(false);
  });

  it("rejects more than five characters", () => {
    expect(isValidPrefix("TOOLONG")).toBe(false);
  });

  it("rejects lowercase letters", () => {
    expect(isValidPrefix("vc")).toBe(false);
  });

  it("rejects a leading digit", () => {
    expect(isValidPrefix("1AB")).toBe(false);
  });

  it("rejects non-alphanumeric characters", () => {
    expect(isValidPrefix("AB!")).toBe(false);
  });
});

describe("validateUniquePrefix", () => {
  it("names the existing project when a prefix collides", () => {
    expect(
      validateUniquePrefix("VC", [
        { id: "one", name: "Volli Code", ticketPrefix: "VC" },
        { id: "two", name: "Website", ticketPrefix: "WEB" },
      ]),
    ).toEqual({
      ok: false,
      error: 'Ticket prefix "VC" is already used by Volli Code.',
    });
  });
});

describe("PROJECT_COLORS / projectColor", () => {
  it("has exactly 8 entries", () => {
    expect(PROJECT_COLORS.length).toBe(8);
  });

  it("indexes the ember accent at 0", () => {
    expect(projectColor(0)).toBe("#E8652A");
  });

  it("wraps around at the palette length", () => {
    expect(projectColor(8)).toBe("#E8652A");
  });

  it("continues wrapping past the palette length", () => {
    expect(projectColor(9)).toBe("#C98A1B");
  });

  it("handles negative input defensively", () => {
    expect(projectColor(-1)).toBe(PROJECT_COLORS[1]);
  });
});
