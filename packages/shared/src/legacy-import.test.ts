import { describe, expect, it } from "vite-plus/test";

import { sanitizeLegacyProjects } from "./legacy-import";
import type { LegacyProject } from "./legacy-import";

function project(overrides: Partial<LegacyProject> = {}): LegacyProject {
  return {
    id: "proj-1",
    name: "Volli Code",
    path: "/Users/x/volli-code",
    ticketPrefix: "VC",
    colorIndex: 0,
    createdAt: 1000,
    ...overrides,
  };
}

/** Builds an arbitrary (possibly malformed) value for the sanitizer to inspect. */
function malformed(overrides: Record<string, unknown>): unknown {
  const base: Record<string, unknown> = { ...project() };
  return { ...base, ...overrides };
}

describe("sanitizeLegacyProjects", () => {
  it("returns an empty array for undefined", () => {
    expect(sanitizeLegacyProjects(undefined)).toEqual([]);
  });

  it("returns an empty array for null", () => {
    expect(sanitizeLegacyProjects(null)).toEqual([]);
  });

  it("returns an empty array for a non-array object", () => {
    expect(sanitizeLegacyProjects({ projects: [] })).toEqual([]);
  });

  it("returns an empty array for a plain string", () => {
    expect(sanitizeLegacyProjects("not an array")).toEqual([]);
  });

  it("returns an empty array for an empty array", () => {
    expect(sanitizeLegacyProjects([])).toEqual([]);
  });

  it("keeps a fully valid project", () => {
    const p = project();
    expect(sanitizeLegacyProjects([p])).toEqual([p]);
  });

  it("keeps multiple valid projects in order", () => {
    const a = project({ id: "a" });
    const b = project({ id: "b" });
    expect(sanitizeLegacyProjects([a, b])).toEqual([a, b]);
  });

  it("drops non-object entries (null, primitives)", () => {
    expect(sanitizeLegacyProjects([null, 42, "nope", true])).toEqual([]);
  });

  for (const field of ["id", "name", "path", "ticketPrefix"] as const) {
    it(`drops an entry missing the "${field}" field`, () => {
      const { [field]: _omit, ...withoutField } = project();
      expect(sanitizeLegacyProjects([withoutField])).toEqual([]);
    });

    it(`drops an entry with a non-string "${field}"`, () => {
      expect(sanitizeLegacyProjects([malformed({ [field]: 42 })])).toEqual([]);
    });
  }

  it("drops an entry with a non-number colorIndex", () => {
    expect(sanitizeLegacyProjects([malformed({ colorIndex: "0" })])).toEqual([]);
  });

  it("drops an entry missing colorIndex", () => {
    const { colorIndex: _omit, ...withoutColorIndex } = project();
    expect(sanitizeLegacyProjects([withoutColorIndex])).toEqual([]);
  });

  it("drops an entry with a non-number createdAt", () => {
    expect(sanitizeLegacyProjects([malformed({ createdAt: "1000" })])).toEqual([]);
  });

  it("drops an entry missing createdAt", () => {
    const { createdAt: _omit, ...withoutCreatedAt } = project();
    expect(sanitizeLegacyProjects([withoutCreatedAt])).toEqual([]);
  });

  it("drops invalid entries individually while keeping valid ones", () => {
    const valid = project({ id: "valid" });
    const invalid = malformed({ id: "invalid", colorIndex: "oops" });
    expect(sanitizeLegacyProjects([valid, invalid])).toEqual([valid]);
  });
});
