/**
 * The workspace-file writer, against real git. A scripted runner would prove
 * nothing here: the whole claim is "this file does not appear in `git status`",
 * and only git can say that. In particular it is git — not this module — that
 * decides `info/exclude` is read from the COMMON directory rather than the
 * linked worktree's own, which is the fact the exclude step is built around.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { getHarnessAdapter } from "@volli/shared";
import type { HarnessAdapter, HarnessId } from "@volli/shared";

import { ensureHarnessWorkspaceFiles, excludeWithBlock } from "./harness-workspace";
import { runGitCapturing } from "./worktree";

let scratchRoot: string | null = null;

afterEach(() => {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = null;
});

function adapterFor(id: string): HarnessAdapter {
  const found = getHarnessAdapter(id as HarnessId);
  if (!found) throw new Error(`no adapter for ${id}`);
  return found;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  });
}

/** A repo with one commit, plus a linked worktree — the real shape of a ticket. */
function repoWithWorktree(seed?: (mainCheckout: string) => void): {
  main: string;
  worktree: string;
} {
  scratchRoot = mkdtempSync(join(tmpdir(), "volli-harness-workspace-"));
  const main = join(scratchRoot, "main");
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(main, "README.md"), "hi\n", "utf8");
  seed?.(main);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-qm", "init"]);
  const worktree = join(scratchRoot, "wt");
  git(main, ["worktree", "add", "-q", worktree, "-b", "volli/VC-1-thing"]);
  return { main, worktree };
}

function run(worktree: string, adapters: readonly HarnessAdapter[] = [adapterFor("cursor")]) {
  return ensureHarnessWorkspaceFiles({
    worktreePath: worktree,
    adapters,
    socketPath: "/tmp/volli.sock",
    shimPath: "/vol/Application Support/Volli Code/bin/volli",
    git: runGitCapturing,
  });
}

describe("ensureHarnessWorkspaceFiles", () => {
  it("writes cursor's hooks where cursor-agent reads them, invisibly to git", async () => {
    const { worktree } = repoWithWorktree();

    const result = await run(worktree);

    expect(result.refused).toEqual([]);
    expect(result.written).toEqual([join(worktree, ".cursor/hooks.json")]);
    const written = JSON.parse(readFileSync(join(worktree, ".cursor/hooks.json"), "utf8")) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(written.hooks["sessionStart"]?.[0]?.command).toContain("'hook' 'cursor'");
    // The assertion the whole module exists for: an agent running `git add -A`
    // in this worktree must not stage a Volli socket path onto the branch.
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("excludes through the common git dir, which is the only one git reads", async () => {
    const { main, worktree } = repoWithWorktree();
    await run(worktree);

    // Not `<repo>/.git/worktrees/<name>/info/exclude` — git resolves
    // `info/exclude` against the common dir, so a per-worktree copy is inert.
    const exclude = readFileSync(join(main, ".git/info/exclude"), "utf8");
    expect(exclude).toContain("/.cursor/hooks.json");
    expect(exclude).toContain("# volli:begin harness-workspace");
  });

  it("leaves one exclude block however many times a session boots", async () => {
    const { main, worktree } = repoWithWorktree();
    await run(worktree);
    await run(worktree);
    await run(worktree);

    const exclude = readFileSync(join(main, ".git/info/exclude"), "utf8");
    expect(exclude.match(/# volli:begin harness-workspace/g)).toHaveLength(1);
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("keeps the hooks a user already wrote in an untracked file", async () => {
    const { worktree } = repoWithWorktree();
    mkdirSync(join(worktree, ".cursor"), { recursive: true });
    writeFileSync(
      join(worktree, ".cursor/hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: "make lint" }] } }),
      "utf8",
    );

    const result = await run(worktree);

    expect(result.refused).toEqual([]);
    const merged = JSON.parse(readFileSync(join(worktree, ".cursor/hooks.json"), "utf8")) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(merged.hooks["stop"]?.map((entry) => entry.command)).toEqual([
      "make lint",
      expect.stringContaining("'hook' 'cursor' 'turn.completed'"),
    ]);
  });

  // The one case an ignore rule cannot rescue: a modification to a TRACKED
  // file shows in `git status` no matter what `info/exclude` says, and the
  // agent would carry it onto the ticket's branch.
  it("refuses a hooks file the repository tracks, and leaves it byte-identical", async () => {
    const original = JSON.stringify({ version: 1, hooks: { stop: [{ command: "make lint" }] } });
    const { worktree } = repoWithWorktree((main) => {
      mkdirSync(join(main, ".cursor"), { recursive: true });
      writeFileSync(join(main, ".cursor/hooks.json"), original, "utf8");
    });

    const result = await run(worktree);

    expect(result.written).toEqual([]);
    expect(result.refused).toEqual([
      {
        harnessId: "cursor",
        path: ".cursor/hooks.json",
        reason: "git tracks this file — writing it would show up in the ticket's diff",
      },
    ]);
    expect(readFileSync(join(worktree, ".cursor/hooks.json"), "utf8")).toBe(original);
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("refuses an untracked file it cannot parse instead of replacing it", async () => {
    const { worktree } = repoWithWorktree();
    mkdirSync(join(worktree, ".cursor"), { recursive: true });
    writeFileSync(join(worktree, ".cursor/hooks.json"), '{ // mine\n "hooks": {} }', "utf8");

    const result = await run(worktree);

    expect(result.written).toEqual([]);
    expect(result.refused[0]?.reason).toContain("not valid JSON");
    expect(readFileSync(join(worktree, ".cursor/hooks.json"), "utf8")).toContain("// mine");
  });

  it("touches nothing at all for a harness with no workspace file", async () => {
    const { main, worktree } = repoWithWorktree();

    const result = await run(worktree, [adapterFor("claude-code"), adapterFor("codex")]);

    expect(result).toEqual({ written: [], refused: [] });
    // `git init` ships its own `info/exclude`; the claim is that Volli left no
    // block in it, not that the file is absent.
    expect(readFileSync(join(main, ".git/info/exclude"), "utf8")).not.toContain("volli");
  });
});

describe("excludeWithBlock", () => {
  it("says nothing changed when the block already reads that way", () => {
    const first = excludeWithBlock("", ["/.cursor/hooks.json"]);
    expect(first).not.toBeNull();
    expect(excludeWithBlock(first!, ["/.cursor/hooks.json"])).toBeNull();
  });

  it("keeps whatever the user had, and rewrites only its own block", () => {
    const mine = excludeWithBlock("*.local\n", ["/.cursor/hooks.json"])!;
    expect(mine.startsWith("*.local\n")).toBe(true);
    const updated = excludeWithBlock(mine, ["/.other/hooks.json"])!;
    expect(updated).toContain("*.local");
    expect(updated).toContain("/.other/hooks.json");
    expect(updated).not.toContain("/.cursor/hooks.json");
  });
});
