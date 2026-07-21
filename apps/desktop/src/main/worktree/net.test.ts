import { describe, expect, it } from "vite-plus/test";

import { fetchBase, ghCreateDraftPr, ghDiscoverPr, ghFindPr, ghPrStatus, pushBranch } from "./net";
import { netFailure, scriptedNet } from "./scripted-net";

describe("fetchBase", () => {
  it("runs git fetch origin <base> and returns ok", async () => {
    const { run, calls } = scriptedNet(() => ({ stdout: "" }));
    const result = await fetchBase(run, { worktreePath: "/wt", baseBranch: "main" });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({ file: "git", args: ["fetch", "origin", "main"], cwd: "/wt" });
  });

  it("returns err (never throws) when the fetch fails — best-effort is the caller's call", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "fatal: could not read from remote", code: 128 });
    });
    const result = await fetchBase(run, { worktreePath: "/wt", baseBranch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("could not read from remote");
  });
});

describe("pushBranch", () => {
  it("runs git push -u origin <branch> and returns ok", async () => {
    const { run, calls } = scriptedNet(() => ({ stderr: "branch set up to track" }));
    const result = await pushBranch(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["push", "-u", "origin", "volli/VC-12-x"]);
  });

  it("classifies a non-fast-forward rejection with a moved-remote message (never force-push)", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({
        stderr:
          "! [rejected]        volli/VC-12-x -> volli/VC-12-x (non-fast-forward)\n" +
          "error: failed to push some refs\nhint: Updates were rejected... fetch first",
        code: 1,
      });
    });
    const result = await pushBranch(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/moved|remote branch|diverged/i);
    expect(result.error.toLowerCase()).not.toContain("force");
  });

  it("classifies a missing remote distinctly", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({
        stderr: "fatal: No configured push destination.",
        code: 128,
      });
    });
    const result = await pushBranch(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/remote/i);
  });

  it("passes an ssh-auth failure through as raw stderr, not misdiagnosed as a missing remote", async () => {
    const stderr =
      "git@github.com: Permission denied (publickey).\n" +
      "fatal: Could not read from remote repository.\n" +
      "Please make sure you have the correct access rights and the repository exists.";
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr, code: 128 });
    });
    const result = await pushBranch(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Permission denied");
    expect(result.error).not.toContain("Add an `origin` remote");
  });
});

describe("ghCreateDraftPr", () => {
  const input = {
    worktreePath: "/wt",
    base: "main",
    branch: "volli/VC-12-x",
    title: "VC-12: thing",
    body: "body md",
  };

  it("passes --draft and returns the URL from the last stdout line", async () => {
    const { run, calls } = scriptedNet(() => ({
      stdout: "Creating draft pull request\nhttps://github.com/o/r/pull/7\n",
    }));
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("https://github.com/o/r/pull/7");
    const call = calls[0];
    expect(call?.file).toBe("gh");
    expect(call?.args).toContain("--draft");
    expect(call?.args).toContain("--title");
    expect(call?.args).toContain("VC-12: thing");
  });

  it("classifies gh-not-installed (ENOENT)", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ code: "ENOENT", stderr: "" });
    });
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("not-installed");
  });

  it("classifies not-authenticated", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({
        stderr: "To get started with GitHub CLI, please run: gh auth login",
        code: 1,
      });
    });
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("not-authenticated");
  });

  it("classifies pr-exists (caller then looks up the URL)", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({
        stderr: 'a pull request for branch "volli/VC-12-x" into branch "main" already exists',
        code: 1,
      });
    });
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("pr-exists");
  });

  it("classifies no-remote", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({
        stderr:
          "none of the git remotes configured for this repository point to a known GitHub host",
        code: 1,
      });
    });
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("no-remote");
  });

  it("classifies network failures", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({
        stderr: "error connecting to api.github.com: dial tcp: lookup api.github.com: no such host",
        code: 1,
      });
    });
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("network");
  });

  it("falls back to unknown for unclassified failures", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "something bizarre happened", code: 3 });
    });
    const result = await ghCreateDraftPr(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unknown");
    expect(result.failure.message).toContain("bizarre");
  });
});

describe("ghFindPr", () => {
  it("returns the URL for an existing OPEN PR (pr list --state open, never pr view)", async () => {
    const { run, calls } = scriptedNet(() => ({ stdout: "https://github.com/o/r/pull/7\n" }));
    const result = await ghFindPr(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("https://github.com/o/r/pull/7");
    // `pr view <branch>` would resolve a MERGED/CLOSED PR too — the open-state
    // filter is what keeps a dead PR from blocking a fresh one (see net.ts).
    expect(calls[0]?.args).toEqual([
      "pr",
      "list",
      "--head",
      "volli/VC-12-x",
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[].url",
    ]);
  });

  it("returns url=null (ok) when no OPEN PR exists (e.g. the branch's PR merged)", async () => {
    const { run } = scriptedNet(() => ({ stdout: "" }));
    const result = await ghFindPr(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBeNull();
  });

  it("returns url=null (ok) when gh reports no pull requests found", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: 'no pull requests found for branch "volli/VC-12-x"', code: 1 });
    });
    const result = await ghFindPr(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBeNull();
  });

  it("classifies other failures (e.g. not-authenticated) rather than swallowing them", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "gh auth login required", code: 1 });
    });
    const result = await ghFindPr(run, { worktreePath: "/wt", branch: "volli/VC-12-x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("not-authenticated");
  });
});

describe("ghPrStatus", () => {
  const input = { worktreePath: "/wt", prUrl: "https://github.com/o/r/pull/7" };

  it("runs gh pr view <url> with the retention json fields", async () => {
    const { run, calls } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    expect(calls[0]?.file).toBe("gh");
    expect(calls[0]?.args).toEqual([
      "pr",
      "view",
      "https://github.com/o/r/pull/7",
      "--json",
      "state,mergedAt,mergeStateStatus,statusCheckRollup",
    ]);
  });

  it("parses an open, mergeable PR with passing checks", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      state: "open",
      mergedAt: null,
      hasConflicts: false,
      failingChecks: [],
    });
  });

  it("maps MERGED state and its mergedAt timestamp", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-07-20T10:00:00Z",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("merged");
    expect(result.value.mergedAt).toBe("2026-07-20T10:00:00Z");
  });

  it("flags a merge conflict from mergeStateStatus DIRTY", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasConflicts).toBe(true);
  });

  it("collects failing check names from CheckRun conclusions and StatusContext states", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
          { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
          { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
        ],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failingChecks).toEqual(["lint", "ci/legacy"]);
  });

  it("treats an unparseable body as an unknown failure rather than throwing", async () => {
    const { run } = scriptedNet(() => ({ stdout: "not json" }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unknown");
  });

  it("classifies transport failures (network) like the other gh verbs", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "could not resolve host: api.github.com", code: 1 });
    });
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("network");
  });
});

describe("ghDiscoverPr", () => {
  const wt = "/wt";

  it("lists PRs for the branch in ANY state (the merge-watch must see merged PRs too)", async () => {
    const { run, calls } = scriptedNet(() => ({ stdout: "[]" }));
    await ghDiscoverPr(run, { worktreePath: wt, branch: "volli/VC-12-x" });
    expect(calls[0]?.args).toEqual([
      "pr",
      "list",
      "--head",
      "volli/VC-12-x",
      "--state",
      "all",
      "--json",
      "url,state,updatedAt",
    ]);
  });

  it("prefers an OPEN PR over a more-recently-updated closed one", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify([
        { url: "https://x/pull/1", state: "OPEN", updatedAt: "2026-07-01T00:00:00Z" },
        { url: "https://x/pull/2", state: "CLOSED", updatedAt: "2026-07-20T00:00:00Z" },
      ]),
    }));
    const result = await ghDiscoverPr(run, { worktreePath: wt, branch: "b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("https://x/pull/1");
  });

  it("falls back to the most-recently-updated MERGED PR when none are open", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify([
        { url: "https://x/pull/1", state: "MERGED", updatedAt: "2026-07-01T00:00:00Z" },
        { url: "https://x/pull/2", state: "CLOSED", updatedAt: "2026-07-20T00:00:00Z" },
      ]),
    }));
    const result = await ghDiscoverPr(run, { worktreePath: wt, branch: "b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // pull/2 is more recently updated, but it's CLOSED-UNMERGED (dead) — the
    // MERGED pull/1 wins, proving the fallback is restricted to open-or-merged
    // rather than "most recent in any state" (F2).
    expect(result.value.url).toBe("https://x/pull/1");
  });

  it("never adopts a closed-unmerged PR — Create PR must stay available (F2)", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify([
        { url: "https://x/pull/1", state: "CLOSED", updatedAt: "2026-07-01T00:00:00Z" },
        { url: "https://x/pull/2", state: "CLOSED", updatedAt: "2026-07-20T00:00:00Z" },
      ]),
    }));
    const result = await ghDiscoverPr(run, { worktreePath: wt, branch: "b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBeNull();
  });

  it("returns url=null (ok) when the branch has no PRs", async () => {
    const { run } = scriptedNet(() => ({ stdout: "[]" }));
    const result = await ghDiscoverPr(run, { worktreePath: wt, branch: "b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBeNull();
  });

  it("returns url=null (ok) when gh reports no pull requests found", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: 'no pull requests found for branch "b"', code: 1 });
    });
    const result = await ghDiscoverPr(run, { worktreePath: wt, branch: "b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBeNull();
  });

  it("classifies real failures rather than swallowing them", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "gh auth login required", code: 1 });
    });
    const result = await ghDiscoverPr(run, { worktreePath: wt, branch: "b" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("not-authenticated");
  });
});
