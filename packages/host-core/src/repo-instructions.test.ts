import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readRepoInstructions,
  readRepoInstructionsAtRef,
  readTicketRepoInstructions,
  type TicketWorkspaceFacts,
} from "./repo-instructions";
import { runGitCapturingAsync } from "./worktree/git";
import { resolveWorktreeIdentity } from "./worktree/identity";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./log/root", () => ({ hostLogger: () => ({ warn }) }));

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  warn.mockReset();
});
function workspace(files: Record<string, string> = {}): string {
  dir = mkdtempSync(join(tmpdir(), "volli-repo-instructions-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("readRepoInstructions", () => {
  it("reads AGENTS.md at the workspace root", async () => {
    const resource = await readRepoInstructions(
      workspace({ "AGENTS.md": "agents", "CLAUDE.md": "claude" }),
    );
    expect(resource).toEqual({
      name: "repository instructions",
      text: "From AGENTS.md at the workspace root, as it read when this Session started.\n\nagents",
    });
  });

  it("falls back to CLAUDE.md, including when AGENTS.md is a symlink to it", async () => {
    expect((await readRepoInstructions(workspace({ "CLAUDE.md": "claude" })))?.text).toContain(
      "From CLAUDE.md",
    );
    rmSync(dir, { recursive: true, force: true });
    const linked = workspace({ "CLAUDE.md": "shared rules" });
    symlinkSync(join(linked, "CLAUDE.md"), join(linked, "AGENTS.md"));
    const text = (await readRepoInstructions(linked))?.text ?? "";
    expect(text.match(/shared rules/g)).toHaveLength(1);
  });

  it("reads a CLAUDE.md symlinked to AGENTS.md once, as AGENTS.md, and a dangling one as missing", async () => {
    const linked = workspace({ "AGENTS.md": "shared rules" });
    symlinkSync("AGENTS.md", join(linked, "CLAUDE.md"));
    const text = (await readRepoInstructions(linked))?.text ?? "";
    expect(text).toContain("From AGENTS.md");
    expect(text.match(/shared rules/g)).toHaveLength(1);
    rmSync(join(linked, "AGENTS.md"));
    expect(await readRepoInstructions(linked)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is null, silently, when there is no instruction file or no workspace", async () => {
    expect(await readRepoInstructions(workspace())).toBeNull();
    expect(await readRepoInstructions(join(dir, "missing"))).toBeNull();
    expect(await readRepoInstructions(join(dir, "file-not-dir"))).toBeNull();
    writeFileSync(join(dir, "file-not-dir"), "");
    expect(await readRepoInstructions(join(dir, "file-not-dir"))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs an unreadable file and moves on to the next one", async () => {
    const root = workspace({ "CLAUDE.md": "claude" });
    mkdirSync(join(root, "AGENTS.md"));
    expect((await readRepoInstructions(root))?.text).toContain("From CLAUDE.md");
    expect(warn).toHaveBeenCalledWith(
      "repository instructions unreadable",
      expect.objectContaining({ path: join(root, "AGENTS.md") }),
    );
  });
});

// --- VC-1055: a Ticket Session records its own working copy's file ----------

/** A real repository with `main` committed, `dir` its main checkout. */
function repository(files: Record<string, string>): string {
  const root = workspace();
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, files, "init");
  return repo;
}
function git(cwd: string, ...args: string[]): string {
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
function commit(repo: string, files: Record<string, string>, message: string): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
}
/** A worktree ticket that has never had a worktree, based on `main`. */
function ticket(repo: string, overrides: Partial<TicketWorkspaceFacts> = {}): TicketWorkspaceFacts {
  return {
    checkoutPath: repo,
    projectId: "0123456789abcdef",
    home: join(dir, "home"),
    displayId: "VC-7",
    title: "Fix the thing",
    usesWorktree: true,
    worktreePath: null,
    branch: null,
    baseBranch: "main",
    projectBaseBranch: null,
    ...overrides,
  };
}
async function recorded(facts: TicketWorkspaceFacts): Promise<string | null> {
  return (await readTicketRepoInstructions(runGitCapturingAsync, facts))?.text ?? null;
}
const body = (text: string | null) => text?.split("\n\n").slice(1).join("\n\n") ?? null;

describe("readTicketRepoInstructions", () => {
  it("reads a fresh worktree ticket's base commit, not the main checkout's uncommitted edits", async () => {
    const repo = repository({ "AGENTS.md": "committed rules" });
    writeFileSync(join(repo, "AGENTS.md"), "uncommitted edit");
    expect(body(await recorded(ticket(repo)))).toBe("committed rules");
    // Deleting it in the main checkout does not delete it from the ticket's.
    rmSync(join(repo, "AGENTS.md"));
    expect(body(await recorded(ticket(repo)))).toBe("committed rules");
  });

  it("reads the ticket's base branch while the main checkout stands on another", async () => {
    const repo = repository({ "AGENTS.md": "main rules" });
    git(repo, "checkout", "-q", "-b", "release");
    commit(repo, { "AGENTS.md": "release rules" }, "release");
    git(repo, "checkout", "-q", "-b", "elsewhere");
    commit(repo, { "AGENTS.md": "elsewhere rules" }, "elsewhere");
    expect(body(await recorded(ticket(repo, { baseBranch: "release" })))).toBe("release rules");
    expect(body(await recorded(ticket(repo, { baseBranch: "main" })))).toBe("main rules");
    // No ticket base: the project's, as `ensure` resolves it.
    expect(
      body(await recorded(ticket(repo, { baseBranch: null, projectBaseBranch: "release" }))),
    ).toBe("release rules");
  });

  it("falls back to CLAUDE.md at the base, and to nothing when the base has neither", async () => {
    const repo = repository({ "CLAUDE.md": "claude rules" });
    expect(await recorded(ticket(repo))).toContain("From CLAUDE.md");
    git(repo, "checkout", "-q", "-b", "bare");
    git(repo, "rm", "-q", "CLAUDE.md");
    commit(repo, {}, "no instructions");
    writeFileSync(join(repo, "AGENTS.md"), "untracked in the main checkout only");
    expect(await recorded(ticket(repo, { baseBranch: "bare" }))).toBeNull();
  });

  it("reads the ticket's own branch when it exists and the worktree does not", async () => {
    const repo = repository({ "AGENTS.md": "main rules" });
    git(repo, "branch", "volli/VC-7-mine");
    git(repo, "checkout", "-q", "volli/VC-7-mine");
    commit(repo, { "AGENTS.md": "branch rules" }, "branch");
    git(repo, "checkout", "-q", "main");
    expect(body(await recorded(ticket(repo, { branch: "volli/VC-7-mine" })))).toBe("branch rules");
    // The derived branch name is the identity rule's, so an unstamped ticket
    // whose branch survived its worktree reads that branch too.
    const derived = resolveWorktreeIdentity({
      ...ticket(repo),
      persistedPath: null,
      persistedBranch: null,
      projectPath: repo,
    });
    git(repo, "branch", derived.branch, "volli/VC-7-mine");
    expect(body(await recorded(ticket(repo)))).toBe("branch rules");
  });

  it("reads an existing worktree off disk, its own edits included", async () => {
    const repo = repository({ "AGENTS.md": "main rules" });
    const worktree = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "volli/VC-7-x", worktree, "main");
    writeFileSync(join(worktree, "AGENTS.md"), "worktree edit");
    writeFileSync(join(repo, "AGENTS.md"), "main checkout edit");
    expect(
      body(await recorded(ticket(repo, { worktreePath: worktree, branch: "volli/VC-7-x" }))),
    ).toBe("worktree edit");
  });

  it("reads a no-worktree ticket from the main checkout, as it stands", async () => {
    const repo = repository({ "AGENTS.md": "committed rules" });
    writeFileSync(join(repo, "AGENTS.md"), "uncommitted edit");
    expect(body(await recorded(ticket(repo, { usesWorktree: false })))).toBe("uncommitted edit");
  });

  it("is null, logged, when the base cannot be read; null, silent, when none resolves", async () => {
    const repo = repository({ "AGENTS.md": "rules" });
    expect(await recorded(ticket(repo, { baseBranch: "no-such-branch" }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "repository instructions unreadable",
      expect.objectContaining({ ref: "no-such-branch" }),
    );
    warn.mockReset();
    const empty = join(dir, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    expect(await recorded(ticket(empty, { baseBranch: null }))).toBeNull();
  });
});

async function read(repo: string, ref = "main"): Promise<string | null> {
  return (await readRepoInstructionsAtRef(runGitCapturingAsync, repo, ref))?.text ?? null;
}

describe("readRepoInstructionsAtRef", () => {
  it("reads a CLAUDE.md symlinked to AGENTS.md once, as AGENTS.md", async () => {
    const repo = repository({ "AGENTS.md": "shared rules" });
    symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
    commit(repo, {}, "link");
    const text = await read(repo);
    expect(text).toContain("From AGENTS.md");
    expect(text?.match(/shared rules/g)).toHaveLength(1);
  });

  it("follows an in-tree symlink to its content, never injecting the link's target path", async () => {
    const repo = repository({ "docs/rules.md": "nested rules" });
    symlinkSync("docs/rules.md", join(repo, "CLAUDE.md"));
    symlinkSync("CLAUDE.md", join(repo, "AGENTS.md"));
    commit(repo, {}, "links");
    expect(body(await read(repo))).toBe("nested rules");
  });

  it("reads a symlink out of the tree, dangling, or looping as missing", async () => {
    const repo = repository({ "CLAUDE.md": "claude rules" });
    symlinkSync("../outside.md", join(repo, "AGENTS.md"));
    commit(repo, {}, "escape");
    expect(await read(repo)).toContain("From CLAUDE.md");
    rmSync(join(repo, "AGENTS.md"));
    symlinkSync("/etc/hosts", join(repo, "AGENTS.md"));
    commit(repo, {}, "absolute");
    expect(await read(repo)).toContain("From CLAUDE.md");
    rmSync(join(repo, "AGENTS.md"));
    rmSync(join(repo, "CLAUDE.md"));
    symlinkSync("CLAUDE.md", join(repo, "AGENTS.md"));
    symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
    commit(repo, {}, "loop");
    expect(await read(repo)).toBeNull();
    rmSync(join(repo, "AGENTS.md"));
    rmSync(join(repo, "CLAUDE.md"));
    symlinkSync("gone.md", join(repo, "AGENTS.md"));
    commit(repo, {}, "dangling");
    expect(await read(repo)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("caps the committed file like the disk one", async () => {
    const repo = repository({ "AGENTS.md": `${"x".repeat(100)}\n`.repeat(1000) });
    expect(await read(repo)).toContain("[Truncated: AGENTS.md is");
  });
});
