import { describe, it, expect } from "vite-plus/test";
import { compareDirEntries, type DirEntry } from "./fs-entries";

function entry(name: string, kind: DirEntry["kind"]): DirEntry {
  return { name, kind };
}

describe("compareDirEntries", () => {
  it("sorts directories before files regardless of name", () => {
    const entries = [entry("zeta", "file"), entry("alpha", "dir")];
    expect(entries.toSorted(compareDirEntries)).toEqual([
      entry("alpha", "dir"),
      entry("zeta", "file"),
    ]);
  });

  it("orders case-insensitively within the same kind", () => {
    const entries = [entry("Zeta", "dir"), entry("alpha", "file")];
    // "Zeta" is a dir so it still sorts first, independent of case.
    expect(entries.toSorted(compareDirEntries)).toEqual([
      entry("Zeta", "dir"),
      entry("alpha", "file"),
    ]);
  });

  it("orders same-kind names case-insensitively", () => {
    const entries = [entry("Beta", "file"), entry("alpha", "file")];
    expect(entries.toSorted(compareDirEntries)).toEqual([
      entry("alpha", "file"),
      entry("Beta", "file"),
    ]);
  });

  it("tie-breaks equal lowercased names deterministically", () => {
    const entries = [entry("a", "file"), entry("A", "file")];
    expect(entries.toSorted(compareDirEntries)).toEqual([entry("A", "file"), entry("a", "file")]);
  });

  it("is directly usable as Array.prototype.sort's comparator", () => {
    const entries = [
      entry("src", "file"),
      entry("node_modules", "dir"),
      entry("README.md", "file"),
      entry(".git", "dir"),
    ];
    entries.sort(compareDirEntries);
    expect(entries.map((e) => e.kind)).toEqual(["dir", "dir", "file", "file"]);
  });
});
