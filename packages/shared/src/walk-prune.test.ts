import { describe, expect, it } from "vite-plus/test";

import { DEPENDENCY_AND_BUILD_DIRS } from "./walk-prune";

describe("DEPENDENCY_AND_BUILD_DIRS", () => {
  it("names a dependency or build tree for every ecosystem the walks meet, not just JS", () => {
    // The bias this list exists to remove: `node_modules` alone made a Python,
    // Rust, Go, Ruby or JVM checkout pay a full walk of a tree nobody authored.
    expect([...DEPENDENCY_AND_BUILD_DIRS]).toEqual([
      ".bundle",
      ".gradle",
      ".tox",
      ".venv",
      "venv",
      "__pycache__",
      "node_modules",
      "target",
      "vendor",
    ]);
  });

  it("holds no name that is an ordinary source directory somewhere", () => {
    // The membership rule, asserted: a name earns a place only when a command
    // reproduces its contents. `dist`/`build`/`out`/`.next` are output in one
    // repository and hand-written source in the next, so skipping them
    // unasked would hide a file someone wrote.
    for (const name of ["dist", "build", "out", ".next", "src", "lib"]) {
      expect(DEPENDENCY_AND_BUILD_DIRS).not.toContain(name);
    }
  });

  it("holds plain directory NAMES — every consumer matches one path segment", () => {
    // Consumers compare against a single `Dirent.name` or a watch event's
    // leading segment; a pattern, a path or a duplicate would silently miss.
    const seen = new Set<string>();
    for (const name of DEPENDENCY_AND_BUILD_DIRS) {
      expect(name).not.toBe("");
      expect(name).not.toMatch(/[/\\*?]/);
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
  });
});
