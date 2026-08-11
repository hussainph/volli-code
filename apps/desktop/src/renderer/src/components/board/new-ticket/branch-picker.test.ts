import { describe, expect, it } from "vite-plus/test";
import type { WorktreeBranchListing } from "@volli/shared";

import {
  defaultBaseBranch,
  fetchedLabel,
  groupBranchOptions,
  resolveBaseBranch,
} from "./branch-picker";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function listing(overrides: Partial<WorktreeBranchListing> = {}): WorktreeBranchListing {
  return {
    branches: ["main", "develop"],
    current: "main",
    remotes: ["origin/main"],
    fetchedAt: NOW - 2 * HOUR,
    ...overrides,
  };
}

describe("fetchedLabel", () => {
  it("phrases the snapshot's age", () => {
    expect(fetchedLabel(NOW - 2 * HOUR, NOW)).toBe("fetched 2h ago");
  });

  it("says a repo has never fetched rather than saying nothing", () => {
    expect(fetchedLabel(null, NOW)).toBe("never fetched");
  });

  it("defaults `now` to the wall clock", () => {
    expect(fetchedLabel(Date.now())).toBe("fetched just now");
  });
});

describe("defaultBaseBranch", () => {
  it("is the checkout's own branch", () => {
    expect(defaultBaseBranch(listing())).toBe("main");
  });

  it("falls back to the most recently committed branch on a detached HEAD", () => {
    expect(defaultBaseBranch(listing({ current: null }))).toBe("main");
  });

  it("is null for a project with no branches", () => {
    expect(defaultBaseBranch(listing({ current: null, branches: [] }))).toBeNull();
  });

  it("is null before the refs have arrived", () => {
    expect(defaultBaseBranch(null)).toBeNull();
  });
});

describe("resolveBaseBranch", () => {
  it("keeps a choice the project still has", () => {
    expect(resolveBaseBranch("develop", listing())).toBe("develop");
  });

  it("keeps a remote-tracking choice", () => {
    expect(resolveBaseBranch("origin/main", listing())).toBe("origin/main");
  });

  it("replaces a branch the project no longer has with the default", () => {
    expect(resolveBaseBranch("deleted/branch", listing())).toBe("main");
  });

  it("fills an unset choice with the default", () => {
    expect(resolveBaseBranch(null, listing())).toBe("main");
  });

  it("holds the choice while the refs are still in flight", () => {
    expect(resolveBaseBranch("develop", null)).toBe("develop");
    expect(resolveBaseBranch(null, null)).toBeNull();
  });
});

describe("groupBranchOptions", () => {
  it("separates local heads from the remote snapshot and dates the snapshot", () => {
    expect(groupBranchOptions(listing(), "", NOW)).toEqual([
      {
        key: "local",
        heading: "Branches",
        options: [
          { name: "main", remote: false },
          { name: "develop", remote: false },
        ],
      },
      {
        key: "remote",
        heading: "Remote · fetched 2h ago",
        options: [{ name: "origin/main", remote: true }],
      },
    ]);
  });

  it("filters both groups case-insensitively and drops the ones left empty", () => {
    expect(groupBranchOptions(listing(), "DEVEL", NOW)).toEqual([
      { key: "local", heading: "Branches", options: [{ name: "develop", remote: false }] },
    ]);
    expect(groupBranchOptions(listing(), "origin", NOW)).toEqual([
      {
        key: "remote",
        heading: "Remote · fetched 2h ago",
        options: [{ name: "origin/main", remote: true }],
      },
    ]);
    expect(groupBranchOptions(listing(), "nothing-matches", NOW)).toEqual([]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(groupBranchOptions(listing(), "  develop  ", NOW)).toEqual([
      { key: "local", heading: "Branches", options: [{ name: "develop", remote: false }] },
    ]);
  });

  it("marks a never-fetched remote group as such", () => {
    const groups = groupBranchOptions(listing({ fetchedAt: null }), "", NOW);
    expect(groups[1]?.heading).toBe("Remote · never fetched");
  });

  it("shows only the local group for a repo with no remote", () => {
    const groups = groupBranchOptions(listing({ remotes: [] }), "", NOW);
    expect(groups.map((group) => group.key)).toEqual(["local"]);
  });

  it("is empty before the refs have arrived", () => {
    expect(groupBranchOptions(null, "", NOW)).toEqual([]);
  });

  it("defaults `now` to the wall clock", () => {
    const groups = groupBranchOptions(listing({ fetchedAt: Date.now() }), "origin");
    expect(groups[0]?.heading).toBe("Remote · fetched just now");
  });
});
