import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import type { CredentialHelperIssue } from "../credential-helper-diagnostics";
import {
  extractFailure,
  fetchBase,
  ghCreateDraftPr,
  ghDiscoverPr,
  ghFindPr,
  ghPrStatus,
  pushBranch,
} from "./net";
import { netFailure, scriptedNet } from "./scripted-net";

const OSXKEYCHAIN: CredentialHelperIssue = {
  kind: "osxkeychain-may-prompt-gui",
  helper: "osxkeychain",
  scope: "global",
  location: "/Users/me/.gitconfig",
};

/** A recording stand-in for the read-only `git config` diagnosis. */
function explainer(issues: readonly CredentialHelperIssue[] = []) {
  const asked: string[] = [];
  return {
    asked,
    explain: async (cwd: string) => {
      asked.push(cwd);
      return issues;
    },
  };
}

/** A host with no GUI credential helper: Git's stderr stands alone. */
const NO_HELPERS = async () => [];

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
    const result = await pushBranch(
      run,
      { worktreePath: "/wt", branch: "volli/VC-12-x" },
      NO_HELPERS,
    );
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
    const result = await pushBranch(
      run,
      { worktreePath: "/wt", branch: "volli/VC-12-x" },
      NO_HELPERS,
    );
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
    const result = await pushBranch(
      run,
      { worktreePath: "/wt", branch: "volli/VC-12-x" },
      NO_HELPERS,
    );
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
    const result = await pushBranch(
      run,
      { worktreePath: "/wt", branch: "volli/VC-12-x" },
      NO_HELPERS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Permission denied");
    expect(result.error).not.toContain("Add an `origin` remote");
  });
});

// VC-159/R8: `osxkeychain` is the stock macOS Git setup, so it is explained
// where it explains something — at the failure it predicts — and nowhere else.
/** A push/fetch that failed for want of credentials Git could not obtain. */
function promptFailure() {
  return scriptedNet(() => {
    throw netFailure({
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      code: 128,
    });
  });
}

describe("the credential-helper explanation's venue", () => {
  it("explains the helper on a push that failed for want of credentials", async () => {
    const { run } = promptFailure();
    const { asked, explain } = explainer([OSXKEYCHAIN]);

    const result = await pushBranch(run, { worktreePath: "/wt", branch: "b" }, explain);

    expect(asked).toEqual(["/wt"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Git's own stderr survives; the explanation is added under it.
    expect(result.error).toContain("could not read Username");
    expect(result.error).toContain("osxkeychain");
    expect(result.error).toContain("/Users/me/.gitconfig");
    expect(result.error).toContain("a Session cannot answer");
    expect(result.error).toContain("gh auth login");
  });

  // Fetch does NOT explain, on purpose. Every caller treats a failed fetch as
  // best-effort and throws the string away (publish.ts §3), so diagnosing it
  // would spend a `git config` subprocess on a sentence with no reader. The
  // prompt that stops the fetch stops the push a moment later, and the push is
  // where somebody is told.
  it("leaves a failed fetch undiagnosed, because nobody reads its error", async () => {
    const { run } = promptFailure();

    const result = await fetchBase(run, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("could not read Username");
    expect(result.error).not.toContain("osxkeychain");
  });

  it("asks nothing when the failure is not one a credential prompt accounts for", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "! [rejected] b -> b (non-fast-forward)", code: 1 });
    });
    const { asked, explain } = explainer([OSXKEYCHAIN]);

    const result = await pushBranch(run, { worktreePath: "/wt", branch: "b" }, explain);

    expect(asked).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("osxkeychain");
  });

  it("leaves the stderr alone when no such helper is configured", async () => {
    const { run } = promptFailure();
    const { explain } = explainer();

    const result = await pushBranch(run, { worktreePath: "/wt", branch: "b" }, explain);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
  });

  it("establishes nothing when the diagnosis itself cannot be taken", async () => {
    const { run } = promptFailure();

    const result = await pushBranch(run, { worktreePath: "/wt", branch: "b" }, async () => {
      throw new Error("git config is not runnable here");
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("could not read Username");
    expect(result.error).not.toContain("osxkeychain");
  });

  // A verb the RUNNER killed on its timeout is what a hung GUI prompt looks
  // like from out here: no stderr to classify, just a process that never came
  // back. Node marks exactly this with `killed`, which is what `extractFailure`
  // reads — the shape is asserted in "execFile's timeout shape" below.
  it("treats a timed-out network verb as consistent with a prompt nobody could answer", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "", killed: true });
    });
    const { explain } = explainer([OSXKEYCHAIN]);

    const result = await pushBranch(run, { worktreePath: "/wt", branch: "b" }, explain);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("osxkeychain");
  });

  // The opposite, and the reason `killed` is read rather than `signal`: a child
  // that something ELSE killed (an app quit's SIGTERM) is not a hung credential
  // prompt, and must not be handed the keychain paragraph.
  it("does not blame the keychain for a child something else killed", async () => {
    const { run } = scriptedNet(() => {
      throw netFailure({ stderr: "", signal: "SIGTERM" });
    });
    const { asked, explain } = explainer([OSXKEYCHAIN]);

    const result = await pushBranch(run, { worktreePath: "/wt", branch: "b" }, explain);

    expect(asked).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("osxkeychain");
  });
});

// The timeout is not decoration: without it a push blocked on a macOS keychain
// window never fails, so the explanation above never runs (VC-159/R8). What
// this pins is the SHAPE `extractFailure` reads that timeout out of — against a
// real `execFile`, on a short bound of its own rather than the runner's real
// two minutes, because the assumption being checked is Node's, not ours.
describe("execFile's timeout shape", () => {
  it("marks a verb it killed with `killed`, and leaves `code` null", async () => {
    const caught = await promisify(execFile)("sleep", ["5"], { timeout: 100 }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).not.toBeNull();
    // `code` is null on this path, so a classifier keying on a code (an
    // `ETIMEDOUT` that execFile never emits) would miss every hung verb.
    const failure = extractFailure(caught);
    expect(failure.code).toBeNull();
    expect(failure.timedOut).toBe(true);
  });

  it("leaves `timedOut` false for an ordinary non-zero exit", async () => {
    const caught = await promisify(execFile)("sh", ["-c", "exit 3"]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(extractFailure(caught).timedOut).toBe(false);
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
      checks: [{ name: "build", workflow: null, state: "passing", url: null }],
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

  it("normalizes both rollup shapes into one list, preserving gh's order", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "lint",
            workflowName: "CI",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://github.com/o/r/actions/runs/1/job/9",
          },
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
          {
            __typename: "StatusContext",
            context: "ci/legacy",
            state: "ERROR",
            targetUrl: "https://legacy.example/build/3",
          },
          { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS", targetUrl: "" },
        ],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checks).toEqual([
      {
        name: "lint",
        workflow: "CI",
        state: "failing",
        url: "https://github.com/o/r/actions/runs/1/job/9",
      },
      { name: "test", workflow: null, state: "passing", url: null },
      { name: "e2e", workflow: null, state: "pending", url: null },
      {
        name: "ci/legacy",
        workflow: null,
        state: "failing",
        url: "https://legacy.example/build/3",
      },
      // An empty `targetUrl` is gh's "no link", not a link to nowhere.
      { name: "ci/ok", workflow: null, state: "passing", url: null },
    ]);
  });

  it("maps every CheckRun conclusion to one of the four states", async () => {
    const conclusions = [
      ["SUCCESS", "passing"],
      ["NEUTRAL", "passing"],
      ["SKIPPED", "skipped"],
      ["STALE", "skipped"],
      ["FAILURE", "failing"],
      ["TIMED_OUT", "failing"],
      ["CANCELLED", "failing"],
      ["STARTUP_FAILURE", "failing"],
      ["ACTION_REQUIRED", "failing"],
      // Not a member of today's enum: an unrecognized verdict must claim
      // neither a pass nor a failure.
      ["SOMETHING_NEW", "pending"],
    ] as const;
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: conclusions.map(([conclusion]) => ({
          __typename: "CheckRun",
          name: conclusion,
          status: "COMPLETED",
          conclusion,
        })),
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checks.map((check) => [check.name, check.state])).toEqual(
      conclusions.map(([conclusion, state]) => [conclusion, state]),
    );
  });

  it("reads a queued CheckRun as pending whatever its status is called", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "a", status: "QUEUED", conclusion: null },
          { __typename: "CheckRun", name: "b", status: "WAITING", conclusion: null },
          // A stale conclusion left on a re-queued run must not outrank its status.
          { __typename: "CheckRun", name: "c", status: "REQUESTED", conclusion: "SUCCESS" },
        ],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checks.map((check) => check.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("drops a rollup entry that names nothing rather than inventing a row", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "", status: "COMPLETED", conclusion: "SUCCESS" },
          null,
          "not-an-object",
          { __typename: "CheckRun", name: "real", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checks).toEqual([
      { name: "real", workflow: null, state: "passing", url: null },
    ]);
  });

  it("reads a non-array rollup as no checks at all", async () => {
    const { run } = scriptedNet(() => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: null,
      }),
    }));
    const result = await ghPrStatus(run, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checks).toEqual([]);
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
