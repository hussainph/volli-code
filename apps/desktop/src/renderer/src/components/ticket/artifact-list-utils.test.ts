import { describe, expect, it } from "vite-plus/test";
import type { ArtifactEntry } from "@volli/shared";

import { artifactKey, groupArtifactsByTier } from "./artifact-list-utils";

function entry(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    name: "a.md",
    relPath: "a.md",
    tier: "ticket",
    size: 0,
    mtime: 0,
    kind: "markdown",
    ...overrides,
  };
}

describe("groupArtifactsByTier", () => {
  it("splits a flat list into ticket/project sections", () => {
    const grouped = groupArtifactsByTier([
      entry({ name: "t.md", tier: "ticket" }),
      entry({ name: "p.md", tier: "project" }),
    ]);
    expect(grouped.ticket.map((e) => e.name)).toEqual(["t.md"]);
    expect(grouped.project.map((e) => e.name)).toEqual(["p.md"]);
  });

  it("returns empty sections for an empty input", () => {
    expect(groupArtifactsByTier([])).toEqual({ ticket: [], project: [] });
  });

  it("sorts each section independently, case-insensitively", () => {
    const grouped = groupArtifactsByTier([
      entry({ name: "banana.md", tier: "ticket" }),
      entry({ name: "Apple.md", tier: "ticket" }),
      entry({ name: "zebra.md", tier: "project" }),
      entry({ name: "Aardvark.md", tier: "project" }),
    ]);
    expect(grouped.ticket.map((e) => e.name)).toEqual(["Apple.md", "banana.md"]);
    expect(grouped.project.map((e) => e.name)).toEqual(["Aardvark.md", "zebra.md"]);
  });

  it("does not mutate the input array", () => {
    const input = [entry({ name: "b.md" }), entry({ name: "a.md" })];
    const original = [...input];
    groupArtifactsByTier(input);
    expect(input).toEqual(original);
  });
});

describe("artifactKey", () => {
  it("combines tier and name", () => {
    expect(artifactKey({ tier: "ticket", name: "notes.md" })).toBe("ticket:notes.md");
  });

  it("distinguishes the same name across tiers", () => {
    expect(artifactKey({ tier: "ticket", name: "notes.md" })).not.toBe(
      artifactKey({ tier: "project", name: "notes.md" }),
    );
  });
});
