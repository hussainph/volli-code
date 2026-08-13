import { describe, expect, it } from "vite-plus/test";
import type { WorktreeBranchListing } from "@volli/shared";

import {
  baseChipLabel,
  type BranchListingState,
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

/** A landed read, the state the picker spends nearly all its life in. */
function loaded(overrides: Partial<WorktreeBranchListing> = {}): BranchListingState {
  return { status: "loaded", listing: listing(overrides) };
}

const LOADING: BranchListingState = { status: "loading" };
const FAILED: BranchListingState = { status: "failed", error: "not a git repository" };

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
  it("is the checkout's own branch when the project pins none", () => {
    expect(defaultBaseBranch(listing(), null)).toBe("main");
  });

  it("prefers the project's configured base over the checked-out branch", () => {
    // The composer's default is written to `ticket.baseBranch`, which OUTRANKS
    // `project.base_branch` at worktree time — so a repo parked on a feature
    // branch would durably start new tickets off that feature branch.
    expect(
      defaultBaseBranch(listing({ current: "feature/x", branches: ["feature/x", "main"] }), "main"),
    ).toBe("main");
  });

  it("honours a configured base that only exists as a remote-tracking ref", () => {
    expect(defaultBaseBranch(listing({ current: "develop" }), "origin/main")).toBe("origin/main");
  });

  it("falls through to the checkout's branch when the configured base is gone", () => {
    // An unselectable chip is worse than the fallback: the ref is in no group of
    // the picker, so it would look chosen and fail only at worktree creation.
    expect(defaultBaseBranch(listing({ current: "develop" }), "release/deleted")).toBe("develop");
  });

  it("falls back to the most recently committed branch on a detached HEAD", () => {
    expect(defaultBaseBranch(listing({ current: null }), null)).toBe("main");
  });

  it("offers a remote-tracking ref to a checkout that has no local heads", () => {
    // `git init` + `git fetch` and nothing checked out yet: the picker lists the
    // remote group, so answering "no branches" would contradict its own list.
    expect(defaultBaseBranch(listing({ current: null, branches: [] }), null)).toBe("origin/main");
  });

  it("is null for a project with no refs at all", () => {
    expect(
      defaultBaseBranch(listing({ current: null, branches: [], remotes: [] }), null),
    ).toBeNull();
  });
});

describe("resolveBaseBranch", () => {
  it("keeps a choice the project still has, over the configured base", () => {
    expect(resolveBaseBranch("develop", loaded(), "main")).toBe("develop");
  });

  it("keeps a remote-tracking choice", () => {
    expect(resolveBaseBranch("origin/main", loaded(), null)).toBe("origin/main");
  });

  it("replaces a branch the project no longer has with the default", () => {
    expect(resolveBaseBranch("deleted/branch", loaded(), null)).toBe("main");
  });

  it("fills an unset choice with the default", () => {
    expect(resolveBaseBranch(null, loaded(), null)).toBe("main");
  });

  it("fills an unset choice with the configured base once the refs land", () => {
    expect(resolveBaseBranch(null, loaded({ current: "develop" }), "main")).toBe("main");
  });

  it("holds the choice while the refs are still in flight", () => {
    expect(resolveBaseBranch("develop", LOADING, "main")).toBe("develop");
  });

  it("shows the configured base before the refs land, so a fast submit records what the chip said", () => {
    expect(resolveBaseBranch(null, LOADING, "main")).toBe("main");
  });

  it("has nothing to show or record before the refs land when the project pins no base", () => {
    // `null` is main's cue to resolve a base itself, which is the honest answer —
    // better than the chip guessing one it cannot yet check.
    expect(resolveBaseBranch(null, LOADING, null)).toBeNull();
  });

  it("drops a choice it can never check against a failed read", () => {
    // The read will not land, so `develop` stays a remembered string forever.
    // Stamping it would hand git a name it may not have, and the ticket would
    // carry that base for life with nothing at submit time saying so.
    expect(resolveBaseBranch("develop", FAILED, "main")).toBe("main");
  });

  it("records nothing at all when a failed read meets a project that pins no base", () => {
    expect(resolveBaseBranch("develop", FAILED, null)).toBeNull();
  });
});

describe("baseChipLabel", () => {
  it("is the base itself when there is one", () => {
    expect(baseChipLabel("main", loaded())).toEqual({ text: "main", spoken: "main" });
  });

  it("draws an in-flight read as pending, and says so in words", () => {
    // `…` is a glyph: it draws the wait, and reads aloud as nothing at all.
    expect(baseChipLabel(null, LOADING)).toEqual({ text: "…", spoken: "reading branches" });
  });

  it("says a repo it cannot read is unknown rather than pending", () => {
    expect(baseChipLabel(null, FAILED)).toEqual({ text: "unknown", spoken: "unknown" });
  });

  it("gives a repo with no branches a settled answer of its own", () => {
    // Drawing this as `…` showed a final answer as a waiting one, forever.
    const state = loaded({ current: null, branches: [], remotes: [] });
    expect(baseChipLabel(null, state)).toEqual({ text: "no branches", spoken: "no branches" });
  });
});

describe("groupBranchOptions", () => {
  it("separates local heads from the remote snapshot and dates the snapshot", () => {
    expect(groupBranchOptions(loaded(), "", NOW)).toEqual([
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
    expect(groupBranchOptions(loaded(), "DEVEL", NOW)).toEqual([
      { key: "local", heading: "Branches", options: [{ name: "develop", remote: false }] },
    ]);
    expect(groupBranchOptions(loaded(), "origin", NOW)).toEqual([
      {
        key: "remote",
        heading: "Remote · fetched 2h ago",
        options: [{ name: "origin/main", remote: true }],
      },
    ]);
    expect(groupBranchOptions(loaded(), "nothing-matches", NOW)).toEqual([]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(groupBranchOptions(loaded(), "  develop  ", NOW)).toEqual([
      { key: "local", heading: "Branches", options: [{ name: "develop", remote: false }] },
    ]);
  });

  it("marks a never-fetched remote group as such", () => {
    const groups = groupBranchOptions(loaded({ fetchedAt: null }), "", NOW);
    expect(groups[1]?.heading).toBe("Remote · never fetched");
  });

  it("shows only the local group for a repo with no remote", () => {
    const groups = groupBranchOptions(loaded({ remotes: [] }), "", NOW);
    expect(groups.map((group) => group.key)).toEqual(["local"]);
  });

  it("is empty before the refs have arrived, and after a read that failed", () => {
    expect(groupBranchOptions(LOADING, "", NOW)).toEqual([]);
    expect(groupBranchOptions(FAILED, "", NOW)).toEqual([]);
  });

  it("defaults `now` to the wall clock", () => {
    const groups = groupBranchOptions(loaded({ fetchedAt: Date.now() }), "origin");
    expect(groups[0]?.heading).toBe("Remote · fetched just now");
  });
});
