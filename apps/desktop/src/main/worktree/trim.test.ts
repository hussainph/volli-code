/**
 * Trim tests (VC-340) against REAL git repositories in temp dirs, because the
 * thing under test is git's own notion of "ignored" and a scripted runner would
 * only prove that our fake agrees with us. Three fixtures — Node, Rust, Python —
 * make the language-independence claim concrete: each must trim down to exactly
 * its tracked and untracked-unignored files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runGitCapturingAsync } from "./git";
import {
  DEFAULT_TRIM_KEEP_PATTERNS,
  countIgnoredArtifacts,
  keepReasonFor,
  trimIgnoredArtifacts,
} from "./trim";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

/** Writes a file, creating its parents — fixtures are described by path, not by mkdir. */
function write(root: string, relative: string, contents = "x"): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** A committed repository whose `.gitignore` holds `ignores`, plus the given files. */
function repoWith(options: {
  ignores: readonly string[];
  tracked: readonly string[];
  files?: readonly string[];
}): string {
  const root = mkdtempSync(join(tmpdir(), "volli-trim-"));
  temporaryRoots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  write(root, ".gitignore", `${options.ignores.join("\n")}\n`);
  for (const relative of options.tracked) write(root, relative, "tracked\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  for (const relative of options.files ?? []) write(root, relative, "artifact\n");
  return root;
}

/** Every path still on disk under `root`, relative and sorted (excluding `.git`). */
function survivors(root: string): string[] {
  const output = execFileSync(
    "find",
    [".", "-mindepth", "1", "-not", "-path", "./.git", "-not", "-path", "./.git/*"],
    { cwd: root, encoding: "utf8" },
  );
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, ""))
    .toSorted();
}

describe("keepReasonFor — the preserved-configuration allowlist", () => {
  it("keeps every default shape of local configuration, at any depth", () => {
    for (const relative of [
      ".env",
      ".env.local",
      ".env.production",
      "apps/desktop/.env",
      "vite.config.local",
      ".envrc",
      "certs/server.pem",
      "id_rsa.key",
    ]) {
      expect(keepReasonFor(relative, DEFAULT_TRIM_KEEP_PATTERNS)).not.toBeNull();
    }
  });

  it("names the pattern that spared a path, because a silent keep is a silent delete", () => {
    expect(keepReasonFor(".env.local", DEFAULT_TRIM_KEEP_PATTERNS)).toContain(".env.");
  });

  it("lets ordinary artifacts through", () => {
    for (const relative of ["node_modules/", "target", "dist/main.js", "__pycache__"]) {
      expect(keepReasonFor(relative, DEFAULT_TRIM_KEEP_PATTERNS)).toBeNull();
    }
  });

  it("protects git's own metadata whatever the user's allowlist says", () => {
    expect(keepReasonFor(".git", [])).toBe("it is git's own metadata");
    expect(keepReasonFor(".git/config", [])).not.toBeNull();
  });

  it("matches a slash-bearing pattern against the whole path, not the basename", () => {
    expect(
      keepReasonFor(".claude/settings.local.json", [".claude/settings.local.json"]),
    ).not.toBeNull();
    expect(keepReasonFor("other/settings.local.json", [".claude/settings.local.json"])).toBeNull();
  });
});

describe("trimIgnoredArtifacts — one worktree, any language", () => {
  it("trims a Node worktree to its tracked and untracked-unignored files", async () => {
    const root = repoWith({
      ignores: ["node_modules/", "dist/", "coverage/"],
      tracked: ["package.json", "src/index.ts"],
      files: [
        "node_modules/.pnpm/lodash@4/node_modules/lodash/index.js",
        "node_modules/.bin/vitest",
        "dist/bundle.js",
        "coverage/lcov.info",
        "scratch-notes.md",
      ],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed.map((entry) => entry.path).toSorted()).toEqual([
      "coverage/",
      "dist/",
      "node_modules/",
    ]);
    expect(result.value.totalBytes).toBeGreaterThan(0);
    // Tracked files, the ignore file itself, and the untracked-but-not-ignored
    // scratch file all survive — the last one is the work a trim must never take.
    expect(survivors(root)).toEqual([
      ".gitignore",
      "package.json",
      "scratch-notes.md",
      "src",
      "src/index.ts",
    ]);
  });

  it("trims a Rust worktree's target/ directory", async () => {
    const root = repoWith({
      ignores: ["/target", "*.rs.bk"],
      tracked: ["Cargo.toml", "src/main.rs"],
      files: ["target/debug/app", "target/debug/deps/app.d", "src/main.rs.bk"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed.map((entry) => entry.path).toSorted()).toEqual([
      "src/main.rs.bk",
      "target/",
    ]);
    expect(survivors(root)).toEqual([".gitignore", "Cargo.toml", "src", "src/main.rs"]);
  });

  it("trims a Python worktree's .venv and __pycache__", async () => {
    const root = repoWith({
      ignores: [".venv/", "__pycache__/", ".pytest_cache/"],
      tracked: ["pyproject.toml", "app/__init__.py"],
      files: [
        ".venv/bin/python",
        ".venv/lib/site-packages/click/__init__.py",
        "app/__pycache__/__init__.cpython-312.pyc",
        ".pytest_cache/CACHEDIR.TAG",
      ],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed.map((entry) => entry.path).toSorted()).toEqual([
      ".pytest_cache/",
      ".venv/",
      "app/__pycache__/",
    ]);
    expect(survivors(root)).toEqual([".gitignore", "app", "app/__init__.py", "pyproject.toml"]);
  });

  it("keeps an ignored .env and says so in the report", async () => {
    const root = repoWith({
      ignores: [".env", ".env.*", "node_modules/", "*.pem"],
      tracked: ["package.json"],
      files: [".env", ".env.production", "certs/local.pem", "node_modules/left-pad/index.js"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept.map((entry) => entry.path)).toEqual([
      ".env",
      ".env.production",
      "certs/local.pem",
    ]);
    expect(result.value.removed.map((entry) => entry.path)).toEqual(["node_modules/"]);
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, "certs/local.pem"))).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("spares preserved config inside a wholly-ignored directory git collapsed into one entry", async () => {
    // The regression this exists for: `git ls-files --directory` reports `certs/`
    // as ONE ignored entry, so a trim that answered the allowlist only against
    // what git enumerated deleted a directory of keys without ever testing a
    // `*.pem` against them.
    const root = repoWith({
      ignores: ["certs/", "build/"],
      tracked: ["package.json"],
      files: ["certs/server.pem", "certs/server.key", "build/app.js"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept.map((entry) => entry.path)).toEqual([
      "certs/server.key",
      "certs/server.pem",
    ]);
    expect(result.value.removed.map((entry) => entry.path)).toEqual(["build/"]);
    expect(existsSync(join(root, "certs/server.pem"))).toBe(true);
  });

  it("trims a dependency tree to a skeleton rather than taking a preserved file with it", async () => {
    // The documented cost of matching the allowlist at every depth: certifi's
    // `cacert.pem` inside a virtualenv survives, and the report says it did.
    const root = repoWith({
      ignores: [".venv/"],
      tracked: ["pyproject.toml"],
      files: [
        ".venv/bin/python",
        ".venv/lib/site-packages/certifi/cacert.pem",
        ".venv/lib/site-packages/certifi/core.py",
      ],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept.map((entry) => entry.path)).toEqual([
      ".venv/lib/site-packages/certifi/cacert.pem",
    ]);
    expect(result.value.removed.map((entry) => entry.path).toSorted()).toEqual([
      ".venv/bin/",
      ".venv/lib/site-packages/certifi/core.py",
    ]);
    expect(existsSync(join(root, ".venv/lib/site-packages/certifi/cacert.pem"))).toBe(true);
    expect(existsSync(join(root, ".venv/bin"))).toBe(false);
  });

  it("spares a named file inside an ignored directory and takes the rest of it", async () => {
    const root = repoWith({
      ignores: [".claude/"],
      tracked: ["package.json"],
      files: [".claude/settings.local.json", ".claude/cache/blob", ".claude/history.jsonl"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept.map((entry) => entry.path)).toEqual([".claude/settings.local.json"]);
    expect(result.value.removed.map((entry) => entry.path).toSorted()).toEqual([
      ".claude/cache/",
      ".claude/history.jsonl",
    ]);
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(true);
    expect(existsSync(join(root, ".claude/cache"))).toBe(false);
  });

  it("honours an extended allowlist", async () => {
    const root = repoWith({
      ignores: ["*.sqlite", "dist/"],
      tracked: ["package.json"],
      files: ["fixtures.sqlite", "dist/app.js"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, {
      worktreePath: root,
      keepPatterns: [...DEFAULT_TRIM_KEEP_PATTERNS, "*.sqlite"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept.map((entry) => entry.path)).toEqual(["fixtures.sqlite"]);
    expect(existsSync(join(root, "fixtures.sqlite"))).toBe(true);
  });

  it("keeps a symlink that leaves the worktree, and follows nothing through it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "volli-trim-outside-"));
    temporaryRoots.push(outside);
    writeFileSync(join(outside, "precious.txt"), "not ours\n");
    const root = repoWith({
      ignores: ["bazel-out", "dist/"],
      tracked: ["package.json"],
      files: ["dist/app.js"],
    });
    symlinkSync(outside, join(root, "bazel-out"));

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept).toEqual([
      { path: "bazel-out", reason: "it is a symlink out of the worktree" },
    ]);
    expect(result.value.removed.map((entry) => entry.path)).toEqual(["dist/"]);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(existsSync(join(root, "bazel-out"))).toBe(true);
  });

  it("measures without removing under dryRun", async () => {
    const root = repoWith({
      ignores: ["node_modules/"],
      tracked: ["package.json"],
      files: ["node_modules/left-pad/index.js"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, {
      worktreePath: root,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(result.value.removed.map((entry) => entry.path)).toEqual(["node_modules/"]);
    expect(result.value.totalBytes).toBeGreaterThan(0);
    expect(existsSync(join(root, "node_modules"))).toBe(true);
  });

  it("reports the biggest offender first", async () => {
    const root = repoWith({
      ignores: ["small/", "big/"],
      tracked: ["package.json"],
    });
    write(root, "small/a", "x");
    write(root, "big/a", "y".repeat(4096));

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed[0]?.path).toBe("big/");
    expect(result.value.removed[0]?.bytes).toBeGreaterThan(result.value.removed[1]?.bytes ?? 0);
    expect(result.value.totalBytes).toBe(
      result.value.removed.reduce((sum, entry) => sum + entry.bytes, 0),
    );
  });
});

describe("trimIgnoredArtifacts — refusals", () => {
  it("refuses a worktree with a live Session, naming the reason", async () => {
    const root = repoWith({
      ignores: ["node_modules/"],
      tracked: ["package.json"],
      files: ["node_modules/left-pad/index.js"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, {
      worktreePath: root,
      busySites: async () => [{ directory: join(root, "src"), surface: "agent" as const }],
    });

    expect(result).toEqual({
      ok: false,
      error: "An agent is still running in this worktree. Stop it first.",
    });
    expect(existsSync(join(root, "node_modules"))).toBe(true);
  });

  it("refuses a worktree with an open terminal in it", async () => {
    const root = repoWith({ ignores: ["dist/"], tracked: ["package.json"], files: ["dist/a.js"] });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, {
      worktreePath: root,
      busySites: async () => [{ directory: root, surface: "terminal" as const }],
    });

    expect(result).toEqual({
      ok: false,
      error: "A terminal is still running in this worktree. Close it first.",
    });
  });

  it("ignores a live site that is not inside this worktree", async () => {
    const root = repoWith({ ignores: ["dist/"], tracked: ["package.json"], files: ["dist/a.js"] });
    const elsewhere = mkdtempSync(join(tmpdir(), "volli-trim-elsewhere-"));
    temporaryRoots.push(elsewhere);

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, {
      worktreePath: root,
      busySites: async () => [{ directory: elsewhere, surface: "terminal" as const }],
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("refuses when a tracked file has uncommitted changes", async () => {
    const root = repoWith({
      ignores: ["node_modules/"],
      tracked: ["package.json"],
      files: ["node_modules/left-pad/index.js"],
    });
    writeFileSync(join(root, "package.json"), "edited\n");

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result).toEqual({
      ok: false,
      error: "This worktree has uncommitted changes to tracked files.",
    });
    expect(existsSync(join(root, "node_modules"))).toBe(true);
  });

  it("trims a worktree whose only change is an untracked, unignored file", async () => {
    const root = repoWith({
      ignores: ["node_modules/"],
      tracked: ["package.json"],
      files: ["node_modules/left-pad/index.js", "notes.md"],
    });

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "notes.md"))).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("refuses a folder that is not there", async () => {
    const result = await trimIgnoredArtifacts(runGitCapturingAsync, {
      worktreePath: join(tmpdir(), "volli-trim-missing-does-not-exist"),
    });

    expect(result).toEqual({ ok: false, error: "That worktree folder is missing." });
  });

  it("refuses a folder git cannot read", async () => {
    const root = mkdtempSync(join(tmpdir(), "volli-trim-nogit-"));
    temporaryRoots.push(root);

    const result = await trimIgnoredArtifacts(runGitCapturingAsync, { worktreePath: root });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("git status");
  });
});

describe("countIgnoredArtifacts — the cheap probe behind the Settings table", () => {
  it("counts what a trim would take, and nothing it would keep", async () => {
    const root = repoWith({
      ignores: [".env", "node_modules/", "dist/"],
      tracked: ["package.json"],
      files: [".env", "node_modules/a/index.js", "dist/app.js"],
    });

    const result = await countIgnoredArtifacts(runGitCapturingAsync, root);

    expect(result).toEqual({ ok: true, value: 2 });
  });

  it("reads zero for a worktree holding only preserved configuration", async () => {
    const root = repoWith({ ignores: [".env"], tracked: ["package.json"], files: [".env"] });

    expect(await countIgnoredArtifacts(runGitCapturingAsync, root)).toEqual({ ok: true, value: 0 });
  });

  it("surfaces a git failure instead of reporting an empty worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "volli-trim-nogit-probe-"));
    temporaryRoots.push(root);

    const result = await countIgnoredArtifacts(runGitCapturingAsync, root);

    expect(result.ok).toBe(false);
  });
});
